import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite chat storage manager.
 *
 * One database file per user: data/<userId>/chats.db
 * Tables: chats, messages, backups
 *
 * NOTE: node:sqlite is experimental (Node 22.5+). Silence the warning once.
 */

// Silence the experimental warning from node:sqlite
const originalEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
    if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) {
        return;
    }
    return originalEmit.call(this, warning, ...args);
};

/** @type {Map<string, DatabaseSync>} */
const dbCache = new Map();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    character_key TEXT,
    chat_type TEXT NOT NULL DEFAULT 'character',
    group_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    chat_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    data TEXT NOT NULL,
    is_user INTEGER NOT NULL DEFAULT 0,
    send_date TEXT,
    PRIMARY KEY (chat_id, ordinal),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL,
    backup_type TEXT NOT NULL DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_chats_user_char ON chats(user_id, character_key);
CREATE INDEX IF NOT EXISTS idx_chats_user_group ON chats(user_id, chat_type, group_id);
CREATE INDEX IF NOT EXISTS idx_backups_chat ON backups(chat_id, created_at);
`;

/**
 * Gets (or opens + caches) a DatabaseSync instance for a user.
 * @param {string} userId
 * @returns {DatabaseSync}
 */
export function getDatabase(userId) {
    if (!userId || userId.startsWith('_')) {
        throw new Error(`getDatabase called with invalid userId: ${userId}`);
    }
    if (dbCache.has(userId)) {
        return dbCache.get(userId);
    }

    const userDir = path.join('data', userId);
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }

    const dbPath = path.join(userDir, 'chats.db');
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);

    dbCache.set(userId, db);
    return db;
}

/**
 * Atomically backs up a user's chat database to a destination path.
 * Uses a WAL checkpoint + file copy (node:sqlite has no .backup() in this version).
 * @param {string} userId
 * @param {string} destPath
 */
export function backupDatabase(userId, destPath) {
    const db = getDatabase(userId);
    // Flush WAL to main db so the file copy is consistent
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const dbPath = path.join('data', userId, 'chats.db');
    fs.copyFileSync(dbPath, destPath);
    // Also copy WAL/SHM if they exist (should be empty after TRUNCATE, but be safe)
    for (const ext of ['-wal', '-shm']) {
        const src = dbPath + ext;
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, destPath + ext);
        }
    }
}

/**
 * Flushes + closes all cached databases (called on process exit).
 */
export function closeAllDatabases() {
    for (const db of dbCache.values()) {
        try {
            db.close();
        } catch {
            // ignore
        }
    }
    dbCache.clear();
}

process.on('exit', closeAllDatabases);
