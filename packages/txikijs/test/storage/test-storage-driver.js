import assert from 'tjs:assert';
import path from 'tjs:path';
import { Database } from 'tjs:sqlite';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let testDir;

async function setup() {
    testDir = await tjs.makeTempDir('tjs-sd-test-XXXXXX');
}

async function cleanup() {
    if (testDir) {
        try { await tjs.remove(testDir); } catch (_) {}
    }
}

async function fileBasedKV() {
    const ns = 'file_kv';
    const dir = path.join(testDir, ns);
    await tjs.makeDir(dir);

    async function set(context, key, value) {
        const ctxPath = context.length ? path.join(dir, ...context) : dir;
        await tjs.makeDir(ctxPath, { recursive: true });
        const filePath = path.join(ctxPath, `${key}.json`);
        await tjs.writeFile(filePath, JSON.stringify(value));
    }

    async function get(context, key) {
        const filePath = path.join(dir, ...context, `${key}.json`);
        try {
            const data = await tjs.readFile(filePath);
            return JSON.parse(decoder.decode(data));
        } catch (_) {
            return undefined;
        }
    }

    async function del(context, key) {
        const filePath = path.join(dir, ...context, `${key}.json`);
        try { await tjs.remove(filePath); } catch (_) {}
    }

    async function keys(context) {
        const ctxPath = context.length ? path.join(dir, ...context) : dir;
        try {
            const iter = await tjs.readDir(ctxPath);
            const result = [];
            for await (const item of iter) {
                if (item.isFile && item.name.endsWith('.json')) {
                    result.push(item.name.slice(0, -5));
                }
            }
            await iter.close();
            return result.sort();
        } catch (_) {
            return [];
        }
    }

    async function contexts(context) {
        const ctxPath = context.length ? path.join(dir, ...context) : dir;
        try {
            const iter = await tjs.readDir(ctxPath);
            const result = [];
            for await (const item of iter) {
                if (item.isDirectory) {
                    result.push(item.name);
                }
            }
            await iter.close();
            return result.sort();
        } catch (_) {
            return [];
        }
    }

    async function clearAll(context) {
        const ctxPath = context.length ? path.join(dir, ...context) : dir;
        try { await tjs.remove(ctxPath); } catch (_) {}
        await tjs.makeDir(ctxPath, { recursive: true });
    }

    const CONTEXTx1 = ['context'];
    const CONTEXTx2 = ['context', 'subcontext'];
    const CONTEXTx3 = ['context', 'subcontext', 'subsubcontext'];

    // Write and read
    await set(CONTEXTx1, 'key', 'value');
    assert.eq(await get(CONTEXTx1, 'key'), 'value', 'write and read');

    // Multi-write and read
    await set(CONTEXTx1, 'key', 'value');
    await set(CONTEXTx1, 'key2', 'value2');
    assert.eq(await get(CONTEXTx1, 'key'), 'value', 'multi-write key');
    assert.eq(await get(CONTEXTx1, 'key2'), 'value2', 'multi-write key2');

    // Delete
    await set(CONTEXTx1, 'key', 'value');
    await del(CONTEXTx1, 'key');
    assert.eq(await get(CONTEXTx1, 'key'), undefined, 'delete removes key');

    // Clear all
    await set(CONTEXTx1, 'key', 'value');
    await clearAll(CONTEXTx1);
    assert.eq(await get(CONTEXTx1, 'key'), undefined, 'clearAll removes keys');

    // Multiple context levels
    await set(CONTEXTx3, 'key', 'value');
    assert.eq(await get(CONTEXTx3, 'key'), 'value', 'nested context');

    // Keys listing
    await set(CONTEXTx3, 'key', 'value');
    assert.deepEqual(await keys(CONTEXTx3), ['key'], 'keys listing');

    // Contexts listing
    await set(CONTEXTx2, 'key', 'value');
    await set(['context', 'subcontext2'], 'key', 'value');
    await set(CONTEXTx3, 'key', 'value');

    assert.deepEqual(await contexts(CONTEXTx3), [], 'deepest context has no sub-contexts');
    assert.deepEqual(await contexts(CONTEXTx2), ['subsubcontext'], 'sub-context listing');
    assert.deepEqual((await contexts(CONTEXTx1)).sort(), ['subcontext', 'subcontext2'], 'context listing');

    // Root-level keys
    await set([], 'key', 'value');
    assert.eq(await get([], 'key'), 'value', 'root-level key');
    assert.deepEqual(await keys([]), ['key'], 'root-level keys');
    await del([], 'key');
    assert.deepEqual(await keys([]), [], 'root-level key removed');

    // Root-level keys coexist with context keys
    await set([], 'rootKey', 'rootValue');
    await set(CONTEXTx1, 'ctxKey', 'ctxValue');

    assert.deepEqual(await keys([]), ['rootKey'], 'root keys isolated');
    assert.eq(await get([], 'rootKey'), 'rootValue', 'root key value');
    assert.deepEqual(await keys(CONTEXTx1), ['ctxKey'], 'context keys unaffected');
}

async function sqliteKV() {
    const dbPath = path.join(testDir, 'sqlite_kv.db');
    const db = new Database(dbPath, { create: true });
    db.exec('CREATE TABLE IF NOT EXISTS storage (context TEXT, key TEXT, value TEXT, PRIMARY KEY(context, key))');
    db.exec('CREATE TABLE IF NOT EXISTS contexts (path TEXT PRIMARY KEY)');

    const ins = db.prepare('INSERT OR REPLACE INTO storage (context, key, value) VALUES (?, ?, ?)');
    const getStmt = db.prepare('SELECT value FROM storage WHERE context = ? AND key = ?');
    const delStmt = db.prepare('DELETE FROM storage WHERE context = ? AND key = ?');
    const keysStmt = db.prepare('SELECT key FROM storage WHERE context = ? ORDER BY key');
    const clearStmt = db.prepare('DELETE FROM storage WHERE context LIKE ?');

    async function set(context, key, value) {
        const ctx = context.join('.');
        if (typeof key === 'object') {
            for (const [k, v] of Object.entries(key)) {
                ins.run(ctx, k, JSON.stringify(v));
            }
        } else {
            ins.run(ctx, key, JSON.stringify(value));
        }
    }

    async function get(context, key) {
        const ctx = context.join('.');
        const rows = getStmt.all(ctx, key);
        if (rows.length === 0) return undefined;
        return JSON.parse(rows[0].value);
    }

    async function del(context, key) {
        delStmt.run(context.join('.'), key);
    }

    async function keys(context) {
        const rows = keysStmt.all(context.join('.'));
        return rows.map(r => r.key);
    }

    async function clearAll(context) {
        clearStmt.run(context.join('.') + '%');
    }

    const CONTEXTx1 = ['context'];
    const CONTEXTx3 = ['context', 'subcontext', 'subsubcontext'];

    await set(CONTEXTx1, 'key', 'value');
    assert.eq(await get(CONTEXTx1, 'key'), 'value', 'sqlite write and read');

    await set(CONTEXTx1, { key: 'value', key2: 'value2' });
    assert.eq(await get(CONTEXTx1, 'key'), 'value', 'sqlite multi-write');
    assert.eq(await get(CONTEXTx1, 'key2'), 'value2', 'sqlite multi-write key2');

    await del(CONTEXTx1, 'key');
    assert.eq(await get(CONTEXTx1, 'key'), undefined, 'sqlite delete');

    await set(CONTEXTx3, 'key', 'value');
    assert.eq(await get(CONTEXTx3, 'key'), 'value', 'sqlite nested context');

    await set(CONTEXTx1, 'key', 'value');
    await set(CONTEXTx1, 'key2', 'value2');
    assert.deepEqual(await keys(CONTEXTx1), ['key', 'key2'], 'sqlite keys');

    await set(CONTEXTx1, 'key', 'value');
    await clearAll(CONTEXTx1);
    assert.eq(await get(CONTEXTx1, 'key'), undefined, 'sqlite clearAll');

    db.close();
    await tjs.remove(dbPath);
}

await setup();
try {
    await fileBasedKV();
    await sqliteKV();
} finally {
    await cleanup();
}
