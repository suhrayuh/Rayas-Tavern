import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import { setConfigFilePath } from '../../src/util.js';

setConfigFilePath('config.yaml');

const root = path.join('C:/Users/8scou/AppData/Local/Temp/opencode', `rayas-backup-rotation-${process.pid}`);
globalThis.DATA_ROOT = root;

const { backupDatabase, closeAllDatabases, getDatabase } = await import('../../src/endpoints/sqlite-manager.js');
const userId = 'rotation-user';

try {
    getDatabase(userId).exec('PRAGMA user_version = 1;');
    const backupDir = path.join(root, userId, 'backups');

    await backupDatabase(userId, { maxBackups: 2 });
    await new Promise(resolve => setTimeout(resolve, 1100));
    await backupDatabase(userId, { maxBackups: 2 });

    const existing = fs.readdirSync(backupDir).filter(name => name.endsWith('.db'));
    assert.equal(existing.length, 2, 'two main snapshots are retained');

    for (const name of existing) {
        fs.writeFileSync(path.join(backupDir, `${name}-wal`), 'sidecar');
        fs.writeFileSync(path.join(backupDir, `${name}-shm`), 'sidecar');
    }

    await new Promise(resolve => setTimeout(resolve, 1100));
    await backupDatabase(userId, { maxBackups: 2 });

    const retained = fs.readdirSync(backupDir).filter(name => name.endsWith('.db'));
    assert.equal(retained.length, 2, 'WAL/SHM sidecars do not consume retention slots');
    console.log('database-backup-rotation regression passed');
} finally {
    closeAllDatabases();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
}
