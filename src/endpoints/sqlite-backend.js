import { createRequire } from 'node:module';

/**
 * Runtime-detected SQLite backend.
 *
 * The chat storage layer needs a synchronous, blocking SQLite connection
 * (`DatabaseSync`-style API: `exec`, `prepare().run/.get/.all`). Node provides
 * this via the experimental builtin `node:sqlite`, while Bun provides it via
 * `bun:sqlite`. The two are NOT cross-available, so we resolve the right one
 * once at first use and reuse it for every connection.
 *
 * Detection is synchronous (`createRequire` + try/catch) so the public
 * `openDatabase()` stays synchronous and `getDatabase()` in sqlite-manager.js
 * does not need to become async.
 */

const require = createRequire(import.meta.url);

/** @type {{ kind: 'node' | 'bun', Database: any } | null} */
let resolved = null;

/**
 * Resolves (once) the available SQLite engine.
 * Prefers `node:sqlite`; falls back to `bun:sqlite` when running under Bun.
 * @returns {{ kind: 'node' | 'bun', Database: any }}
 */
function resolveBackend() {
    if (resolved) {
        return resolved;
    }
    try {
        // Node 22.5+ ships this as a require-able builtin.
        const mod = require('node:sqlite');
        resolved = { kind: 'node', Database: mod.DatabaseSync };
    } catch {
        // Under Bun, node:sqlite is absent — use Bun's own SQLite.
        const mod = require('bun:sqlite');
        resolved = { kind: 'bun', Database: mod.Database };
    }
    return resolved;
}

export function getBackendKind() {
    return resolveBackend().kind;
}

/**
 * Opens (or prepares) a SQLite database at `dbPath` with the schema and
 * connection pragmas the chat-storage layer expects. The returned connection
 * exposes `.exec()`, `.prepare()`, and statement methods `.run()/.get()/.all()`
 * identically across both engines.
 *
 * @param {string} dbPath Absolute path to the .db file
 * @param {string} schema SQL schema (CREATE TABLE / INDEX statements)
 * @returns {any} A DatabaseSync (node) or Database (bun) instance
 */
export function openDatabase(dbPath, schema) {
    const backend = resolveBackend();
    const db = backend.kind === 'node'
        ? new backend.Database(dbPath, { enableForeignKeyConstraints: true })
        : new backend.Database(dbPath);

    // WAL keeps the main .db file a clean, restorable snapshot after a
    // wal_checkpoint(TRUNCATE) — required by the file-level backup logic.
    db.exec('PRAGMA journal_mode = WAL;');
    // bun:sqlite has no constructor flag for FK enforcement; enable explicitly
    // for both engines (node already enforces via the option above, harmless dup).
    db.exec('PRAGMA foreign_keys = ON;');

    if (schema) {
        db.exec(schema);
    }
    return db;
}
