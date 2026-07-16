import express from 'express';
import { restoreChatBackup } from './chats.js';
import { getDatabase } from './sqlite-manager.js';
import { formatBytes, tryParse } from '../util.js';

export const router = express.Router();

router.post('/chat/get', async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const db = getDatabase(handle);
        const chatId = request.body?.chat_id || null;
        const page = Math.max(0, Number(request.body?.page) || 0);
        const perPage = Math.min(50, Number(request.body?.per_page) || 5);

        const whereClause = chatId ? 'WHERE chat_id = ?' : '';
        const whereParams = chatId ? [chatId] : [];

        const total = db.prepare(`SELECT COUNT(*) AS c FROM backups ${whereClause}`).get(...whereParams)?.c || 0;

        const rows = db.prepare(
            `SELECT id, chat_id, version, created_at, data, backup_type FROM backups ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        ).all(...whereParams, perPage, page * perPage);

        const items = [];
        for (const row of rows) {
            const chatData = tryParse(row.data);
            if (!Array.isArray(chatData) || chatData.length === 0) {
                continue;
            }
            const messages = chatData.slice(1);
            const lastMessage = messages[messages.length - 1];
            const fileId = row.chat_id.split('/').pop();
            items.push({
                file_id: fileId,
                file_name: `${fileId}.jsonl`,
                chat_id: row.chat_id,
                chat_type: row.chat_id.startsWith('group/') ? 'group' : 'character',
                file_size: formatBytes(Buffer.byteLength(row.data, 'utf8')),
                chat_items: messages.length,
                mes: (lastMessage?.mes || '[The chat is empty]').slice(0, 200),
                last_mes: lastMessage?.send_date || new Date(row.created_at).toISOString(),
                backup_id: row.id,
                version: row.version,
                created_at: row.created_at,
                backup_type: row.backup_type,
            });
        }

        return response.json({ items, total, page, per_page: perPage });
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

        const result = db.prepare('DELETE FROM backups WHERE id = ?').run(backup_id);
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

        const row = db.prepare('SELECT data FROM backups WHERE id = ?').get(backup_id);
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

router.post('/chat/restore', async (request, response) => {
    try {
        const backupId = Number(request.body?.backup_id);
        if (!Number.isInteger(backupId) || backupId < 1) {
            return response.sendStatus(400);
        }
        const result = restoreChatBackup(request.user.profile.handle, backupId);
        if (!result) {
            return response.sendStatus(404);
        }
        return response.send({ ok: true, chat_id: result.chatId, revision: result.revision });
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'restore_failed' });
    }
});
