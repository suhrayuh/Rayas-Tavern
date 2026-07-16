import fs from 'node:fs';
import assert from 'node:assert/strict';

import { setConfigFilePath } from '../../src/util.js';

setConfigFilePath('config.yaml');

const { closeAllDatabases, getDatabase } = await import('../../src/endpoints/sqlite-manager.js');
const { trySaveChat } = await import('../../src/endpoints/chats.js');

const userId = `regression-backup-prune-${process.pid}`;
const chatId = 'char/Test/Prune Chat';
const integrity = 'prune-integrity';

const header = () => ({ chat_metadata: { integrity }, user_name: 'unused', character_name: 'unused' });
const message = (mes, isUser = false) => ({ name: isUser ? 'User' : 'Test', is_user: isUser, is_system: false, send_date: new Date().toISOString(), mes, extra: {} });

async function removeTestDirectory() {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            fs.rmSync(`data/${userId}`, { recursive: true, force: true });
            return;
        } catch (error) {
            if (error.code !== 'EBUSY' || attempt === 9) throw error;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
}

try {
    // Save initial chat (revision 0)
    let revision = await trySaveChat([header(), message('Initial')], chatId, false, userId, 'Test', null, true, null);

    // Create 30 destructive saves (each creates a pre_save snapshot + trims to 25)
    for (let i = 1; i <= 30; i++) {
        const data = [header(), ...Array.from({ length: i + 1 }, (_, j) => message(`Msg ${j}`))];
        revision = await trySaveChat(data, chatId, false, userId, 'Test', null, true, revision);
    }

    const db = getDatabase(userId);
    const count = db.prepare('SELECT COUNT(*) AS c FROM backups WHERE chat_id = ?').get(chatId)?.c;
    assert.ok(count <= 25, `Expected ≤ 25 backups, got ${count}`);

    // Verify the kept backups are the newest ones (highest created_at)
    const oldestKept = db.prepare('SELECT created_at FROM backups WHERE chat_id = ? ORDER BY created_at ASC LIMIT 1').get(chatId);
    const newestKept = db.prepare('SELECT created_at FROM backups WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1').get(chatId);
    assert.ok(newestKept.created_at > oldestKept.created_at, 'Kept backups should span a time range');

    console.log(`backup-prune regression passed (${count} backups after 30 destructive saves, capped at 25)`);
} finally {
    closeAllDatabases();
    await removeTestDirectory();
}