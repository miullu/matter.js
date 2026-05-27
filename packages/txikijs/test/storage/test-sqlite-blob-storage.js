import assert from 'tjs:assert';
import path from 'tjs:path';
import { Database } from 'tjs:sqlite';

let testDir;

async function setup() {
    testDir = await tjs.makeTempDir('tjs-sqlite-blob-XXXXXX');
}

async function cleanup() {
    if (testDir) {
        try { await tjs.remove(testDir); } catch (_) {}
    }
}

function createSqliteBlobDriver(dbPath) {
    const db = new Database(dbPath, { create: true });
    db.exec(`CREATE TABLE IF NOT EXISTS blobs (
        context TEXT NOT NULL,
        key TEXT NOT NULL,
        data BLOB,
        PRIMARY KEY (context, key)
    )`);

    const writeStmt = db.prepare('INSERT OR REPLACE INTO blobs (context, key, data) VALUES (?, ?, ?)');
    const readStmt = db.prepare('SELECT data FROM blobs WHERE context = ? AND key = ?');
    const hasStmt = db.prepare('SELECT COUNT(*) as cnt FROM blobs WHERE context = ? AND key = ?');
    const keysStmt = db.prepare('SELECT key FROM blobs WHERE context = ? ORDER BY key');
    const delStmt = db.prepare('DELETE FROM blobs WHERE context = ? AND key = ?');
    const contextsStmt = db.prepare('SELECT DISTINCT SUBSTR(context, ?) as ctx FROM blobs WHERE context LIKE ?');
    const clearStmt = db.prepare('DELETE FROM blobs WHERE context = ? OR context LIKE ?');

    function contextKey(ctxArr) {
        return ctxArr.join('/');
    }

    function contextLike(ctxArr) {
        return ctxArr.join('/') + '/%';
    }

    return {
        async writeBlobFromStream(context, key, stream) {
            const reader = stream.getReader();
            const chunks = [];
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const total = chunks.reduce((acc, v) => {
                const r = new Uint8Array(acc.length + v.length);
                r.set(acc);
                r.set(v, acc.length);
                return r;
            }, new Uint8Array(0));
            writeStmt.run(contextKey(context), key, total);
        },

        async openBlob(context, key) {
            const rows = readStmt.all(contextKey(context), key);
            if (rows.length === 0 || rows[0].data === null) {
                return new Blob([]);
            }
            return new Blob([rows[0].data]);
        },

        async has(context, key) {
            const rows = hasStmt.all(contextKey(context), key);
            return rows[0].cnt > 0;
        },

        async keys(context) {
            const rows = keysStmt.all(contextKey(context));
            return rows.map(r => r.key);
        },

        async delete(context, key) {
            delStmt.run(contextKey(context), key);
        },

        async contexts(context) {
            const ctx = contextKey(context);
            const like = contextLike(context);
            const prefixLen = ctx.length + 1;
            const rows = contextsStmt.all(prefixLen, like);
            const result = [];
            for (const row of rows) {
                const rest = row.ctx;
                if (rest && !rest.includes('/')) {
                    result.push(rest);
                }
            }
            return [...new Set(result)].sort();
        },

        async clearAll(context) {
            clearStmt.run(contextKey(context), contextLike(context));
        },

        close() {
            writeStmt.finalize();
            readStmt.finalize();
            hasStmt.finalize();
            keysStmt.finalize();
            delStmt.finalize();
            contextsStmt.finalize();
            clearStmt.finalize();
            db.close();
        },
    };
}

async function writeAndReadRoundTrip() {
    const dbPath = path.join(testDir, 'blobs.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(data);
                controller.close();
            },
        });

        await driver.writeBlobFromStream(['ctx'], 'blob1', stream);

        const blob = await driver.openBlob(['ctx'], 'blob1');
        const result = new Uint8Array(await blob.arrayBuffer());
        assert.deepEqual([...result], [1, 2, 3, 4, 5], 'round-trip');
    } finally {
        driver.close();
    }
}

async function openBlobReturnsEmptyForMissing() {
    const dbPath = path.join(testDir, 'missing.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        const blob = await driver.openBlob(['ctx'], 'nonexistent');
        assert.eq(blob.size, 0, 'empty blob for missing key');
    } finally {
        driver.close();
    }
}

async function hasKey() {
    const dbPath = path.join(testDir, 'has.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        assert.eq(await driver.has(['ctx'], 'key'), false, 'missing key');

        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([10]));
                controller.close();
            },
        });
        await driver.writeBlobFromStream(['ctx'], 'key', stream);

        assert.eq(await driver.has(['ctx'], 'key'), true, 'existing key');
    } finally {
        driver.close();
    }
}

async function keysListing() {
    const dbPath = path.join(testDir, 'keys.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        const stream1 = new ReadableStream({
            start(c) { c.enqueue(new Uint8Array([1])); c.close(); },
        });
        const stream2 = new ReadableStream({
            start(c) { c.enqueue(new Uint8Array([2])); c.close(); },
        });

        await driver.writeBlobFromStream(['ctx'], 'a', stream1);
        await driver.writeBlobFromStream(['ctx'], 'b', stream2);

        const k = await driver.keys(['ctx']);
        assert.deepEqual(k, ['a', 'b'], 'keys listing');
    } finally {
        driver.close();
    }
}

async function deleteKey() {
    const dbPath = path.join(testDir, 'delete.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        const stream = new ReadableStream({
            start(c) { c.enqueue(new Uint8Array([1])); c.close(); },
        });
        await driver.writeBlobFromStream(['ctx'], 'key', stream);

        assert.eq(await driver.has(['ctx'], 'key'), true, 'exists before delete');
        await driver.delete(['ctx'], 'key');
        assert.eq(await driver.has(['ctx'], 'key'), false, 'gone after delete');
    } finally {
        driver.close();
    }
}

async function clearAll() {
    const dbPath = path.join(testDir, 'clear.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        const s1 = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
        const s2 = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([2])); c.close(); } });

        await driver.writeBlobFromStream(['ctx'], 'k1', s1);
        await driver.writeBlobFromStream(['ctx', 'sub'], 'k2', s2);

        await driver.clearAll(['ctx']);

        assert.eq(await driver.has(['ctx'], 'k1'), false, 'cleared k1');
        assert.eq(await driver.has(['ctx', 'sub'], 'k2'), false, 'cleared k2');
    } finally {
        driver.close();
    }
}

async function blobSize() {
    const dbPath = path.join(testDir, 'size.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        const data = new Uint8Array(1024);
        for (let i = 0; i < data.length; i++) data[i] = i % 256;

        const stream = new ReadableStream({
            start(c) { c.enqueue(data); c.close(); },
        });
        await driver.writeBlobFromStream(['ctx'], 'large', stream);

        const blob = await driver.openBlob(['ctx'], 'large');
        assert.eq(blob.size, 1024, 'blob size is correct');

        const result = new Uint8Array(await blob.arrayBuffer());
        assert.deepEqual([...result], [...data], 'blob data matches');
    } finally {
        driver.close();
    }
}

async function overwriteBlob() {
    const dbPath = path.join(testDir, 'overwrite.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        const s1 = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
        const s2 = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([4, 5])); c.close(); } });

        await driver.writeBlobFromStream(['ctx'], 'key', s1);
        await driver.writeBlobFromStream(['ctx'], 'key', s2);

        const blob = await driver.openBlob(['ctx'], 'key');
        const result = new Uint8Array(await blob.arrayBuffer());
        assert.deepEqual([...result], [4, 5], 'overwritten blob');
    } finally {
        driver.close();
    }
}

async function multiChunkStream() {
    const dbPath = path.join(testDir, 'multi.db');
    const driver = createSqliteBlobDriver(dbPath);
    try {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.enqueue(new Uint8Array([3, 4]));
                controller.enqueue(new Uint8Array([5]));
                controller.close();
            },
        });

        await driver.writeBlobFromStream(['ctx'], 'multi', stream);
        const blob = await driver.openBlob(['ctx'], 'multi');
        const result = new Uint8Array(await blob.arrayBuffer());
        assert.deepEqual([...result], [1, 2, 3, 4, 5], 'multi-chunk stream');
    } finally {
        driver.close();
    }
}

await setup();
try {
    await writeAndReadRoundTrip();
    await openBlobReturnsEmptyForMissing();
    await hasKey();
    await keysListing();
    await deleteKey();
    await clearAll();
    await blobSize();
    await overwriteBlob();
    await multiChunkStream();
} finally {
    await cleanup();
}
