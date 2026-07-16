import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import { setConfigFilePath } from '../../src/util.js';

setConfigFilePath('config.yaml');

const { closeAllDatabases, getDatabase } = await import('../../src/endpoints/sqlite-manager.js');
const { trySaveChat } = await import('../../src/endpoints/chats.js');

const userId = `regression-group-search-${process.pid}`;
const groupsDir = `data/${userId}/groups`;
const chatId = `group/2026-07-16@04h18m06s755ms`;
const groupId = '1784193486765';
const integrity = 'group-search-integrity';

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
    // Save a group chat (chatId = group/<chatName>, group_id = <chatName> in SQLite)
    let revision = await trySaveChat([header(), message('Hello')], chatId, false, userId, 'test', null, true, null);
    revision = await trySaveChat([header(), message('Hello'), message('World')], chatId, false, userId, 'test', null, true, revision);

    // Create a group JSON that references the chat by name (the actual group_id mismatch)
    fs.mkdirSync(groupsDir, { recursive: true });
    const groupJsonPath = path.join(groupsDir, `${groupId}.json`);
    fs.writeFileSync(groupJsonPath, JSON.stringify({
        id: groupId,
        name: 'Test Group',
        chat_id: '2026-07-16@04h18m06s755ms',
        chats: ['2026-07-16@04h18m06s755ms'],
    }));

    // Simulate the fixed search logic from /api/chats/search
    const db = getDatabase(userId);
    const groupData = JSON.parse(fs.readFileSync(groupJsonPath, 'utf8'));
    const groupChatNames = Array.isArray(groupData.chats) ? groupData.chats.filter(x => typeof x === 'string') : [];
    const fullChatIds = groupChatNames.map(n => `group/${n}`);
    const rows = db.prepare(
        `SELECT id FROM chats WHERE user_id = ? AND chat_type = 'group' AND id IN (${fullChatIds.map(() => '?').join(',')})`,
    ).all(userId, ...fullChatIds);

    assert.equal(rows.length, 1, 'Group chat should be found via group JSON chats array');
    assert.equal(rows[0].id, chatId, 'Found chat ID should match the saved chat');

    // Verify that without the fix (using group_id directly), nothing matches
    const oldQueryRows = db.prepare("SELECT id FROM chats WHERE user_id = ? AND chat_type = 'group' AND group_id = ?").all(userId, groupId);
    assert.equal(oldQueryRows.length, 0, 'Old query (group_id = group JSON id) should match nothing — demonstrating the bug');

    console.log('group-chat-search regression passed');
} finally {
    closeAllDatabases();
    await removeTestDirectory();
}