import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from '../constants.js';
import { SECRET_KEYS, readSecret, writeSecret, deleteSecret } from './secrets.js';

export const router = express.Router();

const PLAYGROUND_SETTINGS_PATH = ['extension_settings', 'rayasAgentPlayground'];
const PLAYGROUND_LEGACY_SETTINGS_PATH = ['rayasAgentPlayground'];

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

function getPlaygroundConfig(settings) {
    return getNestedValue(settings, PLAYGROUND_SETTINGS_PATH, null)
        ?? getNestedValue(settings, PLAYGROUND_LEGACY_SETTINGS_PATH, null)
        ?? {};
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

function stripThinkBlocks(text) {
    return String(text ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .trim();
}

function parsePlaygroundResponse(rawText) {
    const text = String(rawText ?? '').trim();
    const empty = {
        revisedMessage: '',
        reasoning: null,
        rawText: text,
        parsedJson: null,
    };

    if (!text) {
        return empty;
    }

    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenceMatch ? fenceMatch[1] : text;

    try {
        const parsed = JSON.parse(candidate);
        const revisedMessage = stripThinkBlocks(parsed?.revised_message ?? parsed?.message ?? parsed?.content ?? '');
        const reasoning = parsed?.reasoning ?? parsed?.thinking ?? null;
        return {
            revisedMessage,
            reasoning: Array.isArray(reasoning) ? reasoning.join('\n') : reasoning,
            rawText: text,
            parsedJson: parsed,
        };
    } catch {
        return {
            ...empty,
            revisedMessage: stripThinkBlocks(text),
        };
    }
}

async function runModelRequest({ providerUrl, apiKey, model, prompt, maxTokens }) {
    const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
    };

    if (Number(maxTokens) > 0) {
        body.max_tokens = Number(maxTokens);
    }

    const response = await fetch(normalizeProviderUrl(providerUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    const responseText = await response.text();

    if (!response.ok) {
        throw new Error(responseText || `Provider request failed with ${response.status}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(responseText);
    } catch {
        parsed = null;
    }

    const content = parsed?.choices?.[0]?.message?.content
        ?? parsed?.choices?.[0]?.text
        ?? parsed?.content
        ?? responseText;
    const reasoning = parsed?.choices?.[0]?.message?.reasoning
        ?? parsed?.choices?.[0]?.reasoning
        ?? parsed?.reasoning
        ?? parsed?.reasoning_content
        ?? null;

    const normalized = parsePlaygroundResponse(content);
    return {
        model,
        rawContent: String(content ?? ''),
        revisedMessage: normalized.revisedMessage,
        reasoning: normalized.reasoning ?? reasoning,
        parsedJson: normalized.parsedJson,
    };
}

router.post('/config/get', (request, response) => {
    try {
        const { settings } = readSettingsObject(request);
        const config = getPlaygroundConfig(settings);

        return response.send({
            providerUrl: String(config?.providerUrl ?? ''),
            modelA: String(config?.modelA ?? ''),
            modelB: String(config?.modelB ?? ''),
            hasApiKey: Boolean(readSecret(request.user.directories, SECRET_KEYS.AGENT_PLAYGROUND)),
        });
    } catch (error) {
        console.error('[Agent Playground] Failed to load config', error);
        return response.sendStatus(500);
    }
});

router.post('/config/save', (request, response) => {
    try {
        const providerUrl = String(request.body?.providerUrl ?? '').trim();
        const modelA = String(request.body?.modelA ?? '').trim();
        const modelB = String(request.body?.modelB ?? '').trim();
        const apiKey = typeof request.body?.apiKey === 'string' ? request.body.apiKey : '';

        const { pathToSettings, settings } = readSettingsObject(request);
        setNestedValue(settings, PLAYGROUND_SETTINGS_PATH, {
            providerUrl,
            modelA,
            modelB,
        });
        writeFileAtomicSync(pathToSettings, JSON.stringify(settings, null, 4), 'utf8');

        if (apiKey.trim()) {
            writeSecret(request.user.directories, SECRET_KEYS.AGENT_PLAYGROUND, apiKey.trim());
        }

        if (request.body?.clearApiKey === true) {
            deleteSecret(request.user.directories, SECRET_KEYS.AGENT_PLAYGROUND);
        }

        return response.send({ ok: true });
    } catch (error) {
        console.error('[Agent Playground] Failed to save config', error);
        return response.sendStatus(500);
    }
});

router.post('/compare', async (request, response) => {
    try {
        const { settings } = readSettingsObject(request);
        const config = getPlaygroundConfig(settings);
        const providerUrl = String(request.body?.providerUrl ?? config?.providerUrl ?? '').trim();
        const modelA = String(request.body?.modelA ?? config?.modelA ?? '').trim();
        const modelB = String(request.body?.modelB ?? config?.modelB ?? '').trim();
        const prompt = String(request.body?.prompt ?? '');
        const maxTokens = Number.isFinite(Number(request.body?.maxTokens))
            ? Math.max(0, Number(request.body.maxTokens))
            : 512;
        const apiKey = readSecret(request.user.directories, SECRET_KEYS.AGENT_PLAYGROUND);

        if (!providerUrl || !modelA || !modelB || !prompt || !apiKey) {
            return response.status(400).send({
                error: 'Missing provider URL, model IDs, prompt, or saved API key.',
            });
        }

        const [resultA, resultB] = await Promise.all([
            runModelRequest({ providerUrl, apiKey, model: modelA, prompt, maxTokens }),
            runModelRequest({ providerUrl, apiKey, model: modelB, prompt, maxTokens }),
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
