// @ts-nocheck
export const DEFAULT_AGENT_MAX_TOKENS = 512;
export const DEFAULT_AGENT_PRIORITY = 100;
export const MIN_AGENT_MAX_TOKENS = 0;
export const MAX_AGENT_MAX_TOKENS = 16000;
export const DEFAULT_AGENT_RETRIES = 0;
export const MAX_AGENT_RETRIES = 10;

function generateAgentId() {
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

export function getConnectionProfilesFromSettings(settings) {
    return (settings?.extension_settings?.connectionManager?.profiles ?? [])
        .slice()
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

export function getAgentsFromSettings(settings) {
    return (settings?.extension_settings?.rayasAgents?.agents ?? [])
        .map(normalizeAgent)
        .filter(agent => agent.enabled)
        .sort((a, b) => Number(a.priority) - Number(b.priority));
}

export function getLastAssistantMessageId(chatData = []) {
    return [...chatData.keys()].reverse().find(index => chatData[index] && !chatData[index].is_user && !chatData[index].is_system);
}

export function stripTrackerBlocks(text) {
    let cleaned = String(text ?? '');
    const fenceTypes = 'disp|sim|json';

    cleaned = cleaned.replace(new RegExp(`<div\\s+style\\s*=\\s*["']display\\s*:\\s*none;?\\s*["']\\s*>[\\s\\S]*?\`\`\`(?:${fenceTypes})[\\s\\S]*?\`\`\`[\\s\\S]*?<\\/div>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`\`\`\`(?:${fenceTypes})[\\s\\S]*?\`\`\``, 'gi'), '');
    cleaned = cleaned.replace(/<div\s+style\s*=\s*["']display\s*:\s*none;?\s*["']\s*>[\s\S]*?<\/div>/gi, '');

    return cleaned.trim();
}

function extractInfoBoard(rawText) {
    const text = String(rawText ?? '');
    const match = text.match(/(\[Info_Board\][\s\S]*?\[\/Info_Board\])/i);
    if (!match) {
        return { infoBoard: '', body: text };
    }

    const infoBoard = match[1];
    const body = text.replace(infoBoard, '').trim();
    return { infoBoard, body };
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

export function uniqueStringList(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => String(value ?? '').trim())
        .filter(Boolean))];
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

export function buildPastContextXmlFromChat(chatData, message, pastMessageCount, messageId = null, names = {}) {
    const currentIndex = Number.isInteger(Number(messageId))
        ? Number(messageId)
        : Number(chatData.indexOf(message));
    if (!Number.isInteger(currentIndex) || currentIndex < 0) {
        return '';
    }

    const userName = String(names.userName ?? 'User');
    const characterName = String(names.characterName ?? 'Assistant');
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
        const speaker = entry.name || (entry.is_user ? userName : characterName);
        return `<message index="${index}" speaker="${escapeHtmlAttr(speaker)}">\n${extractInfoBoard(stripTrackerBlocks(entry.mes)).body}\n</message>`;
    }).join('\n\n');
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

export function buildAgentContext(agent, {
    message = null,
    messageId = null,
    revisionContext = null,
    chatData = [],
    character = null,
    personaDescription = '',
    worldInfoText = '',
    names = {},
} = {}) {
    const messageText = stripTrackerBlocks(getFallbackAssistantText(message, revisionContext));
    const mainReply = agent.inputMode.includeMainReply ? messageText : '';
    const contextMessageId = Number.isInteger(Number(revisionContext?.messageId))
        ? Number(revisionContext.messageId)
        : Number.isInteger(Number(messageId))
            ? Number(messageId)
            : Number(chatData.indexOf(message));
    const chatXml = agent.inputMode.includeChat
        ? buildPastContextXmlFromChat(chatData, message, Number(agent.pastMessageCount ?? 0), contextMessageId, names)
        : '';
    const currentMessageXml = buildTargetMessageXml(mainReply, revisionContext);
    const revisionHistoryXml = buildRevisionHistoryXml(revisionContext);

    return {
        agentName: agent.name,
        agentDescription: agent.description,
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
        characterName: String(character?.name ?? ''),
        characterDescription: agent.inputMode.includeCharacter ? String(character?.description ?? '') : '',
        characterPersonality: agent.inputMode.includeCharacter ? String(character?.personality ?? '') : '',
        scenario: agent.inputMode.includeCharacter ? String(character?.scenario ?? '') : '',
        persona: agent.inputMode.includePersona ? String(personaDescription ?? '') : '',
        worldInfo: agent.inputMode.includeWorldInfo ? String(worldInfoText ?? '') : '',
    };
}

export function buildAgentPrompt(agent, context) {
    const sections = [];
    const basePrompt = String(agent?.prompt ?? '').trim();

    if (basePrompt) {
        sections.push(basePrompt);
    }

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

    return sections.filter(Boolean).join('\n\n');
}

/**
 * Parse a patch-mode agent response (a JSON object like {patches:[{find,replace}]})
 * and apply the patches onto the original text, returning the fully merged text.
 * If the JSON can't be parsed or is empty, returns the raw text unchanged so the
 * caller can fall back to displaying it as-is.
 */
export function applyPatches(original, patchesText) {
    const raw = String(patchesText ?? '').trim();
    if (!raw) {
        return raw;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // The model may have wrapped the JSON in code fences or prose; try to
        // extract the first balanced {...} block before giving up.
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            return raw;
        }
        try {
            parsed = JSON.parse(match[0]);
        } catch {
            return raw;
        }
    }

    const patches = Array.isArray(parsed?.patches) ? parsed.patches : [];
    if (!patches.length) {
        return raw;
    }

    let result = String(original ?? '');
    for (const patch of patches) {
        const find = String(patch?.find ?? '');
        const replace = String(patch?.replace ?? '');
        if (!find) {
            continue;
        }
        // Replace all non-overlapping occurrences of this find string.
        result = result.split(find).join(replace);
    }

    return result;
}
