import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import {
    getConfigValue,
    humanizedDateTime,
    tryParse,
    generateTimestamp,
    removeOldBackups,
    formatBytes,
    tryWriteFileSync,
    tryReadFileSync,
    tryDeleteFile,
    readFirstLine,
    isPathUnderParent,
} from '../util.js';
import { getDatabase, backupDatabase } from './sqlite-manager.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');

export const CHAT_BACKUPS_PREFIX = 'chat_';

/**
 * Saves a chat backup to the backups table.
 * @param {string} userId The user's handle.
 * @param {string} chatId The chat's id (e.g. 'char/charKey/fileName' or 'group/groupId').
 * @param {object[]} chatData The chat array.
 * @param {string} backupPrefix Typically CHAT_BACKUPS_PREFIX.
 */
function backupChat(userId, chatId, chatData, backupPrefix = CHAT_BACKUPS_PREFIX) {
    try {
        if (!isBackupEnabled) { return; }
        const db = getDatabase(userId);
        const now = Date.now();
        const version = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM backups WHERE chat_id = ?').get(chatId)?.v) || 1;
        db.prepare('INSERT INTO backups (chat_id, version, created_at, data, backup_type) VALUES (?, ?, ?, ?, ?)').run(
            chatId,
            version,
            now,
            JSON.stringify(chatData),
            'auto',
        );
        trimBackups(userId, chatId);
    } catch (err) {
        console.error(`Could not backup chat for ${chatId}`, err);
    }
}

/**
 * Trims old backups for a chat to respect maxTotalChatBackups.
 * @param {string} userId
 * @param {string} chatId
 */
function trimBackups(userId, chatId) {
    if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
        return;
    }
    const db = getDatabase(userId);
    const count = db.prepare('SELECT COUNT(*) AS c FROM backups WHERE chat_id = ?').get(chatId)?.c || 0;
    if (count > maxTotalChatBackups) {
        const toDelete = db.prepare('SELECT id FROM backups WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?').all(chatId, count - maxTotalChatBackups);
        for (const row of toDelete) {
            db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
        }
    }
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<typeof backupChat>>}
 */
const backupFunctions = new Map();

/**
 * Gets a debounced backup function for a user.
 * @param {string} userId
 * @returns {typeof backupChat}
 */
function getBackupFunction(userId) {
    if (!backupFunctions.has(userId)) {
        backupFunctions.set(userId, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(userId) || (() => { });
}

/**
 * Gets a preview message from a chat message string.
 * @param {string} [lastMessage] - The message to truncate
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewMessage(lastMessage) {
    const strlen = 400;

    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > strlen
        ? '...' + lastMessage.substring(lastMessage.length - strlen)
        : lastMessage;
}

process.on('exit', () => {
    for (const func of backupFunctions.values()) {
        func.flush();
    }
});

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string} Chat data
 */
function importOobaChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const arr of jsonData.data_visible) {
        if (arr[0]) {
            const userMessage = {
                name: userName,
                is_user: true,
                send_date: new Date().toISOString(),
                mes: arr[0],
                extra: {},
            };
            chat.push(userMessage);
        }
        if (arr[1]) {
            const charMessage = {
                name: characterName,
                is_user: false,
                send_date: new Date().toISOString(),
                mes: arr[1],
                extra: {},
            };
            chat.push(charMessage);
        }
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string} Chat data
 */
function importAgnaiChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.messages) {
        const isUser = !!message.userId;
        chat.push({
            name: isUser ? userName : characterName,
            is_user: isUser,
            send_date: new Date().toISOString(),
            mes: message.msg,
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string[]} Converted data
 */
function importCAIChat(userName, characterName, jsonData) {
    /**
     * Converts the chat data to suitable format.
     * @param {object} history Imported chat data
     * @returns {object[]} Converted chat data
     */
    function convert(history) {
        const starter = {
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        };

        const historyData = history.msgs.map((msg) => ({
            name: msg.src.is_human ? userName : characterName,
            is_user: msg.src.is_human,
            send_date: new Date().toISOString(),
            mes: msg.text,
            extra: {},
        }));

        return [starter, ...historyData];
    }

    const newChats = (jsonData.histories.histories ?? []).map(history => convert(history).map(obj => JSON.stringify(obj)).join('\n'));
    return newChats;
}

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {object} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @type {function(string): object} */
    function processKoboldMessage(msg) {
        const isUser = msg.includes(inputToken);
        return {
            name: isUser ? userName : characterName,
            is_user: isUser,
            mes: msg.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
            send_date: new Date().toISOString(),
            extra: {},
        };
    }

    // Create the header
    const userName = String(data.savedsettings.chatname);
    const characterName = String(data.savedsettings.chatopponent).split('||$||')[0];
    const header = {
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    };
    // Format messages
    const formattedMessages = data.actions.map(processKoboldMessage);
    // Add prompt if available
    if (data.prompt) {
        formattedMessages.unshift(processKoboldMessage(data.prompt));
    }
    // Combine header and messages
    const chatData = [header, ...formattedMessages];
    return chatData.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Flattens `msg` and `swipes` data from Chub Chat format.
 * Only changes enough to make it compatible with the standard chat serialization format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {string[]} lines serialised JSONL data
 * @returns {string} Converted data
 */
function flattenChubChat(userName, characterName, lines) {
    function flattenSwipe(swipe) {
        return swipe.message ? swipe.message : swipe;
    }

    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map(swipe => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return (lines ?? []).map(convert).join('\n');
}

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Imported chat data
 * @returns {string} Chat data
 */
function importRisuChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.data.message) {
        const isUser = message.role === 'user';
        chat.push({
            name: message.name ?? (isUser ? userName : characterName),
            is_user: isUser,
            send_date: new Date(Number(message.time ?? Date.now())).toISOString(),
            mes: message.data ?? '',
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Checks if the chat being saved has the same integrity as the one being loaded.
 * @param {string} chatId Chat id
 * @param {string} integritySlug Integrity slug
 * @param {string} userId User handle
 * @returns {Promise<boolean>} Whether the chat is intact
 */
async function checkChatIntegrity(chatId, integritySlug, userId) {
    const db = getDatabase(userId);
    const row = db.prepare('SELECT data FROM messages WHERE chat_id = ? AND ordinal = 0').get(chatId);
    if (!row) {
        return true;
    }
    const jsonData = tryParse(row.data);
    const chatIntegrity = jsonData?.chat_metadata?.integrity;

    if (!chatIntegrity) {
        console.debug(`Chat "${chatId}" does not have integrity metadata matching "${integritySlug}". The integrity validation has been skipped.`);
        return true;
    }

    return chatIntegrity === integritySlug;
}

/**
 * @typedef {Object} ChatInfo
 * @property {string} [file_id] - The chat id (last path segment)
 * @property {string} [file_name] - The chat id with .jsonl suffix (for client compat)
 * @property {string} [file_size] - Size of the chat in a human-readable format
 * @property {number} [chat_items] - Number of chat items
 * @property {string} [mes] - The last message
 * @property {number|string} [last_mes] - Timestamp of the last message
 * @property {object} [chat_metadata] - Additional chat metadata
 * @property {boolean} [match] - Whether the chat matches the search criteria
 */

/**
 * Reads chat info from the database.
 * @param {string} chatId Chat id
 * @param {object} additionalData Additional data to include
 * @param {boolean} withMetadata Whether to read chat metadata
 * @param {ChatMatchFunction|null} matcher Optional function to match messages
 * @param {string} userId User handle
 * @returns {Promise<ChatInfo>}
 *
 * @typedef {(textArray: string[]) => boolean} ChatMatchFunction
 */
export async function getChatInfo(chatId, additionalData = {}, withMetadata = false, matcher = null, userId = null) {
    return new Promise((res) => {
        // chatId is like "char/<folder>/<name>" — <name> may contain dots
        // (e.g. "GLM 5.2", "Mimo 2.5 Pro"). path.parse() would strip the
        // version suffix (treats ".5" as an extension), so extract the last
        // path segment directly to preserve the full chat name.
        const lastSegment = chatId.split('/').pop();
        const chatData = {
            match: false,
            file_id: lastSegment,
            file_name: lastSegment + '.jsonl',
            file_size: '0 B',
            chat_items: 0,
            mes: '[The chat is empty]',
            last_mes: 0,
            ...additionalData,
        };

        if (!userId) {
            res(chatData);
            return;
        }

        const db = getDatabase(userId);
        const rows = db.prepare('SELECT ordinal, data FROM messages WHERE chat_id = ? ORDER BY ordinal').all(chatId);

        if (rows.length === 0) {
            res({});
            return;
        }

        const messages = rows.map(r => tryParse(r.data)).filter(Boolean);
        chatData.chat_items = Math.max(0, messages.length - 1);
        chatData.file_size = formatBytes(JSON.stringify(messages).length);

        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.mes || lastMsg?.name || lastMsg?.chat_metadata) {
            chatData.mes = lastMsg.mes || '[The message is empty]';
            chatData.last_mes = lastMsg.send_date || new Date().toISOString();
        }

        if (withMetadata && messages[0]?.chat_metadata) {
            chatData.chat_metadata = messages[0].chat_metadata;
        }

        if (typeof matcher === 'function') {
            const textBuffer = messages.slice(1).map(m => m.mes || '');
            chatData.match = matcher(textBuffer);
        } else {
            chatData.match = true;
        }

        res(chatData);
    });
}

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
class IntegrityMismatchError extends Error {
    constructor(...params) {
        super(...params);
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, IntegrityMismatchError);
        }
        this.date = new Date();
    }
}

/**
 * Saves a chat to the database.
 * @param {Array} chatData The chat array to save.
 * @param {string} chatId Target chat id.
 * @param {boolean} skipIntegrityCheck If true, the chat's integrity will not be checked.
 * @param {string} handle The user's handle.
 * @param {string} cardName Passed to backupChat.
 * @param {string} backupDirectory Passed to backupChat (unused for DB backups, kept for compat).
 */
export async function trySaveChat(chatData, chatId, skipIntegrityCheck = false, handle, cardName, backupDirectory, skipBackup = false) {
    const doIntegrityCheck = (checkIntegrity && !skipIntegrityCheck);
    const chatIntegritySlug = doIntegrityCheck ? chatData?.[0]?.chat_metadata?.integrity : undefined;

    if (chatIntegritySlug && !await checkChatIntegrity(chatId, chatIntegritySlug, handle)) {
        throw new IntegrityMismatchError(`Chat integrity check failed for "${chatId}". The expected integrity slug was "${chatIntegritySlug}".`);
    }

    const db = getDatabase(handle);
    const now = Date.now();
    const isGroup = chatId.startsWith('group/');
    const characterKey = isGroup ? null : chatId.split('/')[1];
    const groupId = isGroup ? chatId.split('/')[1] : null;
    const metadata = JSON.stringify(chatData?.[0]?.chat_metadata ?? {});

    try {
        db.exec('BEGIN');
        db.prepare(`INSERT INTO chats (id, user_id, character_key, chat_type, group_id, created_at, updated_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at = ?, metadata = ?, character_key = ?, group_id = ?`).run(
            chatId, handle, characterKey, isGroup ? 'group' : 'character', groupId, now, now, metadata,
            now, metadata, characterKey, groupId,
        );

        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);

        const insertMsg = db.prepare('INSERT INTO messages (chat_id, ordinal, data, is_user, send_date) VALUES (?, ?, ?, ?, ?)');
        chatData.forEach((msg, ordinal) => {
            insertMsg.run(chatId, ordinal, JSON.stringify(msg), msg.is_user ? 1 : 0, msg.send_date || new Date().toISOString());
        });
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }

    if (!skipBackup) {
        getBackupFunction(handle)(handle, chatId, chatData);
    }
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        const chatId = `char/${cardName}/${sanitize(request.body.file_name)}`;

        if (Array.isArray(chatData)) {
            await trySaveChat(chatData, chatId, request.body.force, handle, cardName, request.user.directories.backups);
            return response.send({ ok: true });
        } else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/**
 * Gets the chat as an array.
 * @param {string} chatId The chat id.
 * @param {string} userId The user's handle.
 * @returns {Array} If the chatId cannot be read, this will return [].
 */
export function getChatData(chatId, userId) {
    const db = getDatabase(userId);
    const rows = db.prepare('SELECT data FROM messages WHERE chat_id = ? ORDER BY ordinal').all(chatId);
    if (rows.length === 0) {
        return [];
    }
    return rows.map(r => tryParse(r.data)).filter(Boolean);
}

router.post('/get', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const dirName = String(request.body.avatar_url).replace('.png', '');

        if (!request.body.file_name) {
            return response.send({});
        }

        const chatId = `char/${dirName}/${sanitize(request.body.file_name)}`;
        return response.send(getChatData(chatId, handle));
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }

        const handle = request.user.profile.handle;
        const isGroup = !!request.body.is_group;
        const prefix = isGroup ? 'group/' : `char/${String(request.body.avatar_url).replace('.png', '')}/`;
        const originalId = prefix + sanitize(String(request.body.original_file).replace('.jsonl', ''));
        const renamedId = prefix + sanitize(String(request.body.renamed_file).replace('.jsonl', ''));
        const sanitizedFileName = renamedId.split('/').pop();

        const db = getDatabase(handle);
        const exists = db.prepare('SELECT 1 FROM chats WHERE id = ?').get(originalId);
        const targetExists = db.prepare('SELECT 1 FROM chats WHERE id = ?').get(renamedId);

        if (!exists || targetExists) {
            console.error('Either Source or Destination chats are not available');
            return response.status(400).send({ error: true });
        }

        try {
            db.exec('PRAGMA foreign_keys = OFF;');
            db.exec('BEGIN');
            db.prepare('UPDATE messages SET chat_id = ? WHERE chat_id = ?').run(renamedId, originalId);
            db.prepare('UPDATE backups SET chat_id = ? WHERE chat_id = ?').run(renamedId, originalId);
            db.prepare('UPDATE chats SET id = ? WHERE id = ?').run(renamedId, originalId);
            db.exec('COMMIT');
            db.exec('PRAGMA foreign_keys = ON;');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }

        console.info('Successfully renamed chat.');
        return response.send({ ok: true, sanitizedFileName });
    } catch (error) {
        console.error('Error renaming chat:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = String(request.body.chatfile).replace('.jsonl', '');
        const chatId = `char/${dirName}/${sanitize(chatFileName)}`;

        const db = getDatabase(handle);
        const result = db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
        if (result.changes > 0) {
            return response.send({ ok: true });
        } else {
            console.error('The chat was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const handle = request.user.profile.handle;
    const isGroup = !!request.body.is_group;
    const prefix = isGroup ? 'group/' : `char/${String(request.body.avatar_url).replace('.png', '')}/`;
    const chatId = prefix + sanitize(String(request.body.file).replace('.jsonl', ''));

    const chatData = getChatData(chatId, handle);
    if (chatData.length === 0) {
        const errorMessage = {
            message: `Could not find chat to export. Source chat id: ${chatId}.`,
        };
        console.error(errorMessage.message);
        return response.status(404).json(errorMessage);
    }

    try {
        if (request.body.format === 'jsonl') {
            const rawFile = chatData.map(obj => JSON.stringify(obj)).join('\n');
            const successMessage = {
                message: `Chat saved to ${request.body.exportfilename}`,
                result: rawFile,
            };
            console.info(`Chat exported as ${request.body.exportfilename}`);
            return response.status(200).json(successMessage);
        }

        let buffer = '';
        for (const data of chatData) {
            if (data.is_system) {
                continue;
            }
            if (data.mes) {
                const name = data.name;
                const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                buffer += (`${name}: ${message}\n\n`);
            }
        }
        const successMessage = {
            message: `Chat saved to ${request.body.exportfilename}`,
            result: buffer,
        };
        console.info(`Chat exported as ${request.body.exportfilename}`);
        return response.status(200).json(successMessage);
    } catch (err) {
        console.error('chat export failed.', err);
        return response.sendStatus(400);
    }
});

router.post('/group/import', function (request, response) {
    try {
        const filedata = request.file;

        if (!filedata) {
            return response.sendStatus(400);
        }

        const handle = request.user.profile.handle;
        const chatname = humanizedDateTime();
        const pathToUpload = path.join(filedata.destination, filedata.filename);
        const chatId = `group/${chatname}`;
        const data = fs.readFileSync(pathToUpload, 'utf8');
        const chatData = data.split('\n').filter(l => l.trim()).map(l => tryParse(l)).filter(Boolean);
        fs.unlinkSync(pathToUpload);
        trySaveChat(chatData, chatId, true, handle, chatname, request.user.directories.backups);
        return response.send({ res: chatname });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/import', validateAvatarUrlMiddleware, function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const handle = request.user.profile.handle;
    const format = request.body.file_type;
    const avatarUrl = (request.body.avatar_url).replace('.png', '');
    const characterName = sanitize(request.body.character_name) || 'Character';
    const userName = sanitize(request.body.user_name) || 'User';
    const fileNames = [];

    if (!request.file) {
        return response.sendStatus(400);
    }

    const directoryPath = `char/${avatarUrl}`;
    if (!isPathUnderParent(request.user.directories.chats, path.join(request.user.directories.chats, avatarUrl))) {
        return response.sendStatus(400);
    }

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const data = fs.readFileSync(pathToUpload, 'utf8');

        if (format === 'json') {
            fs.unlinkSync(pathToUpload);
            const jsonData = JSON.parse(data);

            /** @type {function(string, string, object): string|string[]} */
            let importFunc;

            if (jsonData.savedsettings !== undefined) {
                importFunc = importKoboldLiteChat;
            } else if (jsonData.histories !== undefined) {
                importFunc = importCAIChat;
            } else if (Array.isArray(jsonData.data_visible)) {
                importFunc = importOobaChat;
            } else if (Array.isArray(jsonData.messages)) {
                importFunc = importAgnaiChat;
            } else if (jsonData.type === 'risuChat') {
                importFunc = importRisuChat;
            } else {
                console.error('Incorrect chat format .json');
                return response.send({ error: true });
            }

            const chat = importFunc(userName, characterName, jsonData);

            if (Array.isArray(chat)) {
                chat.forEach((c) => {
                    const fileName = `${characterName} - ${humanizedDateTime()} imported`;
                    const chatId = `${directoryPath}/${fileName}`;
                    fileNames.push(fileName);
                    trySaveChat(c.map(l => tryParse(l)).filter(Boolean), chatId, true, handle, characterName, request.user.directories.backups);
                });
            } else {
                const fileName = `${characterName} - ${humanizedDateTime()} imported`;
                const chatId = `${directoryPath}/${fileName}`;
                fileNames.push(fileName);
                trySaveChat(chat.split('\n').map(l => tryParse(l)).filter(Boolean), chatId, true, handle, characterName, request.user.directories.backups);
            }

            return response.send({ res: true, fileNames });
        }

        if (format === 'jsonl') {
            let lines = data.split('\n');
            const header = lines[0];
            const jsonData = JSON.parse(header);

            if (!(jsonData.user_name !== undefined || jsonData.name !== undefined || jsonData.chat_metadata !== undefined)) {
                console.error('Incorrect chat format .jsonl');
                return response.send({ error: true });
            }

            let flattenedChat = data;
            try {
                flattenedChat = flattenChubChat(userName, characterName, lines);
            } catch (error) {
                console.warn('Failed to flatten Chub Chat data: ', error);
            }

            const fileName = `${characterName} - ${humanizedDateTime()} imported`;
            const chatId = `${directoryPath}/${fileName}`;
            fileNames.push(fileName);
            const chatData = flattenedChat.split('\n').map(l => tryParse(l)).filter(Boolean);
            trySaveChat(chatData, chatId, true, handle, characterName, request.user.directories.backups);
            fs.unlinkSync(pathToUpload);
            response.send({ res: true, fileNames });
        }
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/group/get', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const handle = request.user.profile.handle;
    const chatId = `group/${request.body.id}`;
    return response.send(getChatData(chatId, handle));
});

router.post('/group/info', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const handle = request.user.profile.handle;
        const chatId = `group/${request.body.id}`;
        const chatInfo = await getChatInfo(chatId, {}, false, null, handle);
        return response.send(chatInfo);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/delete', (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const handle = request.user.profile.handle;
        const chatId = `group/${request.body.id}`;

        const db = getDatabase(handle);
        const result = db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
        if (result.changes > 0) {
            return response.send({ ok: true });
        } else {
            console.error('The group chat was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/save', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const handle = request.user.profile.handle;
        const chatId = `group/${request.body.id}`;
        const chatData = request.body.chat;

        if (Array.isArray(chatData)) {
            await trySaveChat(chatData, chatId, request.body.force, handle, String(request.body.id), request.user.directories.backups);
            return response.send({ ok: true });
        } else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;
        const handle = request.user.profile.handle;
        const db = getDatabase(handle);

        /** @type {string[]} */
        let chatIds = [];

        if (group_id) {
            const rows = db.prepare('SELECT id FROM chats WHERE user_id = ? AND chat_type = \'group\' AND group_id = ?').all(handle, group_id);
            chatIds = rows.map(r => r.id);
        } else {
            const character_name = avatar_url.replace('.png', '');
            const rows = db.prepare('SELECT id FROM chats WHERE user_id = ? AND chat_type = \'character\' AND character_key = ?').all(handle, character_name);
            chatIds = rows.map(r => r.id);
        }

        /**
         * @type {SearchChatResult[]}
         * @typedef {object} SearchChatResult
         * @property {string} [file_name] - The name of the chat file
         * @property {string} [file_size] - The size of the chat file in a human-readable format
         * @property {number} [message_count] - The number of messages in the chat
         * @property {number|string} [last_mes] - The timestamp of the last message
         * @property {string} [preview_message] - A preview of the last message
         */
        const results = [];

        /** @type {string[]} */
        const fragments = query ? query.trim().toLowerCase().split(/\s+/).filter(x => x) : [];

        /** @type {ChatMatchFunction} */
        const hasTextMatch = (textArray) => {
            if (fragments.length === 0) {
                return true;
            }
            return fragments.every(fragment => textArray.some(text => String(text ?? '').toLowerCase().includes(fragment)));
        };

        for (const chatId of chatIds) {
            const chatInfo = await getChatInfo(chatId, {}, false, query ? hasTextMatch : null, handle);
            const hasMatch = chatInfo.match || hasTextMatch([chatInfo.file_id ?? '']);

            if (!chatInfo.file_name) {
                continue;
            }

            if (query && chatInfo.chat_items === 0 && !hasMatch) {
                continue;
            }

            if (!query || hasMatch) {
                results.push({
                    file_name: chatInfo.file_id,
                    file_size: chatInfo.file_size,
                    message_count: chatInfo.chat_items,
                    last_mes: chatInfo.last_mes,
                    preview_message: getPreviewMessage(chatInfo.mes),
                });
            }
        }

        return response.send(results);
    } catch (error) {
        console.error('Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

router.post('/recent', async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const db = getDatabase(handle);

        /** @typedef {{pngFile?: string, groupId?: string, chatId: string, mtime: number}} ChatFile */
        /** @type {ChatFile[]} */
        const allChatFiles = [];

        // Character chats
        const charRows = db.prepare('SELECT id, character_key, updated_at FROM chats WHERE user_id = ? AND chat_type = \'character\'').all(handle);
        for (const row of charRows) {
            allChatFiles.push({ pngFile: `${row.character_key}.png`, chatId: row.id, mtime: row.updated_at });
        }

        // Group chats
        const groupRows = db.prepare('SELECT id, group_id, updated_at FROM chats WHERE user_id = ? AND chat_type = \'group\'').all(handle);
        for (const row of groupRows) {
            allChatFiles.push({ groupId: row.group_id, chatId: row.id, mtime: row.updated_at });
        }

        /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];

        const max = parseInt(request.body.max ?? Number.MAX_SAFE_INTEGER) + pinnedChats.length;
        const isPinned = (/** @type {ChatFile} */ chatFile) => pinnedChats.some(p => p.file_name === path.basename(chatFile.chatId) && (p.avatar === chatFile.pngFile || p.group === chatFile.groupId));
        const recentChats = allChatFiles.sort((a, b) => {
            const isAPinned = isPinned(a);
            const isBPinned = isPinned(b);

            if (isAPinned && !isBPinned) return -1;
            if (!isAPinned && isBPinned) return 1;

            return b.mtime - a.mtime;
        }).slice(0, max);
        const jsonFilesPromise = recentChats.map((file) => {
            const withMetadata = !!request.body.metadata;
            return file.groupId
                ? getChatInfo(file.chatId, { group: file.groupId }, withMetadata, null, handle)
                : getChatInfo(file.chatId, { avatar: file.pngFile }, withMetadata, null, handle);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
