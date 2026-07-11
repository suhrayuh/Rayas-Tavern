import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateTimestamp } from '../util.js';

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
 * Atomically backs up a user's chat database to the user's `backups/` directory.
 * Performs a WAL checkpoint so the main db file is consistent, copies the file
 * (and any -wal/-shm sidecars), then rotates old copies to keep at most
 * `maxBackups` (oldest by mtime are removed first).
 *
 * NOTE: this is an async full-file copy. At multi-GB sizes it is I/O heavy, so
 * it must NOT run synchronously on the request path. It is scheduled at startup,
 * on a long interval, and on shutdown.
 *
 * @param {string} userId
 * @param {object} [opts]
 * @param {number} [opts.maxBackups=5]
 */
export async function backupDatabase(userId, opts = {}) {
    const maxBackups = Number(opts.maxBackups ?? 5);
    const db = getDatabase(userId);
    const userDir = path.join('data', userId);
    const dbPath = path.join(userDir, 'chats.db');
    const backupDir = path.join(userDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // Flush WAL into the main db so the file copy is a consistent snapshot.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    // Local-time, 24hr stamp (matches the format used by settings backups, e.g.
    // settings_default-user_20260709-173941.json) — not UTC, so it reads naturally.
    const stamp = generateTimestamp();
    const dest = path.join(backupDir, `chatsdb_${stamp}.db`);
    // Copy to a temp name first, then rename into place. On a full disk the
    // copy can fail partway and leave a truncated chatsdb_*.db that rotation
    // would treat as a valid (and mtime-poisoning) backup — so we stage it.
    const tmp = `${dest}.part`;

    try {
        await fs.promises.copyFile(dbPath, tmp);
        // copyFile preserves the SOURCE file's mtime on Windows, which makes the
        // explorer "Date modified" column show when chats.db was last written
        // rather than when the backup was actually taken. Stamp the dest mtime
        // to "now" so it matches the filename and the interval baseline stays
        // correct.
        const now = Date.now();
        await fs.promises.utimes(tmp, now / 1000, now / 1000);
        // Atomic move into place (rename is instant + atomic on the same volume).
        await fs.promises.rename(tmp, dest);
    } catch (err) {
        // Best-effort cleanup of any partial so it isn't mistaken for a backup.
        try {
            await fs.promises.rm(tmp, { force: true });
        } catch { /* ignore */ }
        throw err;
    }

    await rotateBackups(backupDir, maxBackups);
    return dest;
}

/**
 * Removes the oldest db backups in a directory, keeping the newest `maxBackups`.
 * @param {string} backupDir
 * @param {number} maxBackups
 */
async function rotateBackups(backupDir, maxBackups) {
    if (!Number.isFinite(maxBackups) || maxBackups < 1) {
        return;
    }
    const files = fs.readdirSync(backupDir)
        .filter(name => /^chatsdb_(?:\d{8}-\d{6}|[\dTZ_.-]+)\.db(?:-wal|-shm)?$/.test(name))
        .map(name => {
            const full = path.join(backupDir, name);
            let mtime = 0;
            try {
                mtime = fs.statSync(full).mtimeMs;
            } catch { /* ignore */ }
            return { name, mtime };
        })
        .sort((a, b) => a.mtime - b.mtime); // oldest first

    const excess = files.length - maxBackups;
    for (let i = 0; i < excess; i++) {
        const full = path.join(backupDir, files[i].name);
        try {
            await fs.promises.rm(full, { force: true });
        } catch { /* ignore */ }
        // Also drop any -wal/-shm sidecars from the rotated main file.
        for (const ext of ['-wal', '-shm']) {
            try {
                await fs.promises.rm(full + ext, { force: true });
            } catch { /* ignore */ }
        }
    }
}

/**
 * Backs up every user database on disk (called on startup, interval, and shutdown).
 * Scans data/ for user directories containing a chats.db so it works even when
 * the in-memory db cache hasn't been warmed yet (e.g. right after ST starts,
 * before any chat is opened).
 * @param {object} [opts]
 * @param {number} [opts.maxBackups=5]
 */
export async function backupAllUserDatabases(opts = {}) {
    const dataRoot = 'data';
    let userDirs = [];
    const failed = [];
    lastBackupFailed = false;
    try {
        userDirs = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    } catch {
        // No data dir yet — nothing to back up.
        return;
    }

    const tasks = [];
    for (const userId of userDirs) {
        // Skip users whose chat db doesn't exist (e.g. _ migration dirs, groups).
        const dbPath = path.join(dataRoot, userId, 'chats.db');
        if (!fs.existsSync(dbPath)) {
            continue;
        }
        if (userId.startsWith('_')) {
            continue;
        }
        // Per-user: skip only if THIS user already has a recent backup. A
        // different user's recent backup must not suppress this one.
        const minAgeMs = Number(opts.minAgeMs ?? 0);
        if (minAgeMs > 0 && hasRecentBackupForUser(userId, minAgeMs)) {
            continue;
        }
        tasks.push(backupDatabase(userId, opts).catch(err => {
            console.error(`[sqlite] failed to back up database for ${userId}`, err);
            // Surface the failure so the caller (interval tick) can retry soon
            // instead of waiting a full 6h — e.g. disk full (ENOSPC) clears.
            failed.push(userId);
        }));
    }
    await Promise.all(tasks);

    // If any backup failed (e.g. ENOSPC / disk full), ask the interval scheduler
    // to retry in 30 min rather than waiting the full interval. ST clears space
    // long before then and we don't want to lose up to 6h of backup coverage.
    if (failed.length > 0) {
        lastBackupFailed = true;
    }
}

const DB_BACKUP_INTERVAL_MS = Number(process.env.AGENT_PLAYGROUND_DB_BACKUP_INTERVAL_MS ?? 21_600_000); // 6h default

/**
 * Finds the mtime (ms) of the most recent chatsdb_*.db backup across all user
 * backup dirs, or null if none exist yet. Used to baseline the interval timer
 * against wall-clock time (so time ST was shut down still counts).
 * @returns {number|null}
 */
function getLastBackupMtime() {
    const dataRoot = 'data';
    let newest = null;
    try {
        const userDirs = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('_'))
            .map(e => e.name);
        for (const userId of userDirs) {
            const backupDir = path.join(dataRoot, userId, 'backups');
            if (!fs.existsSync(backupDir)) {
                continue;
            }
            for (const name of fs.readdirSync(backupDir)) {
                if (!/^chatsdb_(?:\d{8}-\d{6}|[\dTZ_.-]+)\.db$/.test(name)) {
                    continue;
                }
                try {
                    const mtime = fs.statSync(path.join(backupDir, name)).mtimeMs;
                    if (newest === null || mtime > newest) {
                        newest = mtime;
                    }
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
    return newest;
}

/**
 * Newest backup mtime (ms) for a single user, or null if none.
 * @param {string} userId
 * @returns {number|null}
 */
function getLastBackupMtimeForUser(userId) {
    const backupDir = path.join('data', userId, 'backups');
    let newest = null;
    try {
        if (!fs.existsSync(backupDir)) {
            return null;
        }
        for (const name of fs.readdirSync(backupDir)) {
            if (!/^chatsdb_(?:\d{8}-\d{6}|[\dTZ_.-]+)\.db$/.test(name)) {
                continue;
            }
            try {
                const mtime = fs.statSync(path.join(backupDir, name)).mtimeMs;
                if (newest === null || mtime > newest) {
                    newest = mtime;
                }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return newest;
}

/**
 * True if `userId` has a backup newer than `maxAgeMs` ago (per-user, so one
 * user's recent backup never suppresses backups for other users).
 * @param {string} userId
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
export function hasRecentBackupForUser(userId, maxAgeMs) {
    const last = getLastBackupMtimeForUser(userId);
    if (last === null) {
        return false;
    }
    return (Date.now() - last) < maxAgeMs;
}

/**
 * True if ANY user has a backup newer than `maxAgeMs` ago. Used only to decide
 * whether the interval timer's first scheduled run can wait the full interval
 * (vs. needing to run soon). Per-user gating for actual backups is done inside
 * backupAllUserDatabases via hasRecentBackupForUser.
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
export function hasRecentBackup(maxAgeMs) {
    const last = getLastBackupMtime();
    if (last === null) {
        return false;
    }
    return (Date.now() - last) < maxAgeMs;
}

let dbBackupTimer = null;
let dbBackupOpts = {};
// Set when the last backup pass had any failure (e.g. disk full). The scheduler
// uses this to retry in DB_BACKUP_RETRY_MS instead of waiting the full interval.
let lastBackupFailed = false;
const DB_BACKUP_RETRY_MS = Number(process.env.AGENT_PLAYGROUND_DB_BACKUP_RETRY_MS ?? 30 * 60_000); // 30min

/**
 * Runs a backup pass, then schedules the NEXT one based on wall-clock time since
 * the last backup (not process uptime). If ST was off for longer than the
 * interval, the next pass fires almost immediately on the next tick.
 * @param {object} opts
 */
async function backupTick(opts) {
    await backupAllUserDatabases(opts).catch(err => {
        console.error('[sqlite] periodic database backup failed', err);
    });
    scheduleNextBackup();
}

/** Schedules the next backup using real elapsed time since the last backup. */
function scheduleNextBackup() {
    const interval = Number(dbBackupOpts.intervalMs ?? DB_BACKUP_INTERVAL_MS);
    if (!Number.isFinite(interval) || interval <= 0) {
        return;
    }
    const last = getLastBackupMtime();
    // If the last pass failed (e.g. disk full), retry soon (30min) rather than
    // waiting the full interval — space is usually cleared quickly and we don't
    // want to lose up to 6h of backup coverage on a transient error.
    if (lastBackupFailed) {
        const delay = Math.max(1000, DB_BACKUP_RETRY_MS);
        dbBackupTimer = setTimeout(backupTick, delay, dbBackupOpts);
        if (typeof dbBackupTimer.unref === 'function') {
            dbBackupTimer.unref();
        }
        return;
    }
    // If no backup exists yet, wait the full interval for the first scheduled
    // one (the startup hook handles the immediate first backup). Never collapse
    // to ~1s here, or it double-fires right after the startup backup.
    if (last === null) {
        const delay = Math.max(1000, interval);
        dbBackupTimer = setTimeout(backupTick, delay, dbBackupOpts);
        if (typeof dbBackupTimer.unref === 'function') {
            dbBackupTimer.unref();
        }
        return;
    }
    const now = Date.now();
    const elapsed = now - last;
    const delay = Math.max(1000, interval - elapsed);
    if (dbBackupTimer) {
        clearTimeout(dbBackupTimer);
    }
    dbBackupTimer = setTimeout(backupTick, delay, dbBackupOpts);
    if (typeof dbBackupTimer.unref === 'function') {
        dbBackupTimer.unref();
    }
}

/** Starts the periodic db-backup scheduler (idempotent). */
export function startDatabaseBackupTimer(opts = {}) {
    if (dbBackupTimer) {
        return;
    }
    dbBackupOpts = opts;
    scheduleNextBackup();
}

/** Stops the periodic db-backup scheduler. */
export function stopDatabaseBackupTimer() {
    if (dbBackupTimer) {
        clearTimeout(dbBackupTimer);
        dbBackupTimer = null;
    }
}

/**
 * Flushes + closes all cached databases (called on process exit).
 */
export function closeAllDatabases() {
    stopDatabaseBackupTimer();
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
