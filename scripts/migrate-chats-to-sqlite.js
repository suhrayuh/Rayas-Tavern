#!/usr/bin/env node
/**
 * One-time migration: converts all existing .jsonl chat files to SQLite storage.
 *
 * Run: node scripts/migrate-chats-to-sqlite.js
 * (or: bun scripts/migrate-chats-to-sqlite.js)
 *
 * This is now a thin CLI wrapper around the shared migrateUserChats() in
 * src/endpoints/chat-migrate.js, which is also called automatically at server
 * startup (see server-main.js runChatMigrationIfNeeded). Original .jsonl files
 * are archived to data/<user>/jsonl-archive/ (not deleted).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Import after setting config path (util.js requires it)
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(path.join(rootDir, 'config.yaml'));

const { migrateUserChats } = await import('../src/endpoints/chat-migrate.js');

console.log('=== SQLite Chat Migration ===');
const dataDir = path.join(rootDir, 'data');
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
    const { migrated, failed } = await migrateUserChats(user);
    totalMigrated += migrated;
    totalFailed += failed;
    console.log(`  ${migrated} chats migrated, ${failed} failed`);
}

console.log(`\n=== Done. ${totalMigrated} total migrated, ${totalFailed} failed ===`);
console.log('Original .jsonl files archived to data/<user>/jsonl-archive/ (safe to delete after verification)');
process.exit(totalFailed > 0 ? 1 : 0);
