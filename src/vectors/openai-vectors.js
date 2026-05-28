import fetch from 'node-fetch';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';
import { OPENROUTER_HEADERS } from '../constants.js';

const SOURCES = {
    'togetherai': {
        secretKey: SECRET_KEYS.TOGETHERAI,
        url: 'https://api.together.xyz/v1',
        model: 'togethercomputer/m2-bert-80M-32k-retrieval',
        headers: {},
        processBody: () => {},
    },
    'mistral': {
        secretKey: SECRET_KEYS.MISTRALAI,
        url: 'https://api.mistral.ai/v1',
        model: 'mistral-embed',
        headers: {},
        processBody: () => {},
    },
    'openai': {
        secretKey: SECRET_KEYS.OPENAI,
        url: 'https://api.openai.com/v1',
        model: 'text-embedding-ada-002',
        headers: {},
        processBody: () => {},
    },
    'custom': {
        secretKey: null,
        url: '',
        model: 'text-embedding-3-small',
        headers: {},
        processBody: () => {},
    },
    'electronhub': {
        secretKey: SECRET_KEYS.ELECTRONHUB,
        url: 'https://api.electronhub.ai/v1',
        model: 'text-embedding-3-small',
        headers: {},
        processBody: () => {},
    },
    'openrouter': {
        secretKey: SECRET_KEYS.OPENROUTER,
        url: 'https://openrouter.ai/api/v1',
        model: 'openai/text-embedding-3-large',
        headers: { ...OPENROUTER_HEADERS },
        processBody: () => {},
    },
    'chutes': {
        secretKey: SECRET_KEYS.CHUTES,
        url: 'https://{{MODEL}}.chutes.ai/v1',
        model: 'chutes-qwen-qwen3-embedding-8b',
        headers: {},
        processBody: (body) => {
            body.model = null;
        },
    },
    'nanogpt': {
        secretKey: SECRET_KEYS.NANOGPT,
        url: 'https://nano-gpt.com/api/v1',
        model: 'text-embedding-3-small',
        headers: {},
        processBody: () => {},
    },
    'siliconflow': {
        secretKey: SECRET_KEYS.SILICONFLOW,
        url: 'https://api.siliconflow.com/v1',
        model: 'Qwen/Qwen3-Embedding-0.6B',
        headers: {},
        processBody: () => {},
    },
    'workers_ai': {
        secretKey: SECRET_KEYS.WORKERS_AI,
        url: '', // Constructed at runtime from account ID via urlOverride
        model: '@cf/baai/bge-m3',
        headers: {},
        processBody: () => {},
    },
};

function resolveEmbeddingsUrl(baseUrl) {
    if (!baseUrl) {
        return baseUrl;
    }

    return /\/embeddings\/?$/i.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/embeddings`;
}

/**
 * Gets the vector for the given text batch from an OpenAI compatible endpoint.
 * @param {string[]} texts - The array of texts to get the vector for
 * @param {string} source - The source of the vector
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {string} model - The model to use for the embedding
 * @param {string|null} urlOverride - Optional URL override for the API endpoint
 * @param {string|null} apiKeyOverride - Optional API key override for the request
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
export async function getOpenAIBatchVector(texts, source, directories, model = '', urlOverride = null, apiKeyOverride = null) {
    const config = SOURCES[source];

    if (!config) {
        console.error('Unknown source', source);
        throw new Error('Unknown source');
    }

    const key = apiKeyOverride || (config.secretKey ? readSecret(directories, config.secretKey) : null);

    if (!key && source !== 'custom') {
        console.warn('No API key found');
        throw new Error('No API key found');
    }

    const modelName = model || config.model;
    const url = urlOverride || config.url?.replace('{{MODEL}}', modelName);

    if (!url) {
        throw new Error(`No API URL configured for source ${source}`);
    }

    const body = {
        input: texts,
        model: modelName,
    };

    if (typeof config.processBody === 'function') {
        config.processBody(body);
    }

    const resolvedUrl = resolveEmbeddingsUrl(url);

    const response = await fetch(resolvedUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...config.headers,
            ...(key ? { 'Authorization': `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        console.warn(`[Vectors] API request failed (source=${source}, model=${modelName}, url=${resolvedUrl}):`, response.status, response.statusText, text);
        throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    /** @type {any} */
    const data = await response.json();

    // Detect error responses that came with HTTP 200 (common with proxies/OpenRouter)
    if (data?.error) {
        const errMsg = data.error.message || data.error.code || JSON.stringify(data.error);
        console.warn(`[Vectors] Upstream returned error in response body (source=${source}, model=${modelName}):`, errMsg);
        throw new Error(`Upstream embedding error: ${errMsg}`);
    }

    // OpenAI format: { data: [{ embedding: [...], index: N }] }
    if (Array.isArray(data?.data) && data.data[0]?.embedding) {
        data.data.sort((a, b) => a.index - b.index);
        return data.data.map(x => x.embedding);
    }

    // Google AI Studio / Gemini format: { embeddings: [{ values: [...] }] }
    if (Array.isArray(data?.embeddings) && data.embeddings[0]?.values) {
        return data.embeddings.map(x => x.values);
    }

    // Google Vertex AI format: { predictions: [{ embeddings: { values: [...] } }] }
    if (Array.isArray(data?.predictions) && data.predictions[0]?.embeddings?.values) {
        return data.predictions.map(x => x.embeddings.values);
    }

    // Single embedding wrapped in object: { embedding: [...] }
    if (Array.isArray(data?.embedding)) {
        return [data.embedding];
    }

    // Flat array of numbers (single text input, raw vector response)
    if (Array.isArray(data) && typeof data[0] === 'number') {
        return [data];
    }

    console.warn('API response was not in a recognized embedding format. Keys:', Object.keys(data || {}));
    throw new Error('API response was not in a recognized embedding format');
}

/**
 * Gets the vector for the given text from an OpenAI compatible endpoint.
 * @param {string} text - The text to get the vector for
 * @param {string} source - The source of the vector
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {string} model - The model to use for the embedding
 * @param {string|null} urlOverride - Optional URL override for the API endpoint
 * @param {string|null} apiKeyOverride - Optional API key override for the request
 * @returns {Promise<number[]>} - The vector for the text
 */
export async function getOpenAIVector(text, source, directories, model = '', urlOverride = null, apiKeyOverride = null) {
    const vectors = await getOpenAIBatchVector([text], source, directories, model, urlOverride, apiKeyOverride);
    return vectors[0];
}
