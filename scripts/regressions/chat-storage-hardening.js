import fs from 'node:fs';
import assert from 'node:assert/strict';

import { setConfigFilePath } from '../../src/util.js';

setConfigFilePath('config.yaml');

const { closeAllDatabases, getDatabase } = await import('../../src/endpoints/sqlite-manager.js');
const { getChatData, restoreChatBackup, trySaveChat } = await import('../../src/endpoints/chats.js');

const userId = `regression-chat-storage-${process.pid}`;
const userDir = `data/${userId}`;
const chatId = 'char/Test/Test Chat';
const integrity = 'regression-integrity';

const header = () => ({ chat_metadata: { integrity }, user_name: 'unused', character_name: 'unused' });
const message = (mes, isUser = false) => ({ name: isUser ? 'User' : 'Test', is_user: isUser, is_system: false, send_date: new Date().toISOString(), mes, extra: {} });

async function removeTestDirectory() {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            fs.rmSync(userDir, { recursive: true, force: true });
            return;
        } catch (error) {
            if (error.code !== 'EBUSY' || attempt === 9) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
}

try {
    const original = [header(), message('Greeting'), message('Reply', true), message('Response')];
    const revision0 = await trySaveChat(original, chatId, false, userId, 'Test', null, true, null);
    assert.equal(revision0, 0, 'new chats start at revision 0');

    const appended = [...original, message('Next reply', true)];
    const revision1 = await trySaveChat(appended, chatId, false, userId, 'Test', null, true, revision0);
    assert.equal(revision1, 1, 'append increments revision');

    await assert.rejects(
        () => trySaveChat([...appended, message('Stale overwrite')], chatId, false, userId, 'Test', null, true, revision0),
        /revision check failed/,
        'stale revisions are rejected',
    );

    await assert.rejects(
        () => trySaveChat([{ chat_metadata: {} }, message('Unsafe reset')], chatId, false, userId, 'Test', null, true, revision1),
        /missing required integrity metadata/,
        'missing integrity cannot replace an existing chat',
    );

    const shortened = [header(), message('Greeting')];
    const revision2 = await trySaveChat(shortened, chatId, false, userId, 'Test', null, true, revision1);
    assert.equal(revision2, 2, 'intentional shortening succeeds with current revision');

    const db = getDatabase(userId);
    const preSave = db.prepare("SELECT id, data FROM backups WHERE chat_id = ? AND backup_type = 'pre_save' ORDER BY id DESC LIMIT 1").get(chatId);
    assert.ok(preSave, 'destructive save creates a pre-save snapshot');
    assert.deepEqual(JSON.parse(preSave.data), appended, 'pre-save snapshot exactly matches the previous chat');

    const restoreResult = restoreChatBackup(userId, preSave.id);
    assert.equal(restoreResult.revision, 3, 'restore increments revision');
    assert.deepEqual(getChatData(chatId, userId), appended, 'single-chat restore reproduces the selected backup');

    const preRestore = db.prepare("SELECT data FROM backups WHERE chat_id = ? AND backup_type = 'pre_restore' ORDER BY id DESC LIMIT 1").get(chatId);
    assert.deepEqual(JSON.parse(preRestore.data), shortened, 'restore preserves the displaced chat version');

    console.log('chat-storage-hardening regression passed');
} finally {
    closeAllDatabases();
    await removeTestDirectory();
}
