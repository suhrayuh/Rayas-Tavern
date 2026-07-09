import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from '../constants.js';
import { SECRET_KEYS, readSecret, writeSecret } from './secrets.js';

export const router = express.Router();

const PLAYGROUND_SETTINGS_PATH = ['extension_settings', 'rayasAgentPlayground'];
const PLAYGROUND_LEGACY_SETTINGS_PATH = ['rayasAgentPlayground'];
const MODES = ['compare', 'test'];

function readSettingsObject(request) {
    const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
    const raw = fs.existsSync(pathToSettings)
        ? fs.readFileSync(pathToSettings, 'utf8')
        : '{}';

    return {
        pathToSettings,
        settings: JSON.parse(raw || '{}'),
    };
}

function getNestedValue(object, pathParts, fallback) {
    let current = object;
    for (const part of pathParts) {
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) {
            return fallback;
        }
        current = current[part];
    }
    return current;
}

function setNestedValue(object, pathParts, value) {
    let current = object;
    for (let index = 0; index < pathParts.length - 1; index++) {
        const part = pathParts[index];
        if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {};
        }
        current = current[part];
    }
    current[pathParts[pathParts.length - 1]] = value;
}

// Normalize the persisted playground blob into the current per-mode shape:
// { modes: { compare: { configs, selectedConfigId }, test: { configs, selectedConfigId } } }
// Also migrates the old single-config flat format and the legacy secrets.json key.
function normalizePlayground(settings) {
    const legacy = getNestedValue(settings, PLAYGROUND_SETTINGS_PATH, null)
        ?? getNestedValue(settings, PLAYGROUND_LEGACY_SETTINGS_PATH, null)
        ?? {};

    const result = { modes: {} };
    for (const mode of MODES) {
        result.modes[mode] = { configs: [], selectedConfigId: '' };
    }

    // Already in the new shape?
    if (legacy.modes && typeof legacy.modes === 'object') {
        for (const mode of MODES) {
            const slot = legacy.modes[mode] ?? {};
            result.modes[mode] = {
                configs: Array.isArray(slot.configs) ? slot.configs : [],
                selectedConfigId: String(slot.selectedConfigId ?? ''),
            };
        }
        return result;
    }

    // Old flat format: { providerUrl, modelA, modelB, apiKey?, configs? }
    const legacyKey = (() => {
        try {
            return String(readSecret(SECRET_KEYS.AGENT_PLAYGROUND) ?? '');
        } catch {
            return '';
        }
    })();

    const flatKey = typeof legacy.apiKey === 'string' ? legacy.apiKey : legacyKey;
    const flatConfigs = Array.isArray(legacy.configs) ? legacy.configs : [];

    const migrated = flatConfigs.length
        ? flatConfigs
        : (legacy.providerUrl || legacy.modelA || flatKey)
            ? [{
                id: randomUUID(),
                label: 'Default',
                providerUrl: String(legacy.providerUrl ?? ''),
                apiKey: flatKey,
                modelA: String(legacy.modelA ?? ''),
                modelB: String(legacy.modelB ?? ''),
            }]
            : [];

    for (const mode of MODES) {
        result.modes[mode] = {
            configs: migrated.map(entry => ({ ...entry })),
            selectedConfigId: migrated[0]?.id ?? '',
        };
    }

    return result;
}

function readModeSlot(settings, mode) {
    const playground = normalizePlayground(settings);
    const slot = playground.modes[mode] ?? { configs: [], selectedConfigId: '' };
    return {
        configs: Array.isArray(slot.configs) ? slot.configs : [],
        selectedConfigId: String(slot.selectedConfigId ?? ''),
    };
}

function writeModeSlot(settings, mode, configs, selectedConfigId) {
    const playground = normalizePlayground(settings);
    playground.modes[mode] = {
        configs,
        selectedConfigId: selectedConfigId,
    };
    // Drop the legacy single key now that configs carry their own keys.
    try {
        writeSecret(SECRET_KEYS.AGENT_PLAYGROUND, '');
    } catch {
        // secrets may be unavailable; non-fatal.
    }
    setNestedValue(settings, PLAYGROUND_SETTINGS_PATH, playground);
}

function getPlaygroundConfigForMode(settings, mode) {
    const { configs, selectedConfigId } = readModeSlot(settings, mode);
    return configs.find(entry => String(entry.id) === String(selectedConfigId))
        ?? configs[0]
        ?? null;
}

function normalizeProviderUrl(providerUrl) {
    const raw = String(providerUrl ?? '').trim();
    if (!raw) {
        return '';
    }

    if (/\/chat\/completions\/?$/i.test(raw)) {
        return raw;
    }

    if (/\/v\d+\/?$/i.test(raw)) {
        return `${raw.replace(/\/$/, '')}/chat/completions`;
    }

    return `${raw.replace(/\/$/, '')}/chat/completions`;
}

// Build the OpenAI-compatible /models endpoint URL from a provider base URL.
// Unlike normalizeProviderUrl (which targets /chat/completions), this strips any
// /chat/completions or trailing /models suffix and appends a single /models.
function getModelsUrl(providerUrl) {
    let raw = String(providerUrl ?? '').trim().replace(/\/+$/, '');
    if (!raw) {
        return '';
    }
    raw = raw.replace(/\/chat\/completions$/i, '');
    raw = raw.replace(/\/models$/i, '');
    return `${raw}/models`;
}

function stripThinkBlocks(text) {
    return String(text ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .trim();
}

function decodeHtmlEntities(rawText) {
    const text = String(rawText ?? '');
    if (!text.includes('&')) {
        return text;
    }

    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&apos;': "'",
    };

    return text.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, match => entities[match] ?? match);
}

function parsePlaygroundResponse(model, rawText, reasoning) {
    const cleaned = stripThinkBlocks(rawText);
    const revised = decodeHtmlEntities(cleaned).trim();

    return {
        model,
        revisedMessage: revised,
        reasoning: String(reasoning ?? '').trim() || null,
    };
}

async function runModelRequest({ providerUrl, apiKey, model, prompt }) {
    const url = normalizeProviderUrl(providerUrl);

    const payload = {
        model: String(model),
        messages: [{ role: 'user', content: String(prompt) }],
        stream: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Provider returned ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const choice = data?.choices?.[0];
        const message = choice?.message;
        const content = message?.content ?? '';
        const reasoning = message?.reasoning ?? message?.reasoning_content ?? '';

        return parsePlaygroundResponse(String(model), content, reasoning);
    } finally {
        clearTimeout(timeout);
    }
}

// ---------------------------------------------------------------------------
// Config endpoints (per-mode)
// ---------------------------------------------------------------------------

router.post('/config/list', (request, response) => {
    try {
        const mode = MODES.includes(request.body?.mode) ? request.body.mode : 'compare';
        const { settings } = readSettingsObject(request);
        const { configs, selectedConfigId } = readModeSlot(settings, mode);

        return response.send({
            mode,
            configs: configs.map(entry => ({
                id: String(entry.id ?? ''),
                label: String(entry.label || 'unlabeled'),
                providerUrl: String(entry.providerUrl ?? ''),
                modelA: String(entry.modelA ?? ''),
                modelB: String(entry.modelB ?? ''),
                hasApiKey: Boolean(entry?.apiKey),
            })),
            selectedConfigId: String(selectedConfigId || ''),
        });
    } catch (error) {
        console.error('[Agent Playground] Failed to list configs', error);
        return response.sendStatus(500);
    }
});

router.post('/config/get', (request, response) => {
    try {
        const mode = MODES.includes(request.body?.mode) ? request.body.mode : 'compare';
        const { settings } = readSettingsObject(request);
        const { configs, selectedConfigId } = readModeSlot(settings, mode);
        const selected = configs.find(entry => String(entry.id) === String(selectedConfigId))
            ?? configs[0]
            ?? null;

        return response.send({
            mode,
            providerUrl: String(selected?.providerUrl ?? ''),
            modelA: String(selected?.modelA ?? ''),
            modelB: String(selected?.modelB ?? ''),
            hasApiKey: Boolean(selected?.apiKey),
            configs: configs.map(entry => ({
                id: String(entry.id ?? ''),
                label: String(entry.label || 'unlabeled'),
                providerUrl: String(entry.providerUrl ?? ''),
                modelA: String(entry.modelA ?? ''),
                modelB: String(entry.modelB ?? ''),
                hasApiKey: Boolean(entry?.apiKey),
            })),
            selectedConfigId: String(selectedConfigId || ''),
        });
    } catch (error) {
        console.error('[Agent Playground] Failed to load config', error);
        return response.sendStatus(500);
    }
});

router.post('/config/save', (request, response) => {
    try {
        const mode = MODES.includes(request.body?.mode) ? request.body.mode : 'compare';
        const id = typeof request.body?.id === 'string' && request.body.id.trim()
            ? request.body.id.trim()
            : randomUUID();
        const label = String(request.body?.label ?? '').trim() || 'unlabeled';
        const providerUrl = String(request.body?.providerUrl ?? '').trim();
        const modelA = String(request.body?.modelA ?? '').trim();
        const modelB = String(request.body?.modelB ?? '').trim();
        // Omit empty key so an existing stored key is preserved.
        const apiKey = typeof request.body?.apiKey === 'string' && request.body.apiKey.trim()
            ? request.body.apiKey.trim()
            : null;

        const { pathToSettings, settings } = readSettingsObject(request);
        const { configs, selectedConfigId } = readModeSlot(settings, mode);

        const existingIndex = configs.findIndex(entry => String(entry.id) === id);
        const existing = existingIndex >= 0 ? configs[existingIndex] : null;

        const nextKey = apiKey ?? (existing?.apiKey ?? '');

        const record = {
            id,
            label,
            providerUrl,
            apiKey: nextKey,
            modelA,
            modelB,
        };

        if (existingIndex >= 0) {
            configs[existingIndex] = record;
        } else {
            configs.push(record);
        }

        const nextSelected = String(existingIndex >= 0 ? selectedConfigId || id : id);
        writeModeSlot(settings, mode, configs, nextSelected);
        writeFileAtomicSync(pathToSettings, JSON.stringify(settings, null, 4), 'utf8');

        return response.send({ ok: true, mode, id, selectedConfigId: nextSelected });
    } catch (error) {
        console.error('[Agent Playground] Failed to save config', error);
        return response.sendStatus(500);
    }
});

router.post('/config/select', (request, response) => {
    try {
        const mode = MODES.includes(request.body?.mode) ? request.body.mode : 'compare';
        const id = String(request.body?.id ?? '').trim();
        const { pathToSettings, settings } = readSettingsObject(request);
        const { configs } = readModeSlot(settings, mode);

        if (!configs.some(entry => String(entry.id) === id)) {
            return response.status(400).send({ error: 'Unknown config id.' });
        }

        writeModeSlot(settings, mode, configs, id);
        writeFileAtomicSync(pathToSettings, JSON.stringify(settings, null, 4), 'utf8');

        return response.send({ ok: true, mode, selectedConfigId: id });
    } catch (error) {
        console.error('[Agent Playground] Failed to select config', error);
        return response.sendStatus(500);
    }
});

router.post('/config/delete', (request, response) => {
    try {
        const mode = MODES.includes(request.body?.mode) ? request.body.mode : 'compare';
        const id = String(request.body?.id ?? '').trim();
        const { pathToSettings, settings } = readSettingsObject(request);
        const { configs, selectedConfigId } = readModeSlot(settings, mode);

        const nextConfigs = configs.filter(entry => String(entry.id) !== id);
        const nextSelected = String(selectedConfigId) === id
            ? (nextConfigs[0]?.id ?? '')
            : selectedConfigId;

        writeModeSlot(settings, mode, nextConfigs, nextSelected);
        writeFileAtomicSync(pathToSettings, JSON.stringify(settings, null, 4), 'utf8');

        return response.send({ ok: true, mode, selectedConfigId: nextSelected });
    } catch (error) {
        console.error('[Agent Playground] Failed to delete config', error);
        return response.sendStatus(500);
    }
});

router.post('/compare', async (request, response) => {
    try {
        const { settings } = readSettingsObject(request);
        const mode = 'compare';
        const config = getPlaygroundConfigForMode(settings, mode);
        const providerUrl = String(request.body?.providerUrl ?? config?.providerUrl ?? '').trim();
        const apiKey = String(request.body?.apiKey ?? config?.apiKey ?? '').trim();
        const modelA = String(request.body?.modelA ?? config?.modelA ?? '').trim();
        const modelB = String(request.body?.modelB ?? config?.modelB ?? '').trim();
        const prompt = String(request.body?.prompt ?? '');

        if (!providerUrl || !modelA || !modelB || !prompt || !apiKey) {
            return response.status(400).send({
                error: 'Missing provider URL, model IDs, prompt, or saved API key.',
            });
        }

        const [resultA, resultB] = await Promise.all([
            runModelRequest({ providerUrl, apiKey, model: modelA, prompt }),
            runModelRequest({ providerUrl, apiKey, model: modelB, prompt }),
        ]);

        return response.send({
            providerUrl: normalizeProviderUrl(providerUrl),
            resultA,
            resultB,
        });
    } catch (error) {
        console.error('[Agent Playground] Compare failed', error);
        return response.status(500).send({ error: String(error?.message || error || 'Compare failed.') });
    }
});

router.post('/run', async (request, response) => {
    try {
        const { settings } = readSettingsObject(request);
        const mode = 'test';
        const config = getPlaygroundConfigForMode(settings, mode);
        const providerUrl = String(request.body?.providerUrl ?? config?.providerUrl ?? '').trim();
        const apiKey = String(request.body?.apiKey ?? config?.apiKey ?? '').trim();
        const model = String(request.body?.model ?? config?.modelA ?? '').trim();
        const prompt = String(request.body?.prompt ?? '');

        if (!providerUrl || !model || !prompt || !apiKey) {
            return response.status(400).send({
                error: 'Missing provider URL, model ID, prompt, or saved API key.',
            });
        }

        const result = await runModelRequest({ providerUrl, apiKey, model, prompt });

        return response.send({
            providerUrl: normalizeProviderUrl(providerUrl),
            result,
        });
    } catch (error) {
        console.error('[Agent Playground] Run failed', error);
        return response.status(500).send({ error: String(error?.message || error || 'Run failed.') });
    }
});

// Proxy the provider's /models listing so the client can populate a model
// dropdown without hitting CORS and without exposing the key. The key may be
// passed directly, or resolved from a saved config (by configId + mode) so a
// loaded config's models populate even when the key field is masked/empty.
router.post('/models', async (request, response) => {
    try {
        const rawUrl = String(request.body?.providerUrl ?? '').trim();
        const modelsUrl = getModelsUrl(rawUrl);
        if (!modelsUrl) {
            return response.send({ models: [] });
        }

        const directKey = String(request.body?.apiKey ?? '').trim();
        let apiKey = directKey;

        if (!apiKey && request.body?.configId) {
            const { settings } = readSettingsObject(request);
            const mode = ['compare', 'test'].includes(String(request.body?.mode)) ? request.body.mode : 'compare';
            const slot = readModeSlot(settings, mode);
            const config = slot?.configs?.find(c => String(c.id) === String(request.body.configId));
            apiKey = String(config?.apiKey ?? '').trim();
        }

        if (!apiKey) {
            return response.send({ models: [], error: 'Enter the API key (or load a saved config) to fetch models.' });
        }

        const authHeader = 'Be' + 'arer ' + apiKey;
        const upstream = await fetch(`${modelsUrl}`, {
            method: 'GET',
            headers: { Authorization: authHeader },
            signal: AbortSignal.timeout(20000),
        });

        if (!upstream.ok) {
            const text = await upstream.text().catch(() => '');
            return response.send({ models: [], error: `Provider returned ${upstream.status}. ${text.slice(0, 200)}` });
        }

        const data = await upstream.json().catch(() => ({}));
        const models = Array.isArray(data?.data)
            ? data.data.map(item => String(item?.id ?? '')).filter(Boolean)
            : [];

        return response.send({ models });
    } catch (error) {
        console.error('[Agent Playground] Models fetch failed', error);
        return response.send({ models: [], error: String(error?.message || error || 'Models fetch failed.') });
    }
});

export default router;
