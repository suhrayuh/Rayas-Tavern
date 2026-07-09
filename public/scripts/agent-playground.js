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
    applyPatches,
} from './agent-playground-core.js';

const state = {
    csrfToken: '',
    settings: null,
    chats: [],
    allChats: [],
    groups: [],
    characters: [],
    charactersByAvatar: new Map(),
    selectedCharacterAvatar: '',
    selectedChatKey: '',
    selectedAgentId: '',
    selectedChatMessages: [],
    selectedAgent: null,
    currentMessageId: null,
    selectedCharacter: null,
    selectedGroup: null,
    configs: [],
    selectedConfigId: '',
    modelsA: [],
    modelsB: [],
    mode: 'compare', // 'compare' | 'test'
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
        ? 'API key saved in config.'
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

// ---------------------------------------------------------------------------
// Configs (per-mode, named, each carries its own API key)
// ---------------------------------------------------------------------------

async function loadConfigs() {
    const result = await fetchJson('/api/agentplayground/config/list', { mode: state.mode });
    state.configs = Array.isArray(result.configs) ? result.configs : [];
    state.selectedConfigId = String(result.selectedConfigId || '');
    renderConfigSelect();
    applySelectedConfigToForm();
}

function renderConfigSelect() {
    const select = $('agentplayground_config_select');
    select.innerHTML = '';

    if (!state.configs.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No saved configs';
        select.appendChild(option);
    }

    for (const config of state.configs) {
        const option = document.createElement('option');
        option.value = config.id;
        const models = state.mode === 'test'
            ? (config.modelA || '')
            : [config.modelA, config.modelB].filter(Boolean).join(' + ');
        option.textContent = `${config.label} — ${models || '(no models)'}`;
        select.appendChild(option);
    }

    select.value = state.selectedConfigId;
    $('agentplayground_delete_config').disabled = !state.configs.length;
}

async function applySelectedConfigToForm() {
    const config = state.configs.find(entry => String(entry.id) === state.selectedConfigId) ?? null;
    $('agentplayground_config_label').value = config?.label && config.label !== 'unlabeled' ? config.label : '';
    $('agentplayground_provider_url').value = config?.providerUrl || '';
    $('agentplayground_provider_key').value = ''; // never echo the key back
    setKeyState(Boolean(config?.hasApiKey));
    syncHeaderPills();
    // Populate the model combobox lists BEFORE setting the saved model values,
    // so the <input> retains the selection instead of being cleared (a <select>
    // with no matching option would wipe it).
    await refreshModelLists();
    $('agentplayground_model_a').value = config?.modelA || '';
    $('agentplayground_model_b').value = config?.modelB || '';
}

async function saveCurrentConfig() {
    const id = state.selectedConfigId;
    const keyField = $('agentplayground_provider_key').value.trim();
    const payload = {
        mode: state.mode,
        id: id || undefined,
        label: $('agentplayground_config_label').value.trim() || 'unlabeled',
        providerUrl: $('agentplayground_provider_url').value.trim(),
        modelA: $('agentplayground_model_a').value.trim(),
        modelB: $('agentplayground_model_b').value.trim(),
        // Omit when empty so the server preserves the stored key.
        apiKey: keyField || undefined,
    };

    const result = await fetchJson('/api/agentplayground/config/save', payload);
    state.selectedConfigId = String(result.selectedConfigId || id || '');
    await loadConfigs();
    setStatus('Config saved.');
}

async function selectConfig() {
    const id = $('agentplayground_config_select').value;
    state.selectedConfigId = id;
    if (id) {
        await fetchJson('/api/agentplayground/config/select', { mode: state.mode, id });
    }
    applySelectedConfigToForm();
}

async function deleteCurrentConfig() {
    if (!state.selectedConfigId) {
        return;
    }
    const result = await fetchJson('/api/agentplayground/config/delete', { mode: state.mode, id: state.selectedConfigId });
    state.selectedConfigId = String(result.selectedConfigId || '');
    await loadConfigs();
    setStatus('Config deleted.');
}

async function startNewConfig() {
    state.selectedConfigId = '';
    $('agentplayground_config_select').value = '';
    $('agentplayground_config_label').value = '';
    $('agentplayground_provider_url').value = '';
    $('agentplayground_model_a').value = '';
    $('agentplayground_model_b').value = '';
    $('agentplayground_provider_key').value = '';
    setKeyState(false);
    syncHeaderPills();
}

// ---------------------------------------------------------------------------
// Mode (compare | test)
// ---------------------------------------------------------------------------

function setMode(mode) {
    const previous = state.mode;
    state.mode = mode;
    const isTest = mode === 'test';

    $('agentplayground_mode_compare').classList.toggle('is-active', !isTest);
    $('agentplayground_mode_test').classList.toggle('is-active', isTest);
    $('agentplayground_config').classList.toggle('is-test', isTest);

    $('agentplayground_model_b_field').classList.toggle('displayNone', isTest);
    $('agentplayground_panel_b').classList.toggle('displayNone', isTest);
    $('agentplayground_top_model_b_pill').classList.toggle('displayNone', isTest);
    $('agentplayground_panels').classList.toggle('is-single', isTest);
    $('agentplayground_model_a_label').textContent = isTest ? 'Model' : 'Model A';
    $('agentplayground_run').textContent = isTest ? '▶ Run' : '▶ Run Both';

    if (previous !== mode) {
        // Switching modes loads that mode's own saved configs.
        loadConfigs();
    }
    syncHeaderPills();
}

// ---------------------------------------------------------------------------
// Characters (custom combobox with engraved search) + chats
// ---------------------------------------------------------------------------

async function loadCharacters() {
    const characters = await fetchJson('/api/characters/all', {});
    const list = (Array.isArray(characters) ? characters : [])
        .filter(character => character?.avatar)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    state.characters = list;
    state.charactersByAvatar = new Map(list.map(character => [String(character.avatar), character]));
}

async function loadAllChats() {
    // Chats are loaded per-character on demand via /characters/chats (all chats, no cap).
    state.groups = await fetchJson('/api/groups/all', {});
    state.groups = Array.isArray(state.groups) ? state.groups : [];
    state.allChats = [];
    state.chats = [];
}

async function loadChatsForCharacter(avatar) {
    const av = String(avatar);
    const entries = await fetchJson('/api/characters/chats', { avatar_url: av, metadata: true });
    const chats = (Array.isArray(entries) ? entries : []).map((entry) => {
        const fileId = String(entry.file_name ?? '').replace(/\.jsonl$/i, '');
        return {
            key: `char:${av}:${fileId}`,
            type: 'character',
            file_id: fileId,
            avatar: av,
            groupId: null,
            characterTitle: state.charactersByAvatar.get(av)?.name || av,
            chatTitle: fileId, // no stripping — show the raw chat file name exactly
        };
    });

    // Most recent first (mirrors characterlibrary ordering).
    chats.sort((a, b) => {
        const da = new Date(b.last_mes || 0).getTime();
        const db = new Date(a.last_mes || 0).getTime();
        return Number.isFinite(da) && Number.isFinite(db) ? da - db : 0;
    });

    state.chats = chats;

    if (!state.chats.length) {
        state.filterNote = 'No saved chats for this character yet.';
    } else {
        const name = state.charactersByAvatar.get(av)?.name || 'character';
        state.filterNote = `Showing ${state.chats.length} chat(s) for ${name}.`;
    }

    state.selectedChatKey = state.chats.length ? state.chats[0].key : '';
}

function getOpenCharacterAvatar() {
    const params = new URLSearchParams(window.location.search);
    return params.get('avatar') || '';
}

function openCharacterCombobox() {
    const list = $('agentplayground_character_list');
    renderCharacterOptions($('agentplayground_character').value);
    list.classList.remove('displayNone');
}

function renderCharacterOptions(query) {
    const list = $('agentplayground_character_list');
    const q = query.trim().toLowerCase();
    const matches = state.characters.filter(c => !q || String(c.name || '').toLowerCase().includes(q));

    list.innerHTML = '';
    if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'ap-combo-empty';
        empty.textContent = 'No characters found.';
        list.appendChild(empty);
        return;
    }

    for (const character of matches) {
        const option = document.createElement('div');
        option.className = 'ap-combo-option';
        option.dataset.avatar = String(character.avatar);
        option.textContent = String(character.name || character.avatar);
        if (String(character.avatar) === state.selectedCharacterAvatar) {
            option.classList.add('is-active');
        }
        option.addEventListener('mousedown', (event) => {
            event.preventDefault();
            chooseCharacter(String(character.avatar));
        });
        list.appendChild(option);
    }
}

async function chooseCharacter(avatar) {
    state.selectedCharacterAvatar = avatar;
    const character = state.charactersByAvatar.get(avatar);
    $('agentplayground_character').value = character?.name || avatar;
    $('agentplayground_character_list').classList.add('displayNone');
    await loadChatsForCharacter(avatar);
    populateChatSelect();
    refreshSelectionState();
}

function getSelectedCharacterAvatar() {
    return state.selectedCharacterAvatar || '';
}

function populateChatSelect() {
    const select = $('agentplayground_chat');
    select.innerHTML = '';

    for (const chatEntry of state.chats) {
        const option = document.createElement('option');
        option.value = chatEntry.key;
        option.textContent = `[Chat] ${chatEntry.chatTitle}`;
        select.appendChild(option);
    }

    if (state.chats.length) {
        select.value = state.selectedChatKey;
    }

    const note = $('agentplayground_chat_note');
    if (note) {
        note.textContent = state.filterNote || '';
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
    $('agentplayground_top_chat').textContent = selectedChat?.chatTitle || 'No chat selected';
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

function setPanelState(side, label, badgeText, badgeClass, output, diffHtml, reasoning, stateClass) {
    $(`agentplayground_profile_${side}_title`).textContent = label;
    const badge = $(`agentplayground_profile_${side}_meta`);
    badge.textContent = badgeText;
    badge.className = `ap-panel-badge${badgeClass ? ` ${badgeClass}` : ''}`;
    $(`agentplayground_diff_${side}`).innerHTML = diffHtml;
    const reasoningNode = $(`agentplayground_reasoning_${side}`);
    reasoningNode.textContent = reasoning;
    reasoningNode.className = reasoning === 'null' ? 'ap-reasoning-empty' : '';
}

async function runPlayground() {
    if (!state.selectedAgent || !Number.isInteger(state.currentMessageId)) {
        setStatus('Select a chat and a valid assistant message first.');
        return;
    }

    const providerUrl = $('agentplayground_provider_url').value.trim();
    const modelA = $('agentplayground_model_a').value.trim();
    const modelB = $('agentplayground_model_b').value.trim();
    const keyField = $('agentplayground_provider_key').value.trim();
    const context = buildCurrentContext();
    const original = getFallbackAssistantText(state.selectedChatMessages[state.currentMessageId]);
    const prompt = buildAgentPrompt(state.selectedAgent, context);
    const apiKey = keyField || undefined; // omit empty -> server uses stored key

    if (state.mode === 'compare') {
        if (!providerUrl || !modelA || !modelB) {
            setStatus('Save provider URL and both model IDs first.');
            return;
        }
    } else {
        if (!providerUrl || !modelA) {
            setStatus('Save provider URL and a model ID first.');
            return;
        }
    }

    $('agentplayground_run').disabled = true;
    setStatus(state.mode === 'compare' ? 'Running both models...' : 'Running model...');

    try {
        if (state.mode === 'compare') {
            setPanelState('a', modelA, 'running...', '', 'Waiting for result...', 'Running...', 'null', 'running');
            setPanelState('b', modelB, 'running...', '', 'Waiting for result...', 'Running...', 'null', 'running');

            const result = await fetchJson('/api/agentplayground/compare', {
                providerUrl,
                apiKey,
                modelA,
                modelB,
                prompt,
            });

            applyResult('a', result.resultA, original, modelA);
            applyResult('b', result.resultB, original, modelB);
        } else {
            setPanelState('a', modelA, 'running...', '', 'Waiting for result...', 'Running...', 'null', 'running');

            const result = await fetchJson('/api/agentplayground/run', {
                providerUrl,
                apiKey,
                model: modelA,
                prompt,
            });

            applyResult('a', result.result, original, modelA);
        }

        syncHeaderPills();
        setStatus(state.mode === 'compare' ? 'Comparison complete.' : 'Run complete.');
    } catch (error) {
        console.error('[Agent Playground] Run failed', error);
        setStatus(String(error?.message || error || 'Run failed.'));
        setPanelState('a', modelA || 'Model A', 'error', '', 'Failed to run.', escapeHtml(String(error?.message || error || 'Run failed.')), 'null', 'error');
        if (state.mode === 'compare') {
            setPanelState('b', modelB || 'Model B', 'error', '', 'Failed to run.', escapeHtml(String(error?.message || error || 'Run failed.')), 'null', 'error');
        }
    } finally {
        $('agentplayground_run').disabled = false;
    }
}

function applyResult(side, result, original, fallbackModel) {
    if (!result) {
        setPanelState(side, fallbackModel, 'error', '', 'No result.', 'No result.', 'null', 'error');
        return;
    }

    const isPatchMode = state.selectedAgent?.outputMode?.type === 'patch';
    // For patch-mode agents the model returns a JSON diff, not the revised text.
    // Merge the patches onto the original so the diff renders the full revised prose.
    const revisedForDisplay = isPatchMode
        ? applyPatches(original, result.revisedMessage)
        : (result.revisedMessage || '');

    setPanelState(
        side,
        result.model || fallbackModel,
        'done',
        'done',
        revisedForDisplay || '(empty)',
        renderPrettyDiff(original, revisedForDisplay),
        normalizeReasoningText(result.reasoning),
    );
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

    // Debounced: refresh the model dropdowns when the provider URL or key changes.
    let debounce;
    const onChange = () => {
        clearTimeout(debounce);
        debounce = setTimeout(refreshModelLists, 400);
    };
    $('agentplayground_provider_url').addEventListener('input', onChange);
    $('agentplayground_provider_key').addEventListener('input', onChange);
    $('agentplayground_provider_url').addEventListener('change', refreshModelLists);
    $('agentplayground_provider_key').addEventListener('change', refreshModelLists);
}

// Fetch the provider's model list (proxied server-side to avoid CORS and reuse
// the stored key) and cache it on state. The Model A / Model B fields are custom
// comboboxes (input + dropdown list) so the user can also type a custom id.
async function refreshModelLists() {
    const providerUrl = $('agentplayground_provider_url').value.trim();
    if (!providerUrl) {
        state.modelsA = [];
        state.modelsB = [];
        return;
    }
    const directKey = $('agentplayground_provider_key').value.trim();
    const payload = {
        providerUrl,
        mode: state.mode,
        configId: directKey ? undefined : state.selectedConfigId || undefined,
        apiKey: directKey || undefined,
    };

    let models = [];
    let errorMsg = '';
    try {
        const data = await fetchJson('/api/agentplayground/models', payload);
        models = Array.isArray(data?.models) ? data.models : [];
        errorMsg = data?.error || '';
    } catch (err) {
        errorMsg = String(err?.message || err || 'Failed to fetch models.');
    }

    console.log('[Agent Playground] models fetched:', models.length, errorMsg ? `(${errorMsg})` : '');
    state.modelsA = models;
    state.modelsB = models;

    // Re-render either open combobox with the fresh list.
    if (!$('agentplayground_model_a_list').classList.contains('displayNone')) {
        renderModelOptions('a', $('agentplayground_model_a').value);
    }
    if (!$('agentplayground_model_b_list').classList.contains('displayNone')) {
        renderModelOptions('b', $('agentplayground_model_b').value);
    }

    if (errorMsg && !models.length) {
        setStatus(errorMsg);
    }
}

function openModelCombobox(which) {
    renderModelOptions(which, $(`agentplayground_model_${which}`).value);
    $(`agentplayground_model_${which}_list`).classList.remove('displayNone');
}

function renderModelOptions(which, query) {
    const list = $(`agentplayground_model_${which}_list`);
    const models = state[`models${which.toUpperCase()}`] || [];
    const q = String(query || '').trim().toLowerCase();
    const matches = models.filter(id => !q || id.toLowerCase().includes(q));

    list.innerHTML = '';
    if (!models.length) {
        const empty = document.createElement('div');
        empty.className = 'ap-combo-empty';
        empty.textContent = 'No models loaded — enter the API key or load a saved config.';
        list.appendChild(empty);
        return;
    }
    if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'ap-combo-empty';
        empty.textContent = 'No models match your search.';
        list.appendChild(empty);
        return;
    }

    for (const id of matches) {
        const option = document.createElement('div');
        option.className = 'ap-combo-option';
        option.textContent = id;
        if (id === $(`agentplayground_model_${which}`).value) {
            option.classList.add('is-active');
        }
        option.addEventListener('mousedown', (event) => {
            event.preventDefault();
            $(`agentplayground_model_${which}`).value = id;
            $(`agentplayground_model_${which}_list`).classList.add('displayNone');
            syncHeaderPills();
        });
        list.appendChild(option);
    }
}

async function init() {
    await ensureCsrfToken();
    await loadSettings();
    await loadCharacters();
    await loadAllChats();
    await loadConfigs();

    // Preselect the character the launcher passed (currently open in ST).
    const openAvatar = getOpenCharacterAvatar();
    state.selectedCharacterAvatar = openAvatar && state.characters.some(c => String(c.avatar) === String(openAvatar))
        ? openAvatar
        : state.characters[0]?.avatar || '';
    $('agentplayground_character').value = state.charactersByAvatar.get(state.selectedCharacterAvatar)?.name || '';

    await loadChatsForCharacter(getSelectedCharacterAvatar());
    populateChatSelect();
    populateAgentSelect();
    bindConfigInputs();
    setMode(state.mode);

    const charInput = $('agentplayground_character');
    charInput.addEventListener('focus', openCharacterCombobox);
    charInput.addEventListener('input', () => {
        renderCharacterOptions(charInput.value);
        $('agentplayground_character_list').classList.remove('displayNone');
    });
    charInput.addEventListener('blur', () => {
        // Delay so a mousedown selection can register first.
        setTimeout(() => $('agentplayground_character_list').classList.add('displayNone'), 120);
    });

    // Model A / B custom comboboxes (typable + dropdown of fetched models).
    for (const which of ['a', 'b']) {
        const input = $(`agentplayground_model_${which}`);
        input.addEventListener('focus', () => openModelCombobox(which));
        input.addEventListener('input', () => {
            renderModelOptions(which, input.value);
            $(`agentplayground_model_${which}_list`).classList.remove('displayNone');
        });
        input.addEventListener('blur', () => {
            // Delay so a mousedown selection can register first.
            setTimeout(() => $(`agentplayground_model_${which}_list`).classList.add('displayNone'), 120);
        });
    }

    $('agentplayground_chat').addEventListener('change', refreshSelectionState);
    $('agentplayground_agent').addEventListener('change', refreshSelectionState);
    $('agentplayground_run').addEventListener('click', runPlayground);

    $('agentplayground_config_select').addEventListener('change', selectConfig);
    $('agentplayground_save_config').addEventListener('click', saveCurrentConfig);
    $('agentplayground_new_config').addEventListener('click', startNewConfig);
    $('agentplayground_delete_config').addEventListener('click', deleteCurrentConfig);

    $('agentplayground_mode_compare').addEventListener('click', () => setMode('compare'));
    $('agentplayground_mode_test').addEventListener('click', () => setMode('test'));

    await refreshSelectionState();
}

init().catch((error) => {
    console.error('[Agent Playground] Failed to initialize', error);
    setStatus(String(error?.message || error || 'Failed to initialize.'));
});
