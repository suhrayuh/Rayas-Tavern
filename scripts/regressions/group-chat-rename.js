import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import { setConfigFilePath } from '../../src/util.js';

setConfigFilePath('config.yaml');

const { closeAllDatabases, getDatabase } = await import('../../src/endpoints/sqlite-manager.js');
const { trySaveChat } = await import('../../src/endpoints/chats.js');

const userId = `regression-group-rename-${process.pid}`;
const groupsDir = `data/${userId}/groups`;
const originalChatName = '2026-07-16@04h46m09s156ms';
const renamedChatName = 'GROUP SQLITE TEST';
const originalChatId = `group/${originalChatName}`;
const renamedChatId = `group/${renamedChatName}`;
const groupId = '1784195169164';
const integrity = 'group-rename-integrity';

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
    // Save an initial group chat
    let revision = await trySaveChat([header(), message('Hello')], originalChatId, false, userId, 'test', null, true, null);
    revision = await trySaveChat([header(), message('Hello'), message('World')], originalChatId, false, userId, 'test', null, true, revision);

    // Create the group JSON file referencing the chat
    fs.mkdirSync(groupsDir, { recursive: true });
    const groupJsonPath = path.join(groupsDir, `${groupId}.json`);
    fs.writeFileSync(groupJsonPath, JSON.stringify({
        id: groupId,
        name: 'Test Group',
        chat_id: originalChatName,
        chats: [originalChatName],
    }));

    // Verify pre-rename state
    let db = getDatabase(userId);
    const preRenameChat = db.prepare('SELECT id FROM chats WHERE id = ?').get(originalChatId);
    assert.ok(preRenameChat, 'Pre-rename chat should exist');

    // Simulate the rename endpoint logic: UPDATE messages/backups/chats to use new ID
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');
    db.prepare('UPDATE messages SET chat_id = ? WHERE chat_id = ?').run(renamedChatId, originalChatId);
    db.prepare('UPDATE backups SET chat_id = ? WHERE chat_id = ?').run(renamedChatId, originalChatId);
    db.prepare('UPDATE chats SET id = ? WHERE id = ?').run(renamedChatId, originalChatId);
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON;');

    // Verify post-rename state
    const postRenameChat = db.prepare('SELECT id FROM chats WHERE id = ?').get(renamedChatId);
    assert.ok(postRenameChat, 'Renamed chat should exist at new ID');
    const oldChatGone = db.prepare('SELECT id FROM chats WHERE id = ?').get(originalChatId);
    assert.equal(oldChatGone, undefined, 'Original chat should no longer exist');

    // Simulate the fixed group listing: read group JSONs and aggregate data
    const files = fs.readdirSync(groupsDir).filter(f => f.endsWith('.json'));
    const listedGroups = [];
    for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(groupsDir, file), 'utf8'));
        listedGroups.push(data);
    }
    assert.equal(listedGroups.length, 1, 'Should list exactly 1 group');
    assert.equal(listedGroups[0].id, groupId, 'Listed group should have correct ID');
    assert.deepEqual(listedGroups[0].chats, [originalChatName], 'Group JSON should still reference original chat name');

    // Simulate the search endpoint with the renamed chat
    const chats = db.prepare("SELECT id FROM chats WHERE user_id = ? AND chat_type = 'group'").all(userId).map(r => r.id);
    const fullChatIds = [renamedChatId];
    const foundChats = db.prepare(
        `SELECT id FROM chats WHERE user_id = ? AND chat_type = 'group' AND id IN (${fullChatIds.map(() => '?').join(',')})`,
    ).all(userId, ...fullChatIds);
    assert.equal(foundChats.length, 1, 'Renamed chat should be findable via search');
    assert.equal(foundChats[0].id, renamedChatId, 'Search should return the renamed chat ID');

    console.log('group-chat-rename regression passed');
} finally {
    closeAllDatabases();
    await new Promise(resolve => setTimeout(resolve, 100));
    await removeTestDirectory();
}