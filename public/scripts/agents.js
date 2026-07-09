// @ts-nocheck
import {
    chat,
    characters,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    name1,
    name2,
    saveChatConditional,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParamsExtended,
    this_chid,
    updateMessageBlock,
} from '../script.js';
import { extension_settings } from './extensions.js';
import { ConnectionManagerRequestService } from './extensions/shared.js';
import { selected_group } from './group-chats.js';
import { Popup } from './popup.js';
import { power_user } from './power-user.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
import { getTokenCountAsync } from './tokenizers.js';
import { getSortableDelay } from './utils.js';
import {
    PRE_AGENT_PROMPT_KEY,
    DEFAULT_AGENT_PRIORITY,
    DEFAULT_AGENT_MAX_TOKENS,
    DEFAULT_AGENT_RETRIES,
    ensureAgentsSettings,
    generateAgentId,
    normalizeAgent,
    getAgents,
    resequenceAgents,
    decodeHtmlEntities,
    extractInfoBoard,
} from './agents-core.js';

const POST_AGENTS_FINISHED_EVENT = 'rayas_agents_post_finished';

let activeGenerationState = null;
let isRunningPostAgents = false;
let agentAbortController = null;

function createDefaultAgent() {
    return normalizeAgent({
        id: generateAgentId(),
        name: '',
        enabled: true,
        description: '',
        phase: 'pre',
        connectionProfileId: '',
        prompt: '',
        pastMessageCount: 3,
        expanded: true,
        inputMode: {
            includeChat: true,
            includeCharacter: true,
            includePersona: true,
            includeWorldInfo: false,
            includeMainReply: false,
        },
        outputMode: {
            type: 'inject',
            role: 'system',
            storeKey: 'agent_result',
            structured: false,
        },
        conditions: {
            onlyGroupChats: false,
            onlyCharacterChats: false,
            skipSwipe: false,
            skipContinue: false,
            skipImpersonate: true,
            skipQuiet: false,
        },
        priority: DEFAULT_AGENT_PRIORITY,
        maxTokens: DEFAULT_AGENT_MAX_TOKENS,
        retries: DEFAULT_AGENT_RETRIES,
    });
}

function getEnabledAgentsByPhase(phase) {
    return getEnabledAgentsByPhases([phase]);
}

function getEnabledAgentsByPhases(phases) {
    const settings = ensureAgentsSettings();
    if (!settings.enabled) {
        return [];
    }

    const phaseSet = new Set((Array.isArray(phases) ? phases : [phases]).map(phase => String(phase ?? '')));

    return settings.agents
        .filter(agent => agent.enabled && phaseSet.has(String(agent.phase ?? '')))
        .sort((a, b) => Number(a.priority) - Number(b.priority));
}

function saveAgentsSettings() {
    ensureAgentsSettings();
    saveSettingsDebounced();
}

function upsertAgent(agent) {
    const settings = ensureAgentsSettings();
    const normalized = normalizeAgent(agent);
    const index = settings.agents.findIndex(existing => existing.id === normalized.id);

    if (index >= 0) {
        // Preserve the existing agent's priority so saving an edit does not
        // reshuffle the agent order (normalizeAgent would otherwise reset it
        // to the default priority, and the post-sort would be unstable).
        normalized.priority = Number(settings.agents[index].priority);
        settings.agents[index] = normalized;
    } else {
        settings.agents.push(normalized);
    }

    settings.agents.sort((a, b) => Number(a.priority) - Number(b.priority));
    resequenceAgents(settings.agents);
    saveAgentsSettings();
    renderAgentsList();
    return normalized;
}

function deleteAgent(agentId) {
    const settings = ensureAgentsSettings();
    settings.agents = settings.agents.filter(agent => agent.id !== agentId);
    resequenceAgents(settings.agents);
    saveAgentsSettings();
    renderAgentsList();
}

function updateAgentExpanded(agentId, expanded) {
    const settings = ensureAgentsSettings();
    const agent = settings.agents.find(entry => entry.id === agentId);
    if (!agent) {
        return;
    }

    agent.expanded = Boolean(expanded);
    saveAgentsSettings();
}

function getConnectionProfiles() {
    return (extension_settings.connectionManager?.profiles ?? [])
        .slice()
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

function populateConnectionProfileSelects() {
    const profiles = getConnectionProfiles();
    const select = $('#agents_editor_connection_profile');
    if (!select.length) {
        return;
    }

    const currentValue = String(select.val() ?? '');
    select.empty();
    select.append($('<option></option>').val('').text('Use selected connection profile'));

    for (const profile of profiles) {
        select.append($('<option></option>').val(profile.id).text(profile.name || profile.id));
    }

    select.val(currentValue);
}

function getResolvedProfileId(agent) {
    return String(agent?.connectionProfileId || extension_settings.connectionManager?.selectedProfile || '');
}

function getCurrentCharacter() {
    const chid = Number(this_chid);
    if (!Number.isInteger(chid) || chid < 0) {
        return null;
    }

    return characters[chid] ?? null;
}

function getLastAssistantMessageId() {
    return [...chat.keys()].reverse().find(index => chat[index] && !chat[index].is_user && !chat[index].is_system);
}

function getGenerationTypeLabel(type) {
    const normalized = String(type ?? 'normal');
    switch (normalized) {
        case 'swipe':
            return 'Swipe';
        case 'continue':
            return 'Continue';
        case 'impersonate':
            return 'Impersonate';
        case 'append':
            return 'Append';
        case 'appendFinal':
            return 'Append Final';
        case 'manual':
            return 'Manual';
        default:
            return 'Normal';
    }
}

function getPhaseLabel(phase) {
    switch (String(phase ?? '')) {
        case 'pre':
            return 'Pre';
        case 'post':
            return 'Post';
        case 'manual':
            return 'Manual';
        default:
            return String(phase ?? '');
    }
}

function getOutputLabel(agent) {
    switch (String(agent?.outputMode?.type ?? '')) {
        case 'inject':
            return `Inject · ${String(agent?.outputMode?.role ?? 'system')}`;
        case 'rewrite':
            return 'Rewrite';
        case 'append':
            return 'Append';
        case 'metadata':
            return `Metadata · ${String(agent?.outputMode?.storeKey || 'agent_result')}`;
        case 'patch':
            return 'Patch';
        default:
            return 'Output';
    }
}

function getInputModeSummary(agent) {
    const parts = [];
    if (agent.inputMode.includeChat) parts.push(`Chat ${Number(agent.pastMessageCount)}`);
    if (agent.inputMode.includeCharacter) parts.push('Character');
    if (agent.inputMode.includePersona) parts.push('Persona');
    if (agent.inputMode.includeWorldInfo) parts.push('World Info');
    if (agent.inputMode.includeMainReply) parts.push('Main Reply');
    return parts.length ? parts.join(' · ') : 'No extra context';
}

function getConditionBadges(agent) {
    const badges = [];
    if (agent.conditions.onlyGroupChats) badges.push('Groups only');
    if (agent.conditions.onlyCharacterChats) badges.push('1:1 only');
    if (agent.conditions.skipSwipe) badges.push('Skip swipes');
    if (agent.conditions.skipContinue) badges.push('Skip continue');
    if (agent.conditions.skipImpersonate) badges.push('Skip impersonate');
    if (agent.conditions.skipQuiet) badges.push('Skip quiet');
    return badges;
}

function shouldRunAgent(agent, generationType = 'normal', source = 'manual') {
    const conditions = agent?.conditions ?? {};
    const normalizedType = String(generationType ?? 'normal');

    if (conditions.onlyGroupChats && !selected_group) {
        return false;
    }

    if (conditions.onlyCharacterChats && selected_group) {
        return false;
    }

    if (conditions.skipSwipe && normalizedType === 'swipe') {
        return false;
    }

    if (conditions.skipContinue && normalizedType === 'continue') {
        return false;
    }

    if (conditions.skipImpersonate && normalizedType === 'impersonate') {
        return false;
    }

    if (conditions.skipQuiet && source === 'draft') {
        return false;
    }

    return true;
}

function stripTrackerBlocks(text) {
    let cleaned = String(text ?? '');
    const fenceTypes = 'disp|sim|json';

    cleaned = cleaned.replace(new RegExp(`<div\\s+style\\s*=\\s*["']display\\s*:\\s*none;?\\s*["']\\s*>[\\s\\S]*?\`\`\`(?:${fenceTypes})[\\s\\S]*?\`\`\`[\\s\\S]*?<\\/div>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`\`\`\`(?:${fenceTypes})[\\s\\S]*?\`\`\``, 'gi'), '');
    cleaned = cleaned.replace(/<div\s+style\s*=\s*["']display\s*:\s*none;?\s*["']\s*>[\s\S]*?<\/div>/gi, '');

    return cleaned.trim();
}

function buildPastContextXml(message, pastMessageCount, messageId = null) {
    const currentIndex = Number.isInteger(Number(messageId))
        ? Number(messageId)
        : Number(chat.indexOf(message));
    if (!Number.isInteger(currentIndex) || currentIndex < 0) {
        return '';
    }

    const messages = [];
    for (let index = currentIndex - 1; index >= 0 && messages.length < pastMessageCount; index--) {
        const entry = chat[index];
        if (!entry || entry.is_system || entry.extra?.ignore) {
            continue;
        }

        messages.push({ index, entry });
    }

    messages.reverse();

    return messages.map(({ index, entry }) => {
        const speaker = entry.name || (entry.is_user ? name1 : name2);
        return `<message index="${index}" speaker="${escapeHtmlAttr(speaker)}">\n${extractInfoBoard(stripTrackerBlocks(entry.mes)).body}\n</message>`;
    }).join('\n\n');
}

function getFallbackAssistantText(message, revisionContext = null) {
    const revisionMessage = String(revisionContext?.currentMessage ?? '').trim();
    if (revisionMessage) {
        return extractInfoBoard(revisionMessage).body;
    }

    const messageText = String(message?.mes ?? '').trim();
    if (messageText) {
        return extractInfoBoard(messageText).body;
    }

    const reasoningText = stripTrackerBlocks(String(message?.extra?.reasoning ?? '')).trim();
    if (reasoningText) {
        return reasoningText;
    }

    return '';
}

function createRevisionContext(message, messageId = null) {
    const originalMessage = getFallbackAssistantText(message);
    return {
        messageId: Number.isInteger(Number(messageId)) ? Number(messageId) : Number(chat.indexOf(message)),
        originalMessage,
        currentMessage: originalMessage,
        passes: [],
        forbiddenAddBack: [],
        notesForNextPass: [],
    };
}

function uniqueStringList(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => String(value ?? '').trim())
        .filter(Boolean))];
}

function escapeXmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildTargetMessageXml(messageText, revisionContext) {
    const hasPriorPasses = Boolean(revisionContext?.passes?.length);
    const label = hasPriorPasses ? 'revised_message' : 'current_message';
    const intro = hasPriorPasses
        ? 'This is the current target text after previous revision passes. Apply this pass to this version only.'
        : '';
    const body = [intro, String(messageText ?? '').trim()].filter(Boolean).join('\n\n');

    return body ? `<${label}>\n${escapeXmlText(body)}\n</${label}>` : '';
}

function buildRevisionHistoryXml(revisionContext) {
    if (!revisionContext || !Array.isArray(revisionContext.passes) || !revisionContext.passes.length) {
        return '';
    }

    const passXml = revisionContext.passes.map((pass, index) => {
        const blockedXml = uniqueStringList(pass.blockedReintroductions).map(item => `\n        <blocked>${escapeXmlText(item)}</blocked>`).join('');
        const notesXml = uniqueStringList(pass.notesForFuturePasses).map(item => `\n        <note>${escapeXmlText(item)}</note>`).join('');
        const appliedPatches = Array.isArray(pass.appliedPatches) ? pass.appliedPatches : [];
        const skippedPatches = Array.isArray(pass.skippedPatches) ? pass.skippedPatches : [];
        const patchesXml = appliedPatches.length
            ? '\n        <patches>' + appliedPatches.map(p => `\n            <hunk find="${escapeHtmlAttr(p.find)}" replace="${escapeHtmlAttr(p.replace)}" />`).join('') + '\n        </patches>'
            : '';
        const skippedXml = skippedPatches.length
            ? '\n        <skipped>' + skippedPatches.map(p => `\n            <hunk reason="${escapeHtmlAttr(p.reason || 'not found')}" find="${escapeHtmlAttr(p.find)}" />`).join('') + '\n        </skipped>'
            : '';
        return `<pass index="${index + 1}" agent="${escapeHtmlAttr(pass.agentName || 'Agent')}">\n    <changed>${pass.changed ? 'true' : 'false'}</changed>\n    <summary>${escapeXmlText(pass.summary || 'No summary')}</summary>${blockedXml}${notesXml}${patchesXml}${skippedXml}\n</pass>`;
    }).join('\n');

    const forbiddenXml = uniqueStringList(revisionContext.forbiddenAddBack).map(item => `\n    <phrase>${escapeXmlText(item)}</phrase>`).join('');
    const notesXml = uniqueStringList(revisionContext.notesForNextPass).map(item => `\n    <note>${escapeXmlText(item)}</note>`).join('');

    return `<revision_history>\n<previous_passes>\n${passXml}\n</previous_passes>\n<do_not_reintroduce>${forbiddenXml}\n</do_not_reintroduce>\n<notes_for_next_pass>${notesXml}\n</notes_for_next_pass>\n</revision_history>`;
}

function buildAgentContext(agent, { message = null, messageId = null, generationType = '', source = '', revisionContext = null } = {}) {
    const character = getCurrentCharacter();
    const personaDescription = typeof power_user !== 'undefined' ? String(power_user.persona_description ?? '') : '';
    const worldInfoText = agent.inputMode.includeWorldInfo
        ? String(chat_metadata?.world_info ?? '')
        : '';
    const messageText = stripTrackerBlocks(getFallbackAssistantText(message, revisionContext));
    const mainReply = agent.inputMode.includeMainReply ? messageText : '';
    const contextMessageId = Number.isInteger(Number(revisionContext?.messageId))
        ? Number(revisionContext.messageId)
        : Number.isInteger(Number(messageId))
            ? Number(messageId)
            : Number(chat.indexOf(message));
    const chatXml = agent.inputMode.includeChat ? buildPastContextXml(message, Number(agent.pastMessageCount ?? 0), contextMessageId) : '';
    const currentMessageXml = buildTargetMessageXml(mainReply, revisionContext);
    const revisionHistoryXml = buildRevisionHistoryXml(revisionContext);

    return {
        agentName: agent.name,
        agentDescription: agent.description,
        generationType: String(generationType ?? ''),
        source: String(source ?? ''),
        chat: chatXml,
        pastContext: chatXml,
        currentMessage: mainReply,
        currentMessageXml,
        response: mainReply,
        original: revisionContext ? String(revisionContext.originalMessage ?? mainReply) : mainReply,
        mainReply,
        revisionHistory: revisionHistoryXml,
        forbiddenAddBack: uniqueStringList(revisionContext?.forbiddenAddBack).join('\n'),
        revisionNotes: uniqueStringList(revisionContext?.notesForNextPass).join('\n'),
        patchInstruction: agent.outputMode.type === 'patch'
            ? 'OUTPUT MODE: PATCH. Do NOT rewrite the whole message. Output a JSON object with a "patches" array. Each patch is { "find": "<exact substring copied verbatim from the message above>", "replace": "<the edited version of just that substring>" }. Only include substrings you are intentionally changing. Untouched text is preserved automatically — never repeat it. Match "find" exactly (including spacing) or the patch will be skipped. Keep "find" as small as possible while still being unique.'
            : '',
        characterName: character?.name ?? '',
        characterDescription: agent.inputMode.includeCharacter ? String(character?.description ?? '') : '',
        characterPersonality: agent.inputMode.includeCharacter ? String(character?.personality ?? '') : '',
        scenario: agent.inputMode.includeCharacter ? String(character?.scenario ?? '') : '',
        persona: agent.inputMode.includePersona ? personaDescription : '',
        worldInfo: worldInfoText,
    };
}

async function buildAgentPrompt(agent, context) {
    const basePrompt = substituteParamsExtended(agent.prompt, context);
    const sections = [];

    if (context.characterDescription) {
        sections.push(`Character Description:\n${context.characterDescription}`);
    }

    if (context.characterPersonality) {
        sections.push(`Character Personality:\n${context.characterPersonality}`);
    }

    if (context.scenario) {
        sections.push(`Scenario:\n${context.scenario}`);
    }

    if (context.persona) {
        sections.push(`Persona:\n${context.persona}`);
    }

    if (context.worldInfo) {
        sections.push(`World Info:\n${context.worldInfo}`);
    }

    if (context.chat) {
        sections.push(`<past_context>\n${context.chat}\n</past_context>`);
    }

    if (context.mainReply) {
        sections.push(context.currentMessageXml || `<current_message>\n${context.mainReply}\n</current_message>`);
    }

    if (context.revisionHistory) {
        sections.push(`Previous Revision Passes:\n${context.revisionHistory}`);
    }

    if (context.patchInstruction) {
        sections.push(context.patchInstruction);
    }

    return [basePrompt, ...sections.filter(Boolean)].filter(Boolean).join('\n\n');
}

async function runAgentCompletion(agent, context, signal = null) {
    const profileId = getResolvedProfileId(agent);
    if (!profileId) {
        throw new Error(`No connection profile selected for agent "${agent.name || 'Unnamed Agent'}"`);
    }

    const prompt = await buildAgentPrompt(agent, context);
    if (!prompt.trim()) {
        return '';
    }

    const maxTokens = Number(agent.maxTokens) > 0 ? Number(agent.maxTokens) : null;
    const response = await ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens, {
        stream: false,
        extractData: true,
        signal,
    });

    if (typeof response === 'string') {
        return response.trim();
    }

    if (response && typeof response === 'object') {
        const direct = response.content ?? response.message ?? response.text ?? response.output ?? response?.choices?.[0]?.message?.content;
        return String(direct ?? '').trim();
    }

    return '';
}

async function runAgentCompletionWithRetries(agent, context, { validateStructured = false, validateMinTokens = false, sourceLabel = 'agent', signal = null } = {}) {
    const retries = Math.max(0, Number(agent?.retries ?? DEFAULT_AGENT_RETRIES) || 0);
    const maxAttempts = retries + 1;
    let lastError = null;
    const minTokens = Math.max(0, Number(ensureAgentsSettings().minMessageTokens ?? 0));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
            throw new DOMException('Agent pipeline was cancelled', 'AbortError');
        }

        try {
            const result = await runAgentCompletion(agent, context, signal);
            const structured = validateStructured && agent?.outputMode?.structured ? parseStructuredAgentResult(result) : null;

            if (validateStructured && agent?.outputMode?.structured && !structured) {
                throw new Error(`Agent "${agent.name || 'Unnamed Agent'}" produced invalid or incomplete structured output.`);
            }

            // Patch mode: require at least one usable find/replace hunk.
            if (validateStructured && agent?.outputMode?.type === 'patch' && (!structured || structured.mode !== 'patch' || !structured.patches.length)) {
                throw new Error(`Agent "${agent.name || 'Unnamed Agent'}" produced no valid patches (expected a "patches" array of {find, replace}).`);
            }

            if (validateMinTokens && minTokens > 0) {
                const tokenCandidate = structured && (['rewrite', 'append'].includes(agent?.outputMode?.type))
                    ? String(structured.revised_message ?? '')
                    : structured && agent?.outputMode?.type === 'patch'
                        ? structured.patches.map(p => String(p.replace ?? '')).join('\n')
                        : String(result ?? '');
                const tokenText = extractInfoBoard(decodeHtmlEntities(tokenCandidate)).body.trim();
                const tokenCount = await getTokenCountAsync(tokenText, 0);

                if (tokenCount < minTokens) {
                    throw new Error(`Agent "${agent.name || 'Unnamed Agent'}" returned only ${tokenCount} tokens, below the minimum of ${minTokens}.`);
                }
            }

            return result;
        } catch (error) {
            if (signal?.aborted) {
                throw new DOMException('Agent pipeline was cancelled', 'AbortError');
            }

            lastError = error instanceof Error ? error : new Error(String(error ?? 'Unknown agent failure'));

            if (attempt >= maxAttempts) {
                throw lastError;
            }

            console.warn(`[Agents] ${sourceLabel} failed for "${agent?.name || 'Unnamed Agent'}" on attempt ${attempt}/${maxAttempts}. Retrying...`, lastError);
            toastr.warning(`Attempt ${attempt}/${maxAttempts} failed for "${agent?.name || 'Unnamed Agent'}". Retrying...\n${lastError.message}`, 'Agents');
        }
    }

    throw lastError || new Error(`Failed to run agent "${agent?.name || 'Unnamed Agent'}"`);
}

async function getAgentGateInfo(message, revisionContext = null) {
    const minTokens = Math.max(0, Number(ensureAgentsSettings().minMessageTokens ?? 0));
    const assistantText = getFallbackAssistantText(message, revisionContext);
    if (!assistantText) {
        return { shouldSkip: true, reason: 'empty', minTokens, tokenCount: 0, assistantText };
    }

    if (minTokens <= 0) {
        return { shouldSkip: false, reason: '', minTokens, tokenCount: 0, assistantText };
    }

    const tokenCount = await getTokenCountAsync(assistantText, 0);
    if (tokenCount < minTokens) {
        return { shouldSkip: true, reason: 'below_threshold', minTokens, tokenCount, assistantText };
    }

    return { shouldSkip: false, reason: '', minTokens, tokenCount, assistantText };
}

async function runPreAgents(generationType = 'normal') {
    clearPreAgentInjection();

    agentAbortController = new AbortController();
    const signal = agentAbortController.signal;

    const agents = getEnabledAgentsByPhase('pre')
        .filter(agent => agent.outputMode.type === 'inject')
        .filter(agent => shouldRunAgent(agent, generationType, 'pre'));
    if (!agents.length) {
        agentAbortController = null;
        return;
    }

    const parts = [];
    for (const agent of agents) {
        if (signal.aborted) {
            break;
        }

        try {
            const context = buildAgentContext(agent, { generationType, source: 'pre' });
            const result = await runAgentCompletionWithRetries(agent, context, {
                validateStructured: false,
                validateMinTokens: true,
                sourceLabel: 'Pre agent',
                signal,
            });
            if (!result) {
                continue;
            }

            parts.push(`### ${agent.name || 'Agent'}\n${result}`);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                break;
            }
            console.error('[Agents] Pre agent failed', agent, error);
            toastr.error(String(error?.message || error || 'Failed to run pre agent'), 'Agents');
        }
    }

    agentAbortController = null;

    if (!parts.length) {
        return;
    }

    setExtensionPrompt(
        PRE_AGENT_PROMPT_KEY,
        parts.join('\n\n'),
        0,
        0,
        true,
        extension_prompt_roles.SYSTEM,
    );
}

function clearPreAgentInjection() {
    setExtensionPrompt(PRE_AGENT_PROMPT_KEY, '', 0, 0, true, extension_prompt_roles.SYSTEM);
}

async function applyPostAgentResult(agent, messageId, result, { updateDom = true } = {}) {
    const message = chat[messageId];
    const structured = agent.outputMode.structured ? parseStructuredAgentResult(result) : null;

    if (agent.outputMode.structured && !structured) {
        console.warn(`[Agents] Agent "${agent.name || 'Unnamed Agent'}" produced invalid or incomplete structured output. Preserving previous text.`);
        return {
            changed: false,
            outputMessage: String(message?.mes ?? ''),
            metadata: null,
            parseFailed: true,
        };
    }

    const effectiveResult = decodeHtmlEntities(
        structured && ['rewrite', 'append'].includes(agent.outputMode.type)
            ? String(structured.revised_message ?? '')
            : String(result ?? ''),
    );

    if (!message) {
        return { changed: false, outputMessage: '', metadata: structured, parseFailed: false };
    }

    message.extra = message.extra || {};
    message.extra.rayasAgents = message.extra.rayasAgents || {};

    const { infoBoard, body } = extractInfoBoard(String(message.mes ?? ''));
    const cleanResult = extractInfoBoard(effectiveResult).body;

    switch (agent.outputMode.type) {
        case 'rewrite': {
            const rewritten = cleanResult.trim();
            if (!rewritten || rewritten === body) {
                return { changed: false, outputMessage: String(message.mes ?? ''), metadata: structured, parseFailed: false };
            }

            const newMes = infoBoard ? `${infoBoard}\n\n${rewritten}` : rewritten;
            message.mes = newMes;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
                const swipeIndex = Number(message.swipe_id);
                if (swipeIndex >= 0 && swipeIndex < message.swipes.length) {
                    message.swipes[swipeIndex] = newMes;
                }
            }

            if (updateDom && document.querySelector(`#chat [mesid="${messageId}"]`)) {
                updateMessageBlock(messageId, message, { rerenderMessage: true });
            }
            return { changed: true, outputMessage: newMes, metadata: structured, parseFailed: false };
        }
        case 'append': {
            const appendText = cleanResult.trim();
            const appended = `${String(message.mes ?? '')}${String(message.mes ? '\n\n' : '')}${appendText}`;
            if (!appendText || appended === String(message.mes ?? '')) {
                return { changed: false, outputMessage: String(message.mes ?? ''), metadata: structured, parseFailed: false };
            }

            message.mes = appended;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
                const swipeIndex = Number(message.swipe_id);
                if (swipeIndex >= 0 && swipeIndex < message.swipes.length) {
                    message.swipes[swipeIndex] = appended;
                }
            }

            if (updateDom && document.querySelector(`#chat [mesid="${messageId}"]`)) {
                updateMessageBlock(messageId, message, { rerenderMessage: true });
            }
            return { changed: true, outputMessage: appended, metadata: structured, parseFailed: false };
        }
        case 'patch': {
            const patches = Array.isArray(structured?.patches) ? structured.patches : [];
            if (!patches.length) {
                return { changed: false, outputMessage: String(message.mes ?? ''), metadata: structured, parseFailed: false, appliedPatches: [], skippedPatches: [] };
            }

            // Work on the decoded representation so `find` strings (which the model
            // sees decoded) match what's actually in the message. Mirrors how
            // `rewrite` mode stores decoded text back into message.mes.
            let working = decodeHtmlEntities(String(message.mes ?? ''));
            const appliedPatches = [];
            const skippedPatches = [];

            for (const patch of patches) {
                const find = String(patch.find ?? '');
                const replace = String(patch.replace ?? '');
                if (!find) {
                    skippedPatches.push({ find, replace, reason: 'empty find' });
                    continue;
                }
                const idx = working.indexOf(find);
                if (idx === -1) {
                    console.warn(`[Agents] Patch hunk skipped (find not found) in agent "${agent.name || 'Unnamed Agent'}":`, find.slice(0, 80));
                    skippedPatches.push({ find, replace, reason: 'not found' });
                    continue;
                }
                // First occurrence only — predictable, no accidental mass edits.
                working = working.slice(0, idx) + replace + working.slice(idx + find.length);
                appliedPatches.push({ find, replace });
            }

            if (!appliedPatches.length) {
                return { changed: false, outputMessage: String(message.mes ?? ''), metadata: structured, parseFailed: false, appliedPatches, skippedPatches };
            }

            const newMes = working;
            message.mes = newMes;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
                const swipeIndex = Number(message.swipe_id);
                if (swipeIndex >= 0 && swipeIndex < message.swipes.length) {
                    message.swipes[swipeIndex] = newMes;
                }
            }

            if (updateDom && document.querySelector(`#chat [mesid="${messageId}"]`)) {
                updateMessageBlock(messageId, message, { rerenderMessage: true });
            }
            return { changed: true, outputMessage: newMes, metadata: structured, parseFailed: false, appliedPatches, skippedPatches };
        }
        case 'metadata': {
            message.extra.rayasAgents[agent.outputMode.storeKey || 'agent_result'] = effectiveResult;
            return { changed: true, outputMessage: String(message.mes ?? ''), metadata: structured, parseFailed: false };
        }
        default:
            return { changed: false, outputMessage: String(message.mes ?? ''), metadata: structured, parseFailed: false };
    }
}

function dispatchFinalAssistantMessageEvent(messageId) {
    document.dispatchEvent(new CustomEvent('recast:final-assistant-message', {
        detail: {
            mesId: Number(messageId),
        },
    }));
}

async function emitPostAgentsFinished(messageId, generationType, source, changed) {
    const detail = {
        messageId: Number(messageId),
        generationType: String(generationType ?? 'normal'),
        source: String(source ?? 'post'),
        changed: Boolean(changed),
    };

    try {
        await eventSource.emit(POST_AGENTS_FINISHED_EVENT, detail);
    } catch (error) {
        console.warn('[Agents] Failed to emit post-agents-finished event', error);
    }

    try {
        document.dispatchEvent(new CustomEvent(POST_AGENTS_FINISHED_EVENT, { detail }));
    } catch (error) {
        console.warn('[Agents] Failed to dispatch DOM post-agents-finished event', error);
    }
}

async function runPostAgentsForMessage(messageId, generationType = 'normal', source = 'post', options = {}) {
    const updateDom = options.updateDom !== false;
    const emitLateEvents = options.emitLateEvents !== false;
    const forcedAgentId = typeof options.agentId === 'string' && options.agentId.trim() ? options.agentId.trim() : '';

    if (isRunningPostAgents) {
        return false;
    }

    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const phases = source === 'manual' ? ['post', 'manual'] : ['post'];
    let agents = getEnabledAgentsByPhases(phases);
    if (forcedAgentId) {
        agents = agents.filter(agent => agent.id === forcedAgentId);
    }
    agents = agents.filter(agent => shouldRunAgent(agent, generationType, source));

    if (!agents.length) {
        return false;
    }

    const revisionContext = createRevisionContext(message, messageId);
    const gateInfo = await getAgentGateInfo(message, revisionContext);
    if (gateInfo.shouldSkip) {
        if (source === 'manual') {
            if (gateInfo.reason === 'below_threshold') {
                toastr.info(`Skipped agents: assistant reply is only ${gateInfo.tokenCount} tokens, below the global minimum of ${gateInfo.minTokens}.`, 'Agents');
            } else {
                toastr.info('Skipped agents: no assistant reply text was available for this message.', 'Agents');
            }
        }
        return false;
    }

    const shouldToastProgress = (source === 'draft' || source === 'manual') && agents.length > 0;
    let progressToast = null;

    agentAbortController = new AbortController();
    const signal = agentAbortController.signal;

    isRunningPostAgents = true;
    let messageChanged = false;
    let compatibilityEventNeeded = false;
    let successfulPasses = 0;

    try {
        for (let index = 0; index < agents.length; index++) {
            if (signal.aborted) {
                break;
            }

            const agent = agents[index];

            try {
                if (shouldToastProgress) {
                    if (progressToast) {
                        toastr.clear(progressToast);
                    }
                    const progressMessage = index === 0
                        ? `Message has been passed to agent "${agent.name || 'Unnamed Agent'}", please wait...`
                        : `Agent ${index}/${agents.length} finished. Passing message to "${agent.name || 'Unnamed Agent'}"...`;
                    progressToast = showPostAgentProgressToast(progressMessage, 'Agents');
                }

                const inputMessage = getFallbackAssistantText(message, revisionContext);
                const context = buildAgentContext(agent, { message, messageId, generationType, source, revisionContext });
                const result = await runAgentCompletionWithRetries(agent, context, {
                    validateStructured: Boolean(agent.outputMode?.structured),
                    validateMinTokens: true,
                    sourceLabel: 'Post agent',
                    signal,
                });
                const applyResult = await applyPostAgentResult(agent, messageId, result, { updateDom });
                const changed = Boolean(applyResult.changed);
                const parseFailed = Boolean(applyResult.parseFailed);

                if (parseFailed) {
                    toastr.warning(`Agent "${agent.name || 'Unnamed Agent'}" produced invalid structured output. Preserving text from previous successful agent.`, 'Agents');
                } else {
                    successfulPasses++;
                }

                updateRevisionContext(revisionContext, agent, inputMessage, applyResult.outputMessage, result, changed, {
                    parseFailed,
                    appliedPatches: applyResult.appliedPatches || [],
                    skippedPatches: applyResult.skippedPatches || [],
                });
                messageChanged = messageChanged || changed;

                if (agent.outputMode.type === 'rewrite' && changed) {
                    compatibilityEventNeeded = true;
                }

                if (agent.outputMode.type === 'append' && changed) {
                    compatibilityEventNeeded = true;
                }
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    break;
                }
                console.error('[Agents] Post agent failed', agent, error);
                toastr.error(String(error?.message || error || 'Failed to run post agent'), 'Agents');
            }
        }

        if (signal.aborted) {
            if (progressToast) {
                toastr.clear(progressToast);
            }
            toastr.warning('Agent processing was cancelled.', 'Agents');
        }

        if (progressToast) {
            toastr.clear(progressToast);
        }

        if (messageChanged && emitLateEvents) {
            await saveChatConditional();
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
            if (compatibilityEventNeeded) {
                dispatchFinalAssistantMessageEvent(messageId);
            }
        }

        await emitPostAgentsFinished(messageId, generationType, source, messageChanged);

        if (shouldToastProgress && !signal.aborted) {
            toastr[messageChanged ? 'success' : 'info'](
                messageChanged
                    ? `Post-processing complete. Final reply revised by ${successfulPasses} agent${successfulPasses === 1 ? '' : 's'}.`
                    : 'Post-processing complete. No agent changes were needed.',
                'Agents',
            );
        }

        return messageChanged;
    } finally {
        if (progressToast) {
            toastr.clear(progressToast);
        }
        isRunningPostAgents = false;
        agentAbortController = null;
    }
}

export async function runPostAgentsForDraft(messageId, generationType = 'normal') {
    console.log('[Agents] runPostAgentsForDraft called', { messageId, generationType, enabled: ensureAgentsSettings().enabled, agentCount: getAgents().length, postAgents: getEnabledAgentsByPhase('post').length });
    return await runPostAgentsForMessage(messageId, generationType, 'draft', {
        updateDom: false,
        emitLateEvents: false,
    });
}

async function runSingleAgentAgainstLatestMessage(agentId) {
    const agent = getAgents().find(entry => entry.id === agentId);
    if (!agent) {
        toastr.warning('Agent not found.', 'Agents');
        return;
    }

    const lastAssistantMessageId = getLastAssistantMessageId();
    const hasAssistantMessage = Number.isInteger(lastAssistantMessageId);

    if (agent.outputMode.type === 'inject') {
        try {
            const message = hasAssistantMessage ? chat[lastAssistantMessageId] : null;
            const gateInfo = message && agent.inputMode.includeMainReply
                ? await getAgentGateInfo(message)
                : { shouldSkip: false };
            if (gateInfo.shouldSkip) {
                if (gateInfo.reason === 'below_threshold') {
                    toastr.info(`Skipped agent test: assistant reply is only ${gateInfo.tokenCount} tokens, below the global minimum of ${gateInfo.minTokens}.`, 'Agents');
                } else {
                    toastr.info('Skipped agent test: no assistant reply text was available for this message.', 'Agents');
                }
                return;
            }
            const context = buildAgentContext(agent, { message, messageId: lastAssistantMessageId, generationType: 'manual', source: 'manual' });
            const result = await runAgentCompletionWithRetries(agent, context, {
                validateStructured: false,
                validateMinTokens: true,
                sourceLabel: 'Agent test',
            });
            toastr.success(result ? 'Agent test completed.' : 'Agent returned no text.', 'Agents');
        } catch (error) {
            console.error('[Agents] Agent test failed', error);
            toastr.error(String(error?.message || error || 'Agent test failed'), 'Agents');
        }
        return;
    }

    if (!hasAssistantMessage) {
        toastr.warning('No assistant message available for this agent.', 'Agents');
        return;
    }

    const changed = await runPostAgentsForMessage(lastAssistantMessageId, 'manual', 'manual', {
        updateDom: true,
        emitLateEvents: true,
        agentId,
    });

    toastr[changed ? 'success' : 'info'](changed ? 'Agent test applied to latest assistant message.' : 'Agent test ran but made no changes.', 'Agents');
}

async function runManualAgent(agentId) {
    return await runSingleAgentAgainstLatestMessage(agentId);
}

async function runEnabledAgentsCommand(_args, value) {
    const rawValue = String(value ?? '').trim();
    const messageId = rawValue.length ? Number(rawValue) : getLastAssistantMessageId();

    if (!Number.isInteger(messageId) || messageId < 0 || !chat[messageId]) {
        throw new Error('No valid message id provided and no latest assistant message is available.');
    }

    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) {
        throw new Error('Target message must be an assistant message.');
    }

    const changed = await runPostAgentsForMessage(messageId, 'manual', 'manual', {
        updateDom: true,
        emitLateEvents: true,
    });

    return changed
        ? `Ran enabled agents on assistant message ${messageId}. Changes applied.`
        : `Ran enabled agents on assistant message ${messageId}. No changes applied.`;
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'run-agents',
        aliases: ['agents-run'],
        callback: runEnabledAgentsCommand,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'assistant message id',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                defaultValue: '',
            }),
        ],
        returns: ARGUMENT_TYPE.STRING,
        helpString: 'Runs all enabled post/manual agents on the given assistant message id. If omitted, uses the latest assistant message.',
    }));
}

function renderAgentCard(agent) {
    const profileName = getConnectionProfiles().find(profile => profile.id === agent.connectionProfileId)?.name
        || (agent.connectionProfileId ? agent.connectionProfileId : 'Selected profile');
    const conditionBadges = getConditionBadges(agent);
    const badges = [
        { text: getPhaseLabel(agent.phase), extraClass: `agents-badge-phase-${escapeHtmlAttr(agent.phase)}` },
        { text: getOutputLabel(agent), extraClass: 'agents-badge-output' },
        { text: profileName, extraClass: 'agents-badge-profile' },
        { text: getInputModeSummary(agent), extraClass: 'agents-badge-input' },
        ...conditionBadges.map(text => ({ text, extraClass: 'agents-badge-condition' })),
    ];

    const expandedClass = agent.expanded ? '' : ' agents-card-collapsed';
    const detailsHiddenClass = agent.expanded ? '' : ' displayNone';

    const card = $(
        `<div class="agents-card flex-container flexFlowColumn gap8px${expandedClass}" data-agent-id="${escapeHtmlAttr(agent.id)}">
            <div class="agents-card-header flex-container alignitemscenter gap10px spaceBetween">
                <div class="flex-container alignitemscenter gap10px flex1 minWidth0">
                    <div class="agents-drag-handle menu_button menu_button_icon" title="Drag to reorder">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </div>
                    <button type="button" class="agents-card-toggle menu_button menu_button_icon" aria-expanded="${agent.expanded ? 'true' : 'false'}">
                        <i class="fa-solid ${agent.expanded ? 'fa-chevron-down' : 'fa-chevron-right'}"></i>
                    </button>
                    <div class="flex-container flexFlowColumn minWidth0 flex1 agents-card-titlewrap">
                        <strong class="agents-card-title">${escapeHtmlText(agent.name || 'Untitled Agent')}</strong>
                        <small class="text_muted agents-card-description">${escapeHtmlText(agent.description || 'No description')}</small>
                    </div>
                </div>
                <div class="flex-container alignitemscenter gap10px flexWrap justifyEnd agents-card-header-right">
                    <label class="checkbox_label flexNoGap agents-card-enabled-toggle">
                        <input class="agents-card-enabled" type="checkbox" ${agent.enabled ? 'checked' : ''}>
                        <span>${agent.enabled ? 'Enabled' : 'Disabled'}</span>
                    </label>
                </div>
            </div>
            <div class="flex-container flexWrap gap8px agents-card-badges">
                ${badges.map(badge => `<small class="agents-badge ${badge.extraClass}">${escapeHtmlText(badge.text)}</small>`).join('')}
            </div>
            <div class="agents-card-body${detailsHiddenClass}">
                <div class="agents-card-actions flex-container gap10px flexWrap">
                    <div class="menu_button menu_button_icon agents-edit-agent"><i class="fa-solid fa-pencil"></i><span>Edit</span></div>
                    <div class="menu_button menu_button_icon agents-test-agent"><i class="fa-solid fa-vial"></i><span>Test on latest reply</span></div>
                    <div class="menu_button menu_button_icon agents-run-agent"><i class="fa-solid fa-play"></i><span>Run now</span></div>
                    <div class="menu_button menu_button_icon caution agents-delete-agent"><i class="fa-solid fa-trash"></i><span>Delete</span></div>
                </div>
                <div class="agents-card-meta flex-container flexWrap gap10px">
                    <small class="text_muted">Generation: ${escapeHtmlText(getGenerationTypeLabel(activeGenerationState?.type || 'normal'))}</small>
                    <small class="text_muted">Max tokens: ${escapeHtmlText(agent.maxTokens)}</small>
                    <small class="text_muted">Past messages: ${escapeHtmlText(agent.pastMessageCount)}</small>
                    <small class="text_muted">Retries: ${escapeHtmlText(agent.retries ?? 0)}</small>
                </div>
            </div>
        </div>`,
    );

    card.find('.agents-card-enabled').on('change', function () {
        agent.enabled = $(this).prop('checked');
        upsertAgent(agent);
    });

    card.find('.agents-card-toggle').on('click', function () {
        const nextExpanded = !agent.expanded;
        agent.expanded = nextExpanded;
        updateAgentExpanded(agent.id, nextExpanded);
        card.toggleClass('agents-card-collapsed', !nextExpanded);
        card.find('.agents-card-body').toggleClass('displayNone', !nextExpanded);
        $(this).attr('aria-expanded', nextExpanded ? 'true' : 'false');
        $(this).find('i').attr('class', `fa-solid ${nextExpanded ? 'fa-chevron-down' : 'fa-chevron-right'}`);
    });

    card.find('.agents-edit-agent').on('click', () => openAgentEditor(agent.id));
    card.find('.agents-test-agent').on('click', async () => await runSingleAgentAgainstLatestMessage(agent.id));
    card.find('.agents-run-agent').on('click', async () => await runManualAgent(agent.id));
    card.find('.agents-delete-agent').on('click', async () => {
        const confirmed = await Popup.show.confirm('Delete Agent', `Delete agent "${agent.name || 'Untitled Agent'}"?`);
        if (confirmed) {
            deleteAgent(agent.id);
        }
    });

    return card;
}

function initAgentsSortable() {
    const list = $('#agents_list');
    if (!list.length) {
        return;
    }

    // @ts-ignore
    if (list.sortable('instance') !== undefined) {
        // @ts-ignore
        list.sortable('destroy');
    }

    // @ts-ignore
    list.sortable({
        delay: getSortableDelay(),
        handle: '.agents-drag-handle',
        items: '.agents-card',
        stop: function () {
            const orderedIds = list.children('.agents-card').map((_, element) => String($(element).data('agent-id') || '')).get();
            const settings = ensureAgentsSettings();
            const byId = new Map(settings.agents.map(agent => [agent.id, agent]));
            settings.agents = orderedIds.map(id => byId.get(id)).filter(Boolean);
            resequenceAgents(settings.agents);
            saveAgentsSettings();
            renderAgentsList();
        },
    }).disableSelection();
}

function renderAgentsList() {
    const list = $('#agents_list');
    if (!list.length) {
        return;
    }

    // If the editor is parked inside the list (in-slot edit), move it back to
    // its safe home first so list.empty() does not destroy it.
    const $editor = $('#agents_editor');
    if ($editor.parent().is('#agents_list')) {
        $editor.insertBefore('#agents_list');
    }

    list.empty();
    const agents = getAgents().slice().sort((a, b) => Number(a.priority) - Number(b.priority));

    if (!agents.length) {
        list.append('<div class="text_muted">No agents created yet.</div>');
        return;
    }

    for (const agent of agents) {
        list.append(renderAgentCard(agent));
    }

    initAgentsSortable();
}

function setEditorVisible(visible) {
    $('#agents_editor').toggleClass('displayNone', !visible);
}

function syncOutputModeUi() {
    const outputType = String($('#agents_editor_output_type').val() || 'inject');
    $('#agents_output_role_wrap').toggleClass('displayNone', outputType !== 'inject');
    $('#agents_store_key_wrap').toggleClass('displayNone', outputType !== 'metadata');
    $('#agents_structured_wrap').toggleClass('displayNone', !['rewrite', 'append', 'patch'].includes(outputType));
    // Patch mode requires structured JSON output (the model emits a "patches" array).
    if (outputType === 'patch') {
        const $structured = $('#agents_editor_output_structured');
        if (!$structured.prop('checked')) {
            $structured.prop('checked', true);
        }
        $('#agents_patch_hint').removeClass('displayNone');
    } else {
        $('#agents_patch_hint').addClass('displayNone');
    }
}

function fillEditor(agent) {
    const normalized = normalizeAgent(agent);
    $('#agents_editor_id').val(normalized.id);
    $('#agents_editor_name').val(normalized.name);
    $('#agents_editor_description').val(normalized.description);
    $('#agents_editor_phase').val(normalized.phase);
    $('#agents_editor_connection_profile').val(normalized.connectionProfileId);
    $('#agents_editor_prompt').val(normalized.prompt);
    $('#agents_editor_enabled').prop('checked', normalized.enabled);
    $('#agents_editor_include_chat').prop('checked', normalized.inputMode.includeChat);
    $('#agents_editor_include_character').prop('checked', normalized.inputMode.includeCharacter);
    $('#agents_editor_include_persona').prop('checked', normalized.inputMode.includePersona);
    $('#agents_editor_include_world_info').prop('checked', normalized.inputMode.includeWorldInfo);
    $('#agents_editor_include_main_reply').prop('checked', normalized.inputMode.includeMainReply);
    $('#agents_editor_output_type').val(normalized.outputMode.type);
    $('#agents_editor_output_role').val(normalized.outputMode.role);
    $('#agents_editor_store_key').val(normalized.outputMode.storeKey);
    $('#agents_editor_output_structured').prop('checked', normalized.outputMode.structured);
    $('#agents_editor_max_tokens').val(normalized.maxTokens);
    $('#agents_editor_past_message_count').val(normalized.pastMessageCount);
    $('#agents_editor_retries').val(normalized.retries ?? 0);
    $('#agents_editor_only_group_chats').prop('checked', normalized.conditions.onlyGroupChats);
    $('#agents_editor_only_character_chats').prop('checked', normalized.conditions.onlyCharacterChats);
    $('#agents_editor_skip_swipe').prop('checked', normalized.conditions.skipSwipe);
    $('#agents_editor_skip_continue').prop('checked', normalized.conditions.skipContinue);
    $('#agents_editor_skip_impersonate').prop('checked', normalized.conditions.skipImpersonate);
    $('#agents_editor_skip_quiet').prop('checked', normalized.conditions.skipQuiet);
    syncOutputModeUi();
}

function parseStructuredAgentResult(rawResult) {
    const text = String(rawResult ?? '').trim();
    if (!text) {
        return null;
    }

    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = codeBlockMatch ? codeBlockMatch[1] : text;

    try {
        const parsed = JSON.parse(candidate);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        if (Array.isArray(parsed.patches)) {
            const patches = parsed.patches
                .filter(p => p && typeof p === 'object')
                .map(p => ({
                    find: typeof p.find === 'string' ? p.find : '',
                    replace: typeof p.replace === 'string' ? p.replace : '',
                }))
                .filter(p => p.find.length > 0);
            return {
                mode: 'patch',
                patches,
                changed: typeof parsed.changed === 'boolean' ? parsed.changed : undefined,
                what_changed: typeof parsed.what_changed === 'string' ? parsed.what_changed.trim() : '',
                removed_or_blocked_phrases: uniqueStringList(parsed.removed_or_blocked_phrases),
                notes_for_future_passes: uniqueStringList(parsed.notes_for_future_passes),
            };
        }

        return {
            revised_message: typeof parsed.revised_message === 'string' ? parsed.revised_message : '',
            changed: typeof parsed.changed === 'boolean' ? parsed.changed : undefined,
            what_changed: typeof parsed.what_changed === 'string' ? parsed.what_changed.trim() : '',
            removed_or_blocked_phrases: uniqueStringList(parsed.removed_or_blocked_phrases),
            notes_for_future_passes: uniqueStringList(parsed.notes_for_future_passes),
        };
    } catch {
        return null;
    }
}

function updateRevisionContext(revisionContext, agent, inputMessage, outputMessage, result, changed, options = {}) {
    if (!revisionContext) {
        return;
    }

    const parseFailed = Boolean(options.parseFailed);
    const structured = agent.outputMode.structured && !parseFailed ? parseStructuredAgentResult(result) : null;
    const summary = parseFailed
        ? `Failed to produce valid structured output; preserving text from previous successful agent${agent.name ? ` (${agent.name})` : ''}.`
        : (structured?.what_changed
            || (changed ? `Revised message content${agent.name ? ` via ${agent.name}` : ''}.` : 'No changes made.'));
    const blocked = uniqueStringList(structured?.removed_or_blocked_phrases);
    const notes = uniqueStringList(structured?.notes_for_future_passes);
    const appliedPatches = Array.isArray(options.appliedPatches) ? options.appliedPatches : [];
    const skippedPatches = Array.isArray(options.skippedPatches) ? options.skippedPatches : [];

    revisionContext.currentMessage = String(outputMessage ?? inputMessage ?? revisionContext.currentMessage ?? '');
    revisionContext.passes.push({
        agentId: agent.id,
        agentName: agent.name,
        inputMessage: String(inputMessage ?? ''),
        outputMessage: String(outputMessage ?? ''),
        changed: Boolean(changed),
        summary,
        blockedReintroductions: blocked,
        notesForFuturePasses: notes,
        appliedPatches,
        skippedPatches,
    });
    revisionContext.forbiddenAddBack = uniqueStringList([...revisionContext.forbiddenAddBack, ...blocked]);
    revisionContext.notesForNextPass = uniqueStringList([...revisionContext.notesForNextPass, summary, ...notes]);
}

function showPostAgentProgressToast(message, title = 'Agents') {
    return toastr.info(message, title, {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: false,
        tapToDismiss: false,
    });
}

function readEditorAgent() {
    return normalizeAgent({
        id: String($('#agents_editor_id').val() || generateAgentId()),
        name: String($('#agents_editor_name').val() || ''),
        description: String($('#agents_editor_description').val() || ''),
        phase: String($('#agents_editor_phase').val() || 'pre'),
        connectionProfileId: String($('#agents_editor_connection_profile').val() || ''),
        prompt: String($('#agents_editor_prompt').val() || ''),
        enabled: $('#agents_editor_enabled').prop('checked'),
        inputMode: {
            includeChat: $('#agents_editor_include_chat').prop('checked'),
            includeCharacter: $('#agents_editor_include_character').prop('checked'),
            includePersona: $('#agents_editor_include_persona').prop('checked'),
            includeWorldInfo: $('#agents_editor_include_world_info').prop('checked'),
            includeMainReply: $('#agents_editor_include_main_reply').prop('checked'),
        },
        outputMode: {
            type: String($('#agents_editor_output_type').val() || 'inject'),
            role: String($('#agents_editor_output_role').val() || 'system'),
            storeKey: String($('#agents_editor_store_key').val() || 'agent_result'),
            structured: $('#agents_editor_output_structured').prop('checked'),
        },
        conditions: {
            onlyGroupChats: $('#agents_editor_only_group_chats').prop('checked'),
            onlyCharacterChats: $('#agents_editor_only_character_chats').prop('checked'),
            skipSwipe: $('#agents_editor_skip_swipe').prop('checked'),
            skipContinue: $('#agents_editor_skip_continue').prop('checked'),
            skipImpersonate: $('#agents_editor_skip_impersonate').prop('checked'),
            skipQuiet: $('#agents_editor_skip_quiet').prop('checked'),
        },
        maxTokens: $('#agents_editor_max_tokens').val() === ''
            ? DEFAULT_AGENT_MAX_TOKENS
            : Number($('#agents_editor_max_tokens').val()),
        pastMessageCount: Number($('#agents_editor_past_message_count').val() || 3),
        retries: Number($('#agents_editor_retries').val() || DEFAULT_AGENT_RETRIES),
    });
}

function openAgentEditor(agentId = null) {
    populateConnectionProfileSelects();
    const agent = agentId ? getAgents().find(entry => entry.id === agentId) : createDefaultAgent();
    fillEditor(agent || createDefaultAgent());
    const $editor = $('#agents_editor');
    if (agentId) {
        const $card = $(`#agents_list [data-agent-id="${CSS.escape(agentId)}"]`);
        // Replace the source card's slot with the editor so it appears in place,
        // not floated at the top of the panel.
        $card.addClass('displayNone');
        $editor.insertBefore($card);
    } else {
        // New agent: drop the editor at the end of the list.
        $editor.insertAfter('#agents_list');
    }
    setEditorVisible(true);
}

function closeAgentEditor() {
    // Restore the editor to its original spot (before the list, inside the holder)
    // and un-hide any card that was hidden while editing.
    $('#agents_list [data-agent-id]').removeClass('displayNone');
    $('#agents_editor').insertBefore('#agents_list');
    setEditorVisible(false);
}

function bindUi() {
    $('#agents_global_enabled').on('change', function () {
        ensureAgentsSettings().enabled = $(this).prop('checked');
        saveAgentsSettings();
        renderAgentsList();
    });

    $('#agents_global_min_tokens').on('input', function () {
        ensureAgentsSettings().minMessageTokens = Math.max(0, Number($(this).val() || 0));
        saveAgentsSettings();
    });

    $('#agents_new_agent').on('click', () => openAgentEditor());
    $('#agents_refresh_profiles').on('click', populateConnectionProfileSelects);
    $('#agents_editor_output_type').on('change', syncOutputModeUi);
    $('#agents_save_agent').on('click', () => {
        const agent = readEditorAgent();
        if (!agent.name.trim()) {
            toastr.warning('Agent name is required.', 'Agents');
            return;
        }

        if (!agent.prompt.trim()) {
            toastr.warning('Agent prompt is required.', 'Agents');
            return;
        }

        upsertAgent(agent);
        closeAgentEditor();
    });
    $('#agents_cancel_edit').on('click', closeAgentEditor);
}

function syncUiFromSettings() {
    const settings = ensureAgentsSettings();
    $('#agents_global_enabled').prop('checked', settings.enabled);
    $('#agents_global_min_tokens').val(settings.minMessageTokens);
    populateConnectionProfileSelects();
    syncOutputModeUi();
    renderAgentsList();
}

function onGenerationAfterCommands(type, _options, dryRun) {
    if (dryRun) {
        return;
    }

    activeGenerationState = {
        type: String(type ?? 'normal'),
    };
}

async function onGenerateAfterCombinePrompts(eventData) {
    if (!ensureAgentsSettings().enabled) {
        clearPreAgentInjection();
        return;
    }

    await runPreAgents(activeGenerationState?.type || 'normal');
}

function onGenerationFinished() {
    activeGenerationState = null;
    clearPreAgentInjection();
}

function onGenerationStopped() {
    activeGenerationState = null;
    clearPreAgentInjection();
    stopAgents();
}

export function stopAgents() {
    if (agentAbortController) {
        agentAbortController.abort('Generation stopped by user');
        agentAbortController = null;
        return true;
    }
    return false;
}

function escapeHtmlText(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function escapeHtmlAttr(value) {
    return escapeHtmlText(value);
}

export function initAgents() {
    console.log('[Agents] initAgents() called — module loaded successfully');
    ensureAgentsSettings();
    bindUi();
    syncUiFromSettings();
    registerSlashCommands();

    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, populateConnectionProfileSelects);
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, populateConnectionProfileSelects);
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, populateConnectionProfileSelects);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onGenerateAfterCombinePrompts);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
}

export { POST_AGENTS_FINISHED_EVENT };
