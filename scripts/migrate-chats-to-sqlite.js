#!/usr/bin/env node
/**
 * One-time migration: converts all existing .jsonl chat files to SQLite storage.
 *
 * Run: node scripts/migrate-chats-to-sqlite.js
 * (or: bun scripts/migrate-chats-to-sqlite.js)
 *
 * Reads every .jsonl file under data/<user>/chats/ and data/<user>/groupChats/,
 * parses them, and inserts into data/<user>/chats.db via trySaveChat.
 * Original .jsonl files are archived to data/<user>/jsonl-archive/ (not deleted).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

// Import after setting config path (util.js requires it)
import { setConfigFilePath, tryParse } from '../src/util.js';
setConfigFilePath(path.join(rootDir, 'config.yaml'));

const { trySaveChat } = await import('../src/endpoints/chats.js');
const { getDatabase } = await import('../src/endpoints/sqlite-manager.js');

/**
 * ST's chat filename format is: <ChatName>.<CharacterName> - <timestamp>.jsonl
 * where <CharacterName> is the character folder name and <timestamp> is ST's
 * humanizedDateTime: YYYY-MM-DD@HHhMMmSSsNNNms
 *
 * The client's chatId uses <ChatName> = the filename with `.jsonl` removed AND the
 * trailing " - <timestamp>" stripped. We replicate exactly that so the migrated
 * chatId matches what the client sends for load/delete/rename (prevents phantom
 * clones). We strip by the timestamp pattern (not the folder name) because the
 * folder name can itself contain the chat name (degenerate cases like
 * "Deadbeat Baby Daddy. Kieran McAllister").
 *
 * @param {string} fileNameNoExt - full filename minus ".jsonl"
 * @returns {string} the real ChatName used as the chatId leaf
 */
function stripChatName(fileNameNoExt) {
    // ST humanized timestamp: 2026-07-04@18h32m48s329ms  (with optional milliseconds)
    const tsPattern = / - \d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3,}ms$/;
    // strip the timestamp suffix, then trim any dangling whitespace it leaves
    // behind (e.g. "NAME  - ts" -> "NAME " -> "NAME") so chat names stay canonical
    return fileNameNoExt.replace(tsPattern, '').trim();
}

function migrateUser(userId) {
    const userDir = path.join(dataDir, userId);
    const chatsDir = path.join(userDir, 'chats');
    const groupChatsDir = path.join(userDir, 'groupChats');
    const archiveDir = path.join(userDir, 'jsonl-archive');
    const db = getDatabase(userId);

    let migrated = 0;
    let failed = 0;
    let processed = 0;
    const seenChatIds = new Set();

    // Migrate character chats
    if (fs.existsSync(chatsDir)) {
        const charFolders = fs.readdirSync(chatsDir, { withFileTypes: true }).filter(e => e.isDirectory());
        for (const folder of charFolders) {
            const characterKey = folder.name;
            const folderPath = path.join(chatsDir, characterKey);
            const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
            for (const file of jsonlFiles) {
                const chatName = stripChatName(path.parse(file).name);
                const chatId = `char/${characterKey}/${chatName}`;
                const filePath = path.join(folderPath, file);
                processed++;
                try {
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const chatData = raw.split('\n').filter(l => l.trim()).map(l => tryParse(l)).filter(Boolean);
                    if (chatData.length === 0) continue;
                    if (seenChatIds.has(chatId)) {
                        console.warn(`  ~ COLLISION: ${chatId} already migrated — later file wins (ON CONFLICT REPLACE)`);
                    }
                    seenChatIds.add(chatId);
                    trySaveChat(chatData, chatId, true, userId, characterKey, null, true);
                    migrated++;
                    // Archive
                    const destFolder = path.join(archiveDir, 'chats', characterKey);
                    fs.mkdirSync(destFolder, { recursive: true });
                    fs.copyFileSync(filePath, path.join(destFolder, file));
                } catch (err) {
                    console.error(`  ! Failed to migrate ${chatId}:`, err.message);
                    failed++;
                }
                if (processed % 50 === 0) {
                    console.log(`  ...${processed} files processed (${migrated} ok, ${failed} failed)`);
                }
            }
        }
    }

    // Migrate group chats
    if (fs.existsSync(groupChatsDir)) {
        const jsonlFiles = fs.readdirSync(groupChatsDir).filter(f => f.endsWith('.jsonl'));
        for (const file of jsonlFiles) {
            const groupId = path.parse(file).name;
            const chatId = `group/${groupId}`;
            const filePath = path.join(groupChatsDir, file);
            try {
                const raw = fs.readFileSync(filePath, 'utf8');
                const chatData = raw.split('\n').filter(l => l.trim()).map(l => tryParse(l)).filter(Boolean);
                if (chatData.length === 0) continue;
                trySaveChat(chatData, chatId, true, userId, groupId, null);
                migrated++;
                const destFolder = path.join(archiveDir, 'groupChats');
                fs.mkdirSync(destFolder, { recursive: true });
                fs.copyFileSync(filePath, path.join(destFolder, file));
            } catch (err) {
                console.error(`  ! Failed to migrate ${chatId}:`, err.message);
                failed++;
            }
        }
    }

    // Migrate existing backup files (chat_*.jsonl in backups/)
    const backupsDir = path.join(userDir, 'backups');
    if (fs.existsSync(backupsDir)) {
        const backupFiles = fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_') && f.endsWith('.jsonl'));
        for (const file of backupFiles) {
            const filePath = path.join(backupsDir, file);
            try {
                const raw = fs.readFileSync(filePath, 'utf8');
                const chatData = raw.split('\n').filter(l => l.trim()).map(l => tryParse(l)).filter(Boolean);
                if (chatData.length === 0) continue;
                // Extract chat_id from filename: chat_<characterKey>_<fileName>_<timestamp>.jsonl
                const parts = file.replace('chat_', '').replace('.jsonl', '').split('_');
                const timestamp = parts.pop();
                const fileNameRaw = parts.pop();
                const characterKey = parts.join('_');
                const fileName = stripChatName(fileNameRaw);
                const chatId = `char/${characterKey}/${fileName}`;
                const version = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM backups WHERE chat_id = ?').get(chatId)?.v) || 1;
                db.prepare('INSERT INTO backups (chat_id, version, created_at, data, backup_type) VALUES (?, ?, ?, ?, ?)').run(
                    chatId, version, parseInt(timestamp) || Date.now(), JSON.stringify(chatData), 'auto'
                );
                const destFolder = path.join(archiveDir, 'backups');
                fs.mkdirSync(destFolder, { recursive: true });
                fs.copyFileSync(filePath, path.join(destFolder, file));
            } catch (err) {
                console.error(`  ! Failed to migrate backup ${file}:`, err.message);
            }
        }
    }

    return { migrated, failed };
}

console.log('=== SQLite Chat Migration ===');
if (!fs.existsSync(dataDir)) {
    console.log('No data/ directory found. Nothing to migrate.');
    process.exit(0);
}

const users = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map(e => e.name);

if (users.length === 0) {
    console.log('No user directories found. Nothing to migrate.');
    process.exit(0);
}

let totalMigrated = 0;
let totalFailed = 0;

for (const user of users) {
    console.log(`\nMigrating user: ${user}`);
    const { migrated, failed } = migrateUser(user);
    totalMigrated += migrated;
    totalFailed += failed;
    console.log(`  ${migrated} chats migrated, ${failed} failed`);
}

console.log(`\n=== Done. ${totalMigrated} total migrated, ${totalFailed} failed ===`);
console.log('Original .jsonl files archived to data/<user>/jsonl-archive/ (safe to delete after verification)');
process.exit(totalFailed > 0 ? 1 : 0);
