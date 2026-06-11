// @ts-nocheck
import { DiffMatchPatch } from '../lib.js';
import {
    normalizeAgent,
    getAgentsFromSettings,
    buildAgentContext,
    buildAgentPrompt,
    createRevisionContextFromChat,
    getFallbackAssistantText,
    getLastAssistantMessageId,
    stripTrackerBlocks,
} from './agent-playground-core.js';

const state = {
    csrfToken: '',
    settings: null,
    chats: [],
    groups: [],
    charactersByAvatar: new Map(),
    selectedChatKey: '',
    selectedAgentId: '',
    selectedChatMessages: [],
    selectedAgent: null,
    currentMessageId: null,
    selectedCharacter: null,
    selectedGroup: null,
    config: null,
};

function $(id) {
    return document.getElementById(id);
}

function setStatus(text) {
    $('agentplayground_status').textContent = text;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function normalizeReasoningText(text) {
    const normalized = stripTrackerBlocks(String(text ?? '').trim());
    return normalized || 'null';
}

function formatCharCount(text) {
    return `${String(text ?? '').length.toLocaleString()} chars`;
}

function getPriorMessageLines(context) {
    const matches = String(context?.pastContext ?? '').match(/<message[^>]*>\n([\s\S]*?)\n<\/message>/g) ?? [];
    const values = matches
        .map(item => item.replace(/<message[^>]*>\n?/i, '').replace(/\n?<\/message>/i, '').trim())
        .filter(Boolean);

    return [values.at(-2) || 'No earlier context.', values.at(-1) || 'No earlier context.'];
}

function setKeyState(hasApiKey) {
    $('agentplayground_key_state').textContent = hasApiKey
        ? 'API key saved on server.'
        : 'API key not saved yet.';
}

async function ensureCsrfToken() {
    if (state.csrfToken) {
        return state.csrfToken;
    }

    const tokenResponse = await fetch('/csrf-token');
    const tokenData = await tokenResponse.json();
    state.csrfToken = String(tokenData.token ?? '');
    return state.csrfToken;
}

async function fetchJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': await ensureCsrfToken(),
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `${url} failed with ${response.status}`);
    }

    return await response.json();
}

function getAgents() {
    return getAgentsFromSettings(state.settings);
}

function getSelectedPersonaDescription() {
    return String(state.settings?.power_user?.persona_description ?? '');
}

async function loadSettings() {
    const data = await fetchJson('/api/settings/get', {});
    state.settings = data ? JSON.parse(data.settings) : {};
}

async function loadServerConfig() {
    state.config = await fetchJson('/api/agentplayground/config/get', {});
    $('agentplayground_provider_url').value = String(state.config?.providerUrl || state.settings?.extension_settings?.rayasAgentPlayground?.providerUrl || '');
    $('agentplayground_model_a').value = String(state.config?.modelA || state.settings?.extension_settings?.rayasAgentPlayground?.modelA || '');
    $('agentplayground_model_b').value = String(state.config?.modelB || state.settings?.extension_settings?.rayasAgentPlayground?.modelB || '');
    $('agentplayground_provider_key').value = '';
    setKeyState(Boolean(state.config?.hasApiKey));
    syncHeaderPills();
}

async function saveServerConfig() {
    await fetchJson('/api/agentplayground/config/save', {
        providerUrl: $('agentplayground_provider_url').value.trim(),
        modelA: $('agentplayground_model_a').value.trim(),
        modelB: $('agentplayground_model_b').value.trim(),
        apiKey: $('agentplayground_provider_key').value,
    });

    $('agentplayground_provider_key').value = '';
    await loadServerConfig();
    setStatus('Playground config saved.');
}

async function loadCharacters() {
    const characters = await fetchJson('/api/characters/all', {});
    state.charactersByAvatar = new Map(
        (Array.isArray(characters) ? characters : [])
            .filter(character => character?.avatar)
            .map(character => [String(character.avatar), character]),
    );
}

async function loadChats() {
    const [recent, groups] = await Promise.all([
        fetchJson('/api/chats/recent', { max: 100, pinned: [], metadata: true }),
        fetchJson('/api/groups/all', {}),
    ]);

    state.groups = Array.isArray(groups) ? groups : [];
    state.chats = (Array.isArray(recent) ? recent : []).map((entry) => {
        const isGroup = Boolean(entry.group);
        const fileId = String(entry.file_name ?? '').replace(/\.jsonl$/i, '');
        const group = isGroup ? state.groups.find(item => String(item.id) === String(entry.group)) : null;
        const character = !isGroup ? state.charactersByAvatar.get(String(entry.avatar ?? '')) : null;
        const title = isGroup
            ? String(group?.name || fileId || entry.group)
            : String(character?.name || fileId || entry.avatar || 'Chat');

        return {
            key: isGroup ? `group:${entry.group}:${fileId}` : `char:${entry.avatar}:${fileId}`,
            type: isGroup ? 'group' : 'character',
            file_id: fileId,
            avatar: entry.avatar,
            groupId: entry.group,
            title,
        };
    });
}

function populateChatSelect() {
    const select = $('agentplayground_chat');
    select.innerHTML = '';

    for (const chatEntry of state.chats) {
        const option = document.createElement('option');
        option.value = chatEntry.key;
        option.textContent = `${chatEntry.type === 'group' ? '[Group]' : '[Chat]'} ${chatEntry.title}`;
        select.appendChild(option);
    }

    if (state.chats.length) {
        state.selectedChatKey = state.selectedChatKey || state.chats[0].key;
        select.value = state.selectedChatKey;
    }
}

function populateAgentSelect() {
    const select = $('agentplayground_agent');
    select.innerHTML = '';

    const agents = getAgents();
    for (const agent of agents) {
        const option = document.createElement('option');
        option.value = agent.id;
        option.textContent = agent.name || 'Untitled Agent';
        select.appendChild(option);
    }

    if (agents.length) {
        state.selectedAgentId = state.selectedAgentId || agents[0].id;
        select.value = state.selectedAgentId;
    }

    renderAgentCards();
}

function renderAgentCards() {
    const container = $('agentplayground_agents_list');
    container.innerHTML = '';

    const agents = getAgents();
    if (!agents.length) {
        container.innerHTML = '<div class="ap-agent-desc">No saved agents found.</div>';
        return;
    }

    for (const agent of agents) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `ap-agent-card${agent.id === state.selectedAgentId ? ' is-active' : ''}`;
        card.innerHTML = `
            <div class="ap-agent-name">◈ ${escapeHtml(agent.name || 'Untitled Agent')}</div>
            <div class="ap-agent-desc">${escapeHtml(agent.description || 'No description.')}</div>
            <div class="ap-tags">
                <span class="ap-tag">${escapeHtml(agent.phase || 'manual')}</span>
                <span class="ap-tag">${escapeHtml(agent.outputMode?.type || 'inject')}</span>
                <span class="ap-tag">${Number(agent.pastMessageCount || 0)} ctx</span>
            </div>
        `;
        card.addEventListener('click', async () => {
            state.selectedAgentId = agent.id;
            $('agentplayground_agent').value = agent.id;
            renderAgentCards();
            updateContextPreview();
        });
        container.appendChild(card);
    }
}

function syncHeaderPills() {
    $('agentplayground_top_model_a').textContent = $('agentplayground_model_a').value.trim() || 'Model A';
    $('agentplayground_top_model_b').textContent = $('agentplayground_model_b').value.trim() || 'Model B';
    const selectedChat = state.chats.find(entry => entry.key === state.selectedChatKey);
    $('agentplayground_top_chat').textContent = selectedChat?.title || 'No chat selected';
}

async function loadSelectedChat() {
    const chatEntry = state.chats.find(entry => entry.key === state.selectedChatKey);
    if (!chatEntry) {
        state.selectedChatMessages = [];
        state.currentMessageId = null;
        state.selectedCharacter = null;
        state.selectedGroup = null;
        return;
    }

    state.selectedGroup = chatEntry.type === 'group'
        ? state.groups.find(group => String(group.id) === String(chatEntry.groupId)) ?? null
        : null;
    state.selectedCharacter = chatEntry.type === 'character'
        ? state.charactersByAvatar.get(String(chatEntry.avatar ?? '')) ?? null
        : null;

    if (chatEntry.type === 'group') {
        state.selectedChatMessages = await fetchJson('/api/chats/group/get', { id: chatEntry.file_id });
    } else {
        state.selectedChatMessages = await fetchJson('/api/chats/get', {
            avatar_url: chatEntry.avatar,
            file_name: chatEntry.file_id,
        });
    }

    if (Array.isArray(state.selectedChatMessages) && state.selectedChatMessages.length && Object.hasOwn(state.selectedChatMessages[0], 'chat_metadata')) {
        state.selectedChatMessages.shift();
    }

    state.currentMessageId = getLastAssistantMessageId(state.selectedChatMessages);
    syncHeaderPills();
}

function buildNames() {
    const chatHeader = state.selectedChatMessages?.[0]?.chat_metadata ?? {};
    return {
        userName: chatHeader.user_name || state.settings?.name1 || 'User',
        characterName: state.selectedCharacter?.name || state.selectedGroup?.name || chatHeader.character_name || 'Assistant',
    };
}

function buildCurrentContext() {
    if (!state.selectedAgent || !Array.isArray(state.selectedChatMessages) || !state.selectedChatMessages.length || !Number.isInteger(state.currentMessageId)) {
        return null;
    }

    const message = state.selectedChatMessages[state.currentMessageId];
    const revisionContext = createRevisionContextFromChat(state.selectedChatMessages, message, state.currentMessageId);
    return buildAgentContext(state.selectedAgent, {
        message,
        messageId: state.currentMessageId,
        revisionContext,
        chatData: state.selectedChatMessages,
        character: state.selectedCharacter,
        personaDescription: getSelectedPersonaDescription(),
        worldInfoText: String(state.selectedChatMessages?.[0]?.chat_metadata?.world_info ?? ''),
        names: buildNames(),
    });
}

function updateContextPreview() {
    const agent = getAgents().find(entry => entry.id === state.selectedAgentId);
    state.selectedAgent = agent ? normalizeAgent(agent) : null;
    renderAgentCards();

    const context = buildCurrentContext();
    if (!context) {
        $('agentplayground_prior_context_line_1').textContent = 'Select a chat and agent.';
        $('agentplayground_prior_context_line_2').textContent = 'Select a chat and agent.';
        $('agentplayground_current_message_line').textContent = 'Select a chat and agent.';
        $('agentplayground_stat_prior').textContent = '0';
        $('agentplayground_stat_current').textContent = '0 chars';
        $('agentplayground_stat_prompt').textContent = '0 chars';
        return;
    }

    const [priorOne, priorTwo] = getPriorMessageLines(context);
    const currentMessage = getFallbackAssistantText(state.selectedChatMessages[state.currentMessageId]) || '(empty)';
    const prompt = buildAgentPrompt(state.selectedAgent, context);

    $('agentplayground_prior_context_line_1').textContent = priorOne;
    $('agentplayground_prior_context_line_2').textContent = priorTwo;
    $('agentplayground_current_message_line').textContent = currentMessage;
    $('agentplayground_stat_prior').textContent = String(state.selectedAgent?.pastMessageCount ?? 0);
    $('agentplayground_stat_current').textContent = formatCharCount(currentMessage);
    $('agentplayground_stat_prompt').textContent = formatCharCount(prompt);
}

function renderPrettyDiff(original, revised) {
    if (!revised) {
        return 'No result yet.';
    }

    const dmp = new DiffMatchPatch();
    dmp.Diff_Timeout = 2.0;
    const diff = dmp.diff_main(String(original ?? ''), String(revised ?? ''));
    dmp.diff_cleanupSemantic(diff);

    return diff.map(([op, text]) => {
        const safe = escapeHtml(text).replace(/\n/g, '<br>');
        if (op === DiffMatchPatch.DIFF_INSERT) {
            return `<ins>${safe}</ins>`;
        }
        if (op === DiffMatchPatch.DIFF_DELETE) {
            return `<del>${safe}</del>`;
        }
        return `<span>${safe}</span>`;
    }).join('');
}

function setPanelState(side, label, badgeText, badgeClass, output, diffHtml, reasoning) {
    $(`agentplayground_profile_${side}_title`).textContent = label;
    const badge = $(`agentplayground_profile_${side}_meta`);
    badge.textContent = badgeText;
    badge.className = `ap-panel-badge${badgeClass ? ` ${badgeClass}` : ''}`;
    $(`agentplayground_diff_${side}`).innerHTML = diffHtml;
    const reasoningNode = $(`agentplayground_reasoning_${side}`);
    reasoningNode.textContent = reasoning;
    reasoningNode.className = reasoning === 'null' ? 'ap-reasoning-empty' : '';
}

async function runComparison() {
    if (!state.selectedAgent || !Number.isInteger(state.currentMessageId)) {
        setStatus('Select a chat and a valid assistant message first.');
        return;
    }

    const providerUrl = $('agentplayground_provider_url').value.trim();
    const modelA = $('agentplayground_model_a').value.trim();
    const modelB = $('agentplayground_model_b').value.trim();
    const context = buildCurrentContext();
    const original = getFallbackAssistantText(state.selectedChatMessages[state.currentMessageId]);
    const prompt = buildAgentPrompt(state.selectedAgent, context);

    if (!providerUrl || !modelA || !modelB) {
        setStatus('Save provider URL and both model IDs first.');
        return;
    }

    setStatus('Running both models...');
    $('agentplayground_run').disabled = true;
    setPanelState('a', modelA, 'running...', '', 'Waiting for result...', 'Running...', 'null', 'running');
    setPanelState('b', modelB, 'running...', '', 'Waiting for result...', 'Running...', 'null', 'running');

    try {
        const result = await fetchJson('/api/agentplayground/compare', {
            providerUrl,
            modelA,
            modelB,
            prompt,
            maxTokens: Number(state.selectedAgent?.maxTokens ?? 512),
        });

        const resultA = result.resultA;
        const resultB = result.resultB;

        setPanelState(
            'a',
            resultA.model || modelA,
            'done',
            'done',
            resultA.revisedMessage || '(empty)',
            renderPrettyDiff(original, resultA.revisedMessage || ''),
            normalizeReasoningText(resultA.reasoning),
        );
        setPanelState(
            'b',
            resultB.model || modelB,
            'done',
            'done',
            resultB.revisedMessage || '(empty)',
            renderPrettyDiff(original, resultB.revisedMessage || ''),
            normalizeReasoningText(resultB.reasoning),
        );

        syncHeaderPills();
        setStatus('Comparison complete.');
    } catch (error) {
        console.error('[Agent Playground] Comparison failed', error);
        setStatus(String(error?.message || error || 'Comparison failed.'));
        setPanelState('a', modelA || 'Model A', 'error', '', 'Failed to run.', escapeHtml(String(error?.message || error || 'Compare failed.')), 'null', 'error');
        setPanelState('b', modelB || 'Model B', 'error', '', 'Failed to run.', escapeHtml(String(error?.message || error || 'Compare failed.')), 'null', 'error');
    } finally {
        $('agentplayground_run').disabled = false;
    }
}

async function refreshSelectionState() {
    state.selectedChatKey = $('agentplayground_chat').value;
    state.selectedAgentId = $('agentplayground_agent').value;
    await loadSelectedChat();
    updateContextPreview();
}

function bindConfigInputs() {
    ['agentplayground_provider_url', 'agentplayground_model_a', 'agentplayground_model_b'].forEach(id => {
        $(id).addEventListener('input', syncHeaderPills);
    });
}

async function init() {
    await ensureCsrfToken();
    await loadSettings();
    await loadCharacters();
    await loadChats();
    await loadServerConfig();
    populateChatSelect();
    populateAgentSelect();
    bindConfigInputs();

    $('agentplayground_chat').addEventListener('change', refreshSelectionState);
    $('agentplayground_agent').addEventListener('change', refreshSelectionState);
    $('agentplayground_run').addEventListener('click', runComparison);
    $('agentplayground_save_config').addEventListener('click', saveServerConfig);

    await refreshSelectionState();
}

init().catch((error) => {
    console.error('[Agent Playground] Failed to initialize', error);
    setStatus(String(error?.message || error || 'Failed to initialize.'));
});
