import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync, default as writeFileAtomic } from 'write-file-atomic';

import { color, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { getDatabase } from './sqlite-manager.js';

export const router = express.Router();

/**
 * Warns if group data contains deprecated metadata keys and removes them.
 * @param {object} groupData Group data object
 */
function warnOnGroupMetadata(groupData) {
    if (typeof groupData !== 'object' || groupData === null) {
        return;
    }
    ['chat_metadata', 'past_metadata'].forEach(key => {
        if (Object.hasOwn(groupData, key)) {
            console.warn(color.yellow(`Group JSON data for "${groupData.id}" contains deprecated key "${key}".`));
            delete groupData[key];
        }
    });
}

/**
 * Migrates group metadata to include chat metadata for each group chat instead of the group itself.
 * DEPRECATED: Chats are now stored in SQLite. Migration from JSONL is handled by scripts/migrate-chats-to-sqlite.js
 * @param {import('../users.js').UserDirectoryList[]} userDirectories Listing of all users' directories
 */
export async function migrateGroupChatsMetadataFormat(userDirectories) {
    // No-op: chats are now SQLite-backed. See scripts/migrate-chats-to-sqlite.js
}

router.post('/all', (request, response) => {
    const groups = [];

    if (!fs.existsSync(request.user.directories.groups)) {
        fs.mkdirSync(request.user.directories.groups);
    }

    const files = fs.readdirSync(request.user.directories.groups).filter(x => path.extname(x) === '.json');
    const handle = request.user.profile.handle;
    const db = getDatabase(handle);
    const chats = db.prepare("SELECT id FROM chats WHERE user_id = ? AND chat_type = 'group'").all(handle).map(r => path.basename(r.id) + '.jsonl');

    files.forEach(async function (file) {
        try {
            const filePath = path.join(request.user.directories.groups, file);
            const fileContents = fs.readFileSync(filePath, 'utf8');
            const group = JSON.parse(fileContents);
            const groupStat = fs.statSync(filePath);
            group.date_added = groupStat.birthtimeMs;
            group.create_date = new Date(groupStat.birthtimeMs).toISOString();

            let chat_size = 0;
            let date_last_chat = 0;

            if (Array.isArray(group.chats) && Array.isArray(chats)) {
                for (const chat of chats) {
                    const chatName = path.basename(chat, '.jsonl');
                    if (group.chats.includes(chatName)) {
                        const chatId = `group/${chatName}`;
                        const chatInfo = await getChatInfo(chatId, {}, false, null, handle);
                        chat_size += parseInt(chatInfo.file_size) || 0;
                        const lastMes = typeof chatInfo.last_mes === 'string' ? Date.parse(chatInfo.last_mes) : (chatInfo.last_mes || 0);
                        date_last_chat = Math.max(date_last_chat, lastMes);
                    }
                }
            }

            group.date_last_chat = date_last_chat;
            group.chat_size = chat_size;
            groups.push(group);
        } catch (error) {
            console.error(error);
        }
    });

    return response.send(groups);
});

router.post('/create', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    warnOnGroupMetadata(request.body);
    const id = String(Date.now());
    const groupMetadata = {
        id: id,
        name: request.body.name ?? 'New Group',
        members: request.body.members ?? [],
        avatar_url: request.body.avatar_url,
        allow_self_responses: !!request.body.allow_self_responses,
        activation_strategy: request.body.activation_strategy ?? 0,
        generation_mode: request.body.generation_mode ?? 0,
        disabled_members: request.body.disabled_members ?? [],
        fav: request.body.fav,
        chat_id: request.body.chat_id ?? id,
        chats: request.body.chats ?? [id],
        auto_mode_delay: request.body.auto_mode_delay ?? 5,
        generation_mode_join_prefix: request.body.generation_mode_join_prefix ?? '',
        generation_mode_join_suffix: request.body.generation_mode_join_suffix ?? '',
    };
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const fileData = JSON.stringify(groupMetadata, null, 4);

    if (!fs.existsSync(request.user.directories.groups)) {
        fs.mkdirSync(request.user.directories.groups);
    }

    writeFileAtomicSync(pathToFile, fileData);
    return response.send(groupMetadata);
});

router.post('/edit', getFileNameValidationFunction('id'), (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }
    warnOnGroupMetadata(request.body);
    const id = request.body.id;
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const fileData = JSON.stringify(request.body, null, 4);

    writeFileAtomicSync(pathToFile, fileData);
    return response.send({ ok: true });
});

router.post('/delete', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const pathToGroup = path.join(request.user.directories.groups, sanitize(`${id}.json`));

    try {
        // Delete group chats
        const group = JSON.parse(fs.readFileSync(pathToGroup, 'utf8'));
        const handle = request.user.profile.handle;
        const db = getDatabase(handle);

        if (group && Array.isArray(group.chats)) {
            for (const chat of group.chats) {
                console.info('Deleting group chat', chat);
                const chatId = `group/${chat}`;
                db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
            }
        }
    } catch (error) {
        console.error('Could not delete group chats. Clean them up manually.', error);
    }

    if (fs.existsSync(pathToGroup)) {
        fs.unlinkSync(pathToGroup);
    }

    return response.send({ ok: true });
});
