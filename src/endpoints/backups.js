import express from 'express';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { CHAT_BACKUPS_PREFIX, getChatInfo } from './chats.js';
import { getDatabase } from './sqlite-manager.js';
import { tryParse } from '../util.js';

export const router = express.Router();

router.post('/chat/get', async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const db = getDatabase(handle);
        const rows = db.prepare('SELECT id, chat_id, version, created_at, data FROM backups WHERE chat_id LIKE ? ORDER BY created_at DESC').all('char/%');

        const backupModels = [];
        for (const row of rows) {
            const chatData = tryParse(row.data);
            if (!Array.isArray(chatData) || chatData.length === 0) {
                continue;
            }
            const info = await getChatInfo(row.chat_id, {}, true, null, handle);
            if (!info || !info.file_name) {
                continue;
            }
            backupModels.push({
                ...info,
                backup_id: row.id,
                version: row.version,
                created_at: row.created_at,
            });
        }

        return response.json(backupModels);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/chat/delete', async (request, response) => {
    try {
        const { backup_id } = request.body;
        const handle = request.user.profile.handle;
        const db = getDatabase(handle);

        const result = db.prepare('DELETE FROM backups WHERE id = ? AND chat_id LIKE ?').run(backup_id, 'char/%');
        if (result.changes > 0) {
            return response.sendStatus(200);
        }
        return response.sendStatus(404);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/chat/download', async (request, response) => {
    try {
        const { backup_id } = request.body;
        const handle = request.user.profile.handle;
        const db = getDatabase(handle);

        const row = db.prepare('SELECT data FROM backups WHERE id = ? AND chat_id LIKE ?').get(backup_id, 'char/%');
        if (!row) {
            return response.sendStatus(404);
        }

        const chatData = tryParse(row.data);
        const jsonl = Array.isArray(chatData) ? chatData.map(m => JSON.stringify(m)).join('\n') : '';
        response.setHeader('Content-Type', 'application/jsonl');
        response.setHeader('Content-Disposition', `attachment; filename="backup_${backup_id}.jsonl"`);
        return response.send(jsonl);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
