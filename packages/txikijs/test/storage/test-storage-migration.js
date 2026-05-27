import assert from 'tjs:assert';
import path from 'tjs:path';
import { Database } from 'tjs:sqlite';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let testDir;

async function setup() {
    testDir = await tjs.makeTempDir('tjs-migration-XXXXXX');
}

async function cleanup() {
    if (testDir) {
        try { await tjs.remove(testDir); } catch (_) {}
    }
}

const CONTEXTx1 = ['context'];
const CONTEXTx2 = ['context', 'subcontext'];
const CONTEXTx3 = ['context', 'subcontext', 'subsubcontext'];

async function migrateKV(srcDir, tgtDir) {
    async function readAll(srcDir) {
        const result = { keys: {}, contexts: {} };
        const iter = await tjs.readDir(srcDir);
        for await (const item of iter) {
            if (item.isFile && item.name.endsWith('.json')) {
                const key = item.name.slice(0, -5);
                const data = await tjs.readFile(path.join(srcDir, item.name));
                result.keys[key] = JSON.parse(decoder.decode(data));
            }
            if (item.isDirectory) {
                result.contexts[item.name] = await readAll(path.join(srcDir, item.name));
            }
        }
        await iter.close();
        return result;
    }

    async function writeAll(tgtDir, data) {
        for (const [key, value] of Object.entries(data.keys)) {
            const fp = path.join(tgtDir, `${key}.json`);
            await tjs.writeFile(fp, JSON.stringify(value));
        }
        for (const [ctxName, ctxData] of Object.entries(data.contexts)) {
            const ctxDir = path.join(tgtDir, ctxName);
            await tjs.makeDir(ctxDir, { recursive: true });
            await writeAll(ctxDir, ctxData);
        }
    }

    const data = await readAll(srcDir);
    await writeAll(tgtDir, data);
}

function makeFileKV(dir) {
    return {
        async set(context, key, value) {
            const ctxDir = context.length ? path.join(dir, ...context) : dir;
            await tjs.makeDir(ctxDir, { recursive: true });
            const fp = path.join(ctxDir, `${key}.json`);
            await tjs.writeFile(fp, JSON.stringify(value));
        },
        async get(context, key) {
            const fp = path.join(dir, ...context, `${key}.json`);
            try {
                const data = await tjs.readFile(fp);
                return JSON.parse(decoder.decode(data));
            } catch (_) {
                return undefined;
            }
        },
        async keys(context) {
            const ctxDir = context.length ? path.join(dir, ...context) : dir;
            try {
                const iter = await tjs.readDir(ctxDir);
                const result = [];
                for await (const item of iter) {
                    if (item.isFile && item.name.endsWith('.json')) {
                        result.push(item.name.slice(0, -5));
                    }
                }
                await iter.close();
                return result;
            } catch (_) {
                return [];
            }
        },
        async contexts(context) {
            const ctxDir = context.length ? path.join(dir, ...context) : dir;
            try {
                const iter = await tjs.readDir(ctxDir);
                const result = [];
                for await (const item of iter) {
                    if (item.isDirectory) result.push(item.name);
                }
                await iter.close();
                return result;
            } catch (_) {
                return [];
            }
        },
        async close() {},
    };
}

function makeSqliteKV(dbPath) {
    const db = new Database(dbPath, { create: true });
    db.exec('CREATE TABLE IF NOT EXISTS storage (context TEXT, key TEXT, value TEXT, PRIMARY KEY(context, key))');
    const getStmt = db.prepare('SELECT value FROM storage WHERE context = ? AND key = ?');
    const setStmt = db.prepare('INSERT OR REPLACE INTO storage (context, key, value) VALUES (?, ?, ?)');

    return {
        async set(context, key, value) {
            setStmt.run(context.join('.'), key, JSON.stringify(value));
        },
        async get(context, key) {
            const rows = getStmt.all(context.join('.'), key);
            if (rows.length === 0) return undefined;
            return JSON.parse(rows[0].value);
        },
        async keys(context) {
            const ctxPrefix = context.join('.');
            const rows = db.prepare('SELECT key FROM storage WHERE context = ? ORDER BY key').all(ctxPrefix);
            return rows.map(r => r.key);
        },
        async contexts(context) {
            const ctxPrefix = context.join('.');
            const prefix = ctxPrefix ? ctxPrefix + '.' : '';
            const rows = db.prepare(`
                SELECT DISTINCT SUBSTR(context, ?) as rest FROM storage
                WHERE context LIKE ? AND context != ?
                AND SUBSTR(context, ?) NOT LIKE '%..%'
            `).all(prefix.length + 1, prefix + '%', ctxPrefix, prefix.length + 1);
            const result = [];
            for (const row of rows) {
                if (row.rest && !row.rest.includes('.')) {
                    result.push(row.rest);
                }
            }
            return [...new Set(result)].sort();
        },
        async close() {
            db.close();
        },
    };
}

async function migrateKVToSqlite(srcDir, tgtDbPath) {
    const src = makeFileKV(srcDir);
    const tgt = makeSqliteKV(tgtDbPath);

    async function recurse(context) {
        const keys = await src.keys(context);
        for (const key of keys) {
            const value = await src.get(context, key);
            await tgt.set(context, key, value);
        }
        const contexts = await src.contexts(context);
        for (const ctx of contexts) {
            await recurse([...context, ctx]);
        }
    }

    await recurse([]);
    await tgt.close();
}

async function migrateKVToKV(srcDir, tgtDir) {
    await migrateKV(srcDir, tgtDir);
}

// Tests

async function migrateContextKeyJson() {
    const srcDir = path.join(testDir, 'migrate_ck_src');
    const tgtDir = path.join(testDir, 'migrate_ck_tgt');
    await tjs.makeDir(srcDir, { recursive: true });

    const src = makeFileKV(srcDir);
    await src.set(CONTEXTx1, 'key1', 'value1');
    await src.set(CONTEXTx2, 'key2', 'value2');
    await src.set(CONTEXTx3, 'key3', 'value3');

    await migrateKVToKV(srcDir, tgtDir);

    const tgt = makeFileKV(tgtDir);
    assert.eq(await tgt.get(CONTEXTx1, 'key1'), 'value1', 'migrated key1');
    assert.eq(await tgt.get(CONTEXTx2, 'key2'), 'value2', 'migrated key2');
    assert.eq(await tgt.get(CONTEXTx3, 'key3'), 'value3', 'migrated key3');

    await tjs.remove(srcDir);
    await tjs.remove(tgtDir);
}

async function migrateNestedContexts() {
    const srcDir = path.join(testDir, 'migrate_nc_src');
    const tgtDir = path.join(testDir, 'migrate_nc_tgt');
    await tjs.makeDir(srcDir, { recursive: true });

    const src = makeFileKV(srcDir);
    await src.set(CONTEXTx1, 'root', 'rootValue');
    await src.set(CONTEXTx2, 'sub', 'subValue');
    await src.set(CONTEXTx3, 'deep', 'deepValue');

    await migrateKVToKV(srcDir, tgtDir);

    const tgt = makeFileKV(tgtDir);
    assert.eq(await tgt.get(CONTEXTx1, 'root'), 'rootValue', 'migrated root');
    assert.eq(await tgt.get(CONTEXTx2, 'sub'), 'subValue', 'migrated sub');
    assert.eq(await tgt.get(CONTEXTx3, 'deep'), 'deepValue', 'migrated deep');

    await tjs.remove(srcDir);
    await tjs.remove(tgtDir);
}

async function migrateRootLevelKeys() {
    const srcDir = path.join(testDir, 'migrate_rk_src');
    const tgtDir = path.join(testDir, 'migrate_rk_tgt');
    await tjs.makeDir(srcDir, { recursive: true });

    const src = makeFileKV(srcDir);
    await src.set([], 'rootKey', 'rootValue');
    await src.set(CONTEXTx1, 'ctxKey', 'ctxValue');

    await migrateKVToKV(srcDir, tgtDir);

    const tgt = makeFileKV(tgtDir);
    assert.eq(await tgt.get([], 'rootKey'), 'rootValue', 'migrated root key');
    assert.deepEqual(await tgt.keys([]), ['rootKey'], 'root keys');

    assert.eq(await tgt.get(CONTEXTx1, 'ctxKey'), 'ctxValue', 'migrated context key');
    assert.deepEqual(await tgt.keys(CONTEXTx1), ['ctxKey'], 'context keys');

    await tjs.remove(srcDir);
    await tjs.remove(tgtDir);
}

async function migrateFileToSqlite() {
    const srcDir = path.join(testDir, 'migrate_fs_src');
    const tgtPath = path.join(testDir, 'migrate_fs_tgt.db');
    await tjs.makeDir(srcDir, { recursive: true });

    const src = makeFileKV(srcDir);
    await src.set(CONTEXTx1, 'key1', 'value1');
    await src.set(CONTEXTx2, 'key2', 'value2');

    await migrateKVToSqlite(srcDir, tgtPath);

    const tgt = makeSqliteKV(tgtPath);
    assert.eq(await tgt.get(CONTEXTx1, 'key1'), 'value1', 'migrated to sqlite key1');
    assert.eq(await tgt.get(CONTEXTx2, 'key2'), 'value2', 'migrated to sqlite key2');

    await tgt.close();

    await tjs.remove(srcDir);
    await tjs.remove(tgtPath);
}

async function migrateSqliteToFile() {
    const srcPath = path.join(testDir, 'migrate_sf_src.db');
    const tgtDir = path.join(testDir, 'migrate_sf_tgt');
    await tjs.makeDir(tgtDir, { recursive: true });

    const src = makeSqliteKV(srcPath);
    await src.set(CONTEXTx1, 'key1', 'value1');
    await src.set(CONTEXTx2, 'key2', 'value2');
    await src.close();

    // Read from sqlite and write to file
    const src2 = makeSqliteKV(srcPath);
    const tgt = makeFileKV(tgtDir);

    const contextsToMigrate = [
        { ctx: [] },
        { ctx: CONTEXTx1 },
        { ctx: CONTEXTx2 },
    ];

    for (const { ctx } of contextsToMigrate) {
        const keys = await src2.keys(ctx);
        for (const key of keys) {
            const value = await src2.get(ctx, key);
            if (value !== undefined) {
                await tgt.set(ctx, key, value);
            }
        }
    }

    assert.eq(await tgt.get(CONTEXTx1, 'key1'), 'value1', 'migrated from sqlite key1');
    assert.eq(await tgt.get(CONTEXTx2, 'key2'), 'value2', 'migrated from sqlite key2');

    await src2.close();
    await tjs.remove(srcPath);
    await tjs.remove(tgtDir);
}

async function blobMigrationDirToDir() {
    const srcDir = path.join(testDir, 'blob_src');
    const tgtDir = path.join(testDir, 'blob_tgt');
    await tjs.makeDir(srcDir, { recursive: true });

    // Write blob data as files in source
    const blobData = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const blobDir = path.join(srcDir, 'ctx1', 'ctx2');
    await tjs.makeDir(blobDir, { recursive: true });
    await tjs.writeFile(path.join(blobDir, 'myblob'), blobData);

    // Migrate by copying files
    async function copyDir(src, dst) {
        await tjs.makeDir(dst, { recursive: true });
        const iter = await tjs.readDir(src);
        for await (const item of iter) {
            const srcPath = path.join(src, item.name);
            const dstPath = path.join(dst, item.name);
            if (item.isFile) {
                const data = await tjs.readFile(srcPath);
                await tjs.writeFile(dstPath, data);
            } else if (item.isDirectory) {
                await copyDir(srcPath, dstPath);
            }
        }
        await iter.close();
    }

    await copyDir(srcDir, tgtDir);

    const recovered = await tjs.readFile(path.join(tgtDir, 'ctx1', 'ctx2', 'myblob'));
    assert.deepEqual([...recovered], [0xca, 0xfe, 0xba, 0xbe], 'blob migrated dir-to-dir');

    await tjs.remove(srcDir);
    await tjs.remove(tgtDir);
}

async function blobMigrationDirToFlat() {
    const srcDir = path.join(testDir, 'blob_d2f_src');
    const tgtDir = path.join(testDir, 'blob_d2f_tgt');
    await tjs.makeDir(srcDir, { recursive: true });
    await tjs.makeDir(tgtDir, { recursive: true });

    const blobData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const blobDir = path.join(srcDir, 'ctx1', 'ctx2');
    await tjs.makeDir(blobDir, { recursive: true });
    await tjs.writeFile(path.join(blobDir, 'myblob'), blobData);

    // Migrate dir structure to flat (context.key naming)
    const recoveredData = await tjs.readFile(path.join(blobDir, 'myblob'));
    await tjs.writeFile(path.join(tgtDir, 'ctx1.ctx2.myblob'), recoveredData);

    const flatData = await tjs.readFile(path.join(tgtDir, 'ctx1.ctx2.myblob'));
    assert.deepEqual([...flatData], [0xde, 0xad, 0xbe, 0xef], 'blob migrated dir-to-flat');

    await tjs.remove(srcDir);
    await tjs.remove(tgtDir);
}

await setup();
try {
    await migrateContextKeyJson();
    await migrateNestedContexts();
    await migrateRootLevelKeys();
    await migrateFileToSqlite();
    await migrateSqliteToFile();
    await blobMigrationDirToDir();
    await blobMigrationDirToFlat();
} finally {
    await cleanup();
}
