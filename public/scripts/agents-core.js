// @ts-nocheck
import {
    chat,
    characters,
    chat_metadata,
    extension_prompt_roles,
    name1,
    name2,
    setExtensionPrompt,
    substituteParamsExtended,
    this_chid,
} from '../script.js';
import { extension_settings } from './extensions.js';
import { selected_group } from './group-chats.js';
import { ConnectionManagerRequestService } from './extensions/shared.js';
import { power_user } from './power-user.js';
import { getTokenCountAsync } from './tokenizers.js';

export const MODULE_NAME = 'rayasAgents';
export const PRE_AGENT_PROMPT_KEY = 'rayas_agents_pre';
export const DEFAULT_AGENT_MAX_TOKENS = 512;
export const DEFAULT_AGENT_PRIORITY = 100;
export const DEFAULT_MIN_AGENT_MESSAGE_TOKENS = 500;
export const MIN_AGENT_MAX_TOKENS = 0;
export const MAX_AGENT_MAX_TOKENS = 16000;
export const DEFAULT_AGENT_RETRIES = 0;
export const MAX_AGENT_RETRIES = 10;

export function ensureAgentsSettings() {
    /** @type {any} */
    const agentSettings = extension_settings;

    if (!agentSettings[MODULE_NAME] || typeof agentSettings[MODULE_NAME] !== 'object') {
        agentSettings[MODULE_NAME] = {
            enabled: true,
            minMessageTokens: DEFAULT_MIN_AGENT_MESSAGE_TOKENS,
            agents: [],
        };
    }

    const settings = agentSettings[MODULE_NAME];

    if (typeof settings.enabled !== 'boolean') {
        settings.enabled = true;
    }

    if (!Number.isFinite(Number(settings.minMessageTokens))) {
        settings.minMessageTokens = DEFAULT_MIN_AGENT_MESSAGE_TOKENS;
    }

    settings.minMessageTokens = Math.max(0, Math.min(100000, Number(settings.minMessageTokens)));

    if (!Array.isArray(settings.agents)) {
        settings.agents = [];
    }

    settings.agents = settings.agents.map(normalizeAgent);
    resequenceAgents(settings.agents);
    return settings;
}

export function generateAgentId() {
    return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeAgent(rawAgent = {}) {
    const defaults = {
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
    };

    const phase = ['pre', 'post', 'manual'].includes(String(rawAgent.phase ?? '')) ? String(rawAgent.phase) : defaults.phase;
    const outputType = ['inject', 'rewrite', 'append', 'metadata', 'patch'].includes(String(rawAgent?.outputMode?.type ?? ''))
        ? String(rawAgent.outputMode.type)
        : defaults.outputMode.type;
    const outputRole = ['system', 'user', 'assistant'].includes(String(rawAgent?.outputMode?.role ?? ''))
        ? String(rawAgent.outputMode.role)
        : defaults.outputMode.role;

    return {
        id: typeof rawAgent.id === 'string' && rawAgent.id.trim() ? rawAgent.id.trim() : defaults.id,
        name: typeof rawAgent.name === 'string' ? rawAgent.name : defaults.name,
        enabled: Object.hasOwn(rawAgent, 'enabled') ? Boolean(rawAgent.enabled) : defaults.enabled,
        description: typeof rawAgent.description === 'string' ? rawAgent.description : defaults.description,
        phase,
        connectionProfileId: typeof rawAgent.connectionProfileId === 'string' ? rawAgent.connectionProfileId : defaults.connectionProfileId,
        prompt: typeof rawAgent.prompt === 'string' ? rawAgent.prompt : defaults.prompt,
        pastMessageCount: Number.isFinite(Number(rawAgent.pastMessageCount))
            ? Math.max(0, Math.min(50, Number(rawAgent.pastMessageCount)))
            : defaults.pastMessageCount,
        expanded: Object.hasOwn(rawAgent, 'expanded') ? Boolean(rawAgent.expanded) : defaults.expanded,
        inputMode: {
            includeChat: Boolean(rawAgent?.inputMode?.includeChat ?? defaults.inputMode.includeChat),
            includeCharacter: Boolean(rawAgent?.inputMode?.includeCharacter ?? defaults.inputMode.includeCharacter),
            includePersona: Boolean(rawAgent?.inputMode?.includePersona ?? defaults.inputMode.includePersona),
            includeWorldInfo: Boolean(rawAgent?.inputMode?.includeWorldInfo ?? defaults.inputMode.includeWorldInfo),
            includeMainReply: Boolean(rawAgent?.inputMode?.includeMainReply ?? defaults.inputMode.includeMainReply),
        },
        outputMode: {
            type: outputType,
            role: outputRole,
            storeKey: typeof rawAgent?.outputMode?.storeKey === 'string' && rawAgent.outputMode.storeKey.trim()
                ? rawAgent.outputMode.storeKey.trim()
                : defaults.outputMode.storeKey,
            structured: Boolean(rawAgent?.outputMode?.structured ?? defaults.outputMode.structured),
        },
        conditions: {
            onlyGroupChats: Boolean(rawAgent?.conditions?.onlyGroupChats ?? defaults.conditions.onlyGroupChats),
            onlyCharacterChats: Boolean(rawAgent?.conditions?.onlyCharacterChats ?? defaults.conditions.onlyCharacterChats),
            skipSwipe: Boolean(rawAgent?.conditions?.skipSwipe ?? defaults.conditions.skipSwipe),
            skipContinue: Boolean(rawAgent?.conditions?.skipContinue ?? defaults.conditions.skipContinue),
            skipImpersonate: Boolean(rawAgent?.conditions?.skipImpersonate ?? defaults.conditions.skipImpersonate),
            skipQuiet: Boolean(rawAgent?.conditions?.skipQuiet ?? defaults.conditions.skipQuiet),
        },
        priority: Number.isFinite(Number(rawAgent.priority)) ? Number(rawAgent.priority) : defaults.priority,
        maxTokens: Number.isFinite(Number(rawAgent.maxTokens))
            ? Math.max(MIN_AGENT_MAX_TOKENS, Math.min(MAX_AGENT_MAX_TOKENS, Number(rawAgent.maxTokens)))
            : defaults.maxTokens,
        retries: Number.isFinite(Number(rawAgent.retries))
            ? Math.max(0, Math.min(MAX_AGENT_RETRIES, Number(rawAgent.retries)))
            : defaults.retries,
    };
}

export function getAgents() {
    return ensureAgentsSettings().agents;
}

export function resequenceAgents(agents) {
    for (let index = 0; index < agents.length; index++) {
        agents[index].priority = (index + 1) * 10;
    }
}

export function getEnabledAgentsByPhase(phase) {
    return getEnabledAgentsByPhases([phase]);
}

export function getEnabledAgentsByPhases(phases) {
    const settings = ensureAgentsSettings();
    if (!settings.enabled) {
        return [];
    }

    const phaseSet = new Set((Array.isArray(phases) ? phases : [phases]).map(phase => String(phase ?? '')));

    return settings.agents
        .filter(agent => agent.enabled && phaseSet.has(String(agent.phase ?? '')))
        .sort((a, b) => Number(a.priority) - Number(b.priority));
}

export function getConnectionProfiles() {
    return (extension_settings.connectionManager?.profiles ?? [])
        .slice()
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

export function getResolvedProfileId(agent, overrideProfileId = '') {
    return String(overrideProfileId || agent?.connectionProfileId || extension_settings.connectionManager?.selectedProfile || '');
}

export function getCurrentCharacter() {
    const chid = Number(this_chid);
    if (!Number.isInteger(chid) || chid < 0) {
        return null;
    }

    return characters[chid] ?? null;
}

export function getLastAssistantMessageId(chatData = chat) {
    return [...chatData.keys()].reverse().find(index => chatData[index] && !chatData[index].is_user && !chatData[index].is_system);
}

export function shouldRunAgent(agent, generationType = 'normal', source = 'manual', isGroupChat = selected_group) {
    const conditions = agent?.conditions ?? {};
    const normalizedType = String(generationType ?? 'normal');

    if (conditions.onlyGroupChats && !isGroupChat) {
        return false;
    }

    if (conditions.onlyCharacterChats && isGroupChat) {
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

export function stripTrackerBlocks(text) {
    let cleaned = String(text ?? '');
    const fenceTypes = 'disp|sim|json';

    cleaned = cleaned.replace(new RegExp(`<div\\s+style\\s*=\\s*["']display\\s*:\\s*none;?\\s*["']\\s*>[\\s\\S]*?\`\`\`(?:${fenceTypes})[\\s\\S]*?\`\`\`[\\s\\S]*?<\\/div>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`\`\`\`(?:${fenceTypes})[\\s\\S]*?\`\`\``, 'gi'), '');
    cleaned = cleaned.replace(/<div\s+style\s*=\s*["']display\s*:\s*none;?\s*["']\s*>[\s\S]*?<\/div>/gi, '');

    return cleaned.trim();
}

export function buildPastContextXmlFromChat(chatData, message, pastMessageCount, messageId = null) {
    const currentIndex = Number.isInteger(Number(messageId))
        ? Number(messageId)
        : Number(chatData.indexOf(message));
    if (!Number.isInteger(currentIndex) || currentIndex < 0) {
        return '';
    }

    const messages = [];
    for (let index = currentIndex - 1; index >= 0 && messages.length < pastMessageCount; index--) {
        const entry = chatData[index];
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

export function buildPastContextXml(message, pastMessageCount, messageId = null) {
    return buildPastContextXmlFromChat(chat, message, pastMessageCount, messageId);
}

export function getFallbackAssistantText(message, revisionContext = null) {
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

export function createRevisionContextFromChat(chatData, message, messageId = null) {
    const originalMessage = getFallbackAssistantText(message);
    return {
        messageId: Number.isInteger(Number(messageId)) ? Number(messageId) : Number(chatData.indexOf(message)),
        originalMessage,
        currentMessage: originalMessage,
        passes: [],
        forbiddenAddBack: [],
        notesForNextPass: [],
    };
}

export function createRevisionContext(message, messageId = null) {
    return createRevisionContextFromChat(chat, message, messageId);
}

export function uniqueStringList(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => String(value ?? '').trim())
        .filter(Boolean))];
}

export function escapeXmlText(value) {
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

export function extractInfoBoard(rawText) {
    const text = String(rawText ?? '');
    const match = text.match(/(\[Info_Board\][\s\S]*?\[\/Info_Board\])/i);
    if (!match) {
        return { infoBoard: '', body: text };
    }

    const infoBoard = match[1];
    const body = text.replace(infoBoard, '').trim();
    return { infoBoard, body };
}

export function decodeHtmlEntities(rawText) {
    const text = String(rawText ?? '');
    if (!text.includes('&')) {
        return text;
    }

    return text
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, '\'')
        .replace(/&#(?:x27|39);/gi, '\'')
        .replace(/&#(?:x22|34);/gi, '"')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

export function escapeHtmlText(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

export function escapeHtmlAttr(value) {
    return escapeHtmlText(value);
}

export function buildRevisionHistoryXml(revisionContext) {
    if (!revisionContext || !Array.isArray(revisionContext.passes) || !revisionContext.passes.length) {
        return '';
    }

    const passXml = revisionContext.passes.map((pass, index) => {
        const blockedXml = uniqueStringList(pass.blockedReintroductions).map(item => `\n        <blocked>${escapeXmlText(item)}</blocked>`).join('');
        const notesXml = uniqueStringList(pass.notesForFuturePasses).map(item => `\n        <note>${escapeXmlText(item)}</note>`).join('');
        return `<pass index="${index + 1}" agent="${escapeHtmlAttr(pass.agentName || 'Agent')}">\n    <changed>${pass.changed ? 'true' : 'false'}</changed>\n    <summary>${escapeXmlText(pass.summary || 'No summary')}</summary>${blockedXml}${notesXml}\n</pass>`;
    }).join('\n');

    const forbiddenXml = uniqueStringList(revisionContext.forbiddenAddBack).map(item => `\n    <phrase>${escapeXmlText(item)}</phrase>`).join('');
    const notesXml = uniqueStringList(revisionContext.notesForNextPass).map(item => `\n    <note>${escapeXmlText(item)}</note>`).join('');

    return `<revision_history>\n<previous_passes>\n${passXml}\n</previous_passes>\n<do_not_reintroduce>${forbiddenXml}\n</do_not_reintroduce>\n<notes_for_next_pass>${notesXml}\n</notes_for_next_pass>\n</revision_history>`;
}

export function buildAgentContext(agent, { message = null, messageId = null, generationType = '', source = '', revisionContext = null, chatData = chat, character = null, personaDescription = null, worldInfoText = null } = {}) {
    const resolvedCharacter = character ?? getCurrentCharacter();
    const resolvedPersonaDescription = personaDescription ?? (typeof power_user !== 'undefined' ? String(power_user.persona_description ?? '') : '');
    const resolvedWorldInfoText = worldInfoText ?? (agent.inputMode.includeWorldInfo
        ? String(chat_metadata?.world_info ?? '')
        : '');
    const messageText = stripTrackerBlocks(getFallbackAssistantText(message, revisionContext));
    const mainReply = agent.inputMode.includeMainReply ? messageText : '';
    const contextMessageId = Number.isInteger(Number(revisionContext?.messageId))
        ? Number(revisionContext.messageId)
        : Number.isInteger(Number(messageId))
            ? Number(messageId)
            : Number(chatData.indexOf(message));
    const chatXml = agent.inputMode.includeChat ? buildPastContextXmlFromChat(chatData, message, Number(agent.pastMessageCount ?? 0), contextMessageId) : '';
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
        characterName: resolvedCharacter?.name ?? '',
        characterDescription: agent.inputMode.includeCharacter ? String(resolvedCharacter?.description ?? '') : '',
        characterPersonality: agent.inputMode.includeCharacter ? String(resolvedCharacter?.personality ?? '') : '',
        scenario: agent.inputMode.includeCharacter ? String(resolvedCharacter?.scenario ?? '') : '',
        persona: agent.inputMode.includePersona ? resolvedPersonaDescription : '',
        worldInfo: resolvedWorldInfoText,
    };
}

export async function buildAgentPrompt(agent, context) {
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

    return [basePrompt, ...sections.filter(Boolean)].filter(Boolean).join('\n\n');
}

export function extractAgentResponseText(response) {
    if (typeof response === 'string') {
        return response.trim();
    }

    if (response && typeof response === 'object') {
        const direct = response.content ?? response.message ?? response.text ?? response.output ?? response?.choices?.[0]?.message?.content;
        return String(direct ?? '').trim();
    }

    return '';
}

export async function runAgentCompletion(agent, context, overrideProfileId = '') {
    const profileId = getResolvedProfileId(agent, overrideProfileId);
    if (!profileId) {
        throw new Error(`No connection profile selected for agent "${agent.name || 'Unnamed Agent'}"`);
    }

    const prompt = await buildAgentPrompt(agent, context);
    if (!prompt.trim()) {
        return { text: '', prompt, raw: '', profileId, response: null };
    }

    const maxTokens = Number(agent.maxTokens) > 0 ? Number(agent.maxTokens) : null;
    const response = await ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens, {
        stream: false,
        extractData: true,
    });

    return {
        text: extractAgentResponseText(response),
        prompt,
        raw: response,
        profileId,
        response,
    };
}

export async function getAgentGateInfo(message, revisionContext = null, minTokenOverride = null) {
    const minTokens = Math.max(0, Number(minTokenOverride ?? ensureAgentsSettings().minMessageTokens ?? 0));
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

export function clearPreAgentInjection() {
    setExtensionPrompt(PRE_AGENT_PROMPT_KEY, '', 0, 0, true, extension_prompt_roles.SYSTEM);
}
