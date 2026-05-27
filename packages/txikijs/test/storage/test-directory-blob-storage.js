import assert from 'tjs:assert';
import path from 'tjs:path';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let testDir;
let counter = 0;

async function setup() {
    testDir = await tjs.makeTempDir('tjs-dir-blob-XXXXXX');
}

async function cleanup() {
    if (testDir) {
        try { await tjs.remove(testDir); } catch (_) {}
    }
}

function createStream(data) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        },
    });
}

function createDirBlobDriver(basePath) {
    function contextPath(context) {
        return path.join(basePath, ...context.map(encodeURIComponent));
    }

    function keyPath(context, key) {
        return path.join(contextPath(context), encodeURIComponent(key));
    }

    return {
        async writeBlobFromStream(context, key, stream) {
            const dir = contextPath(context);
            await tjs.makeDir(dir, { recursive: true });
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
            await tjs.writeFile(keyPath(context, key), total);
        },

        async openBlob(context, key) {
            const fp = keyPath(context, key);
            try {
                const data = await tjs.readFile(fp);
                return new Blob([data]);
            } catch (_) {
                return new Blob([]);
            }
        },

        async has(context, key) {
            try {
                await tjs.stat(keyPath(context, key));
                return true;
            } catch (_) {
                return false;
            }
        },

        async keys(context) {
            const dir = contextPath(context);
            try {
                const iter = await tjs.readDir(dir);
                const result = [];
                for await (const item of iter) {
                    if (item.isFile) {
                        result.push(decodeURIComponent(item.name));
                    }
                }
                await iter.close();
                return result.sort();
            } catch (_) {
                return [];
            }
        },

        async delete(context, key) {
            const fp = keyPath(context, key);
            try { await tjs.remove(fp); } catch (_) {}
        },

        async contexts(context) {
            const dir = contextPath(context);
            try {
                const iter = await tjs.readDir(dir);
                const result = [];
                for await (const item of iter) {
                    if (item.isDirectory) {
                        result.push(decodeURIComponent(item.name));
                    }
                }
                await iter.close();
                return result.sort();
            } catch (_) {
                return [];
            }
        },

        async clearAll(context) {
            const dir = contextPath(context);
            try { await tjs.remove(dir); } catch (_) {}
        },
    };
}

async function writeAndReadRoundTrip() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await driver.writeBlobFromStream(['ctx'], 'myblob', createStream(data));

    const blob = await driver.openBlob(['ctx'], 'myblob');
    const result = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual([...result], [1, 2, 3, 4, 5], 'round-trip');

    await tjs.remove(storagePath);
}

async function openBlobReturnsEmptyForMissing() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    const blob = await driver.openBlob(['ctx'], 'nonexistent');
    assert.eq(blob.size, 0, 'empty blob for missing key');

    await tjs.remove(storagePath);
}

async function hasKey() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    assert.eq(await driver.has(['ctx'], 'key'), false, 'missing key');

    await driver.writeBlobFromStream(['ctx'], 'key', createStream(new Uint8Array([10])));
    assert.eq(await driver.has(['ctx'], 'key'), true, 'existing key');

    await tjs.remove(storagePath);
}

async function keysListing() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    await driver.writeBlobFromStream(['ctx'], 'a', createStream(new Uint8Array([1])));
    await driver.writeBlobFromStream(['ctx'], 'b', createStream(new Uint8Array([2])));

    const k = await driver.keys(['ctx']);
    assert.deepEqual(k, ['a', 'b'], 'keys listing');

    await tjs.remove(storagePath);
}

async function deleteKey() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    await driver.writeBlobFromStream(['ctx'], 'key', createStream(new Uint8Array([1])));
    assert.eq(await driver.has(['ctx'], 'key'), true, 'exists');

    await driver.delete(['ctx'], 'key');
    assert.eq(await driver.has(['ctx'], 'key'), false, 'deleted');

    await driver.delete(['ctx'], 'nope');

    await tjs.remove(storagePath);
}

async function nestedContexts() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    await driver.writeBlobFromStream(['a', 'b'], 'key', createStream(new Uint8Array([1])));
    await driver.writeBlobFromStream(['a', 'c'], 'key', createStream(new Uint8Array([2])));

    const ctxs = await driver.contexts(['a']);
    assert.deepEqual(ctxs.sort(), ['b', 'c'], 'nested contexts');

    await driver.writeBlobFromStream(['l1', 'l2', 'l3'], 'deep', createStream(new Uint8Array([42])));
    assert.eq(await driver.has(['l1', 'l2', 'l3'], 'deep'), true);
    assert.deepEqual(await driver.contexts(['l1']), ['l2']);
    assert.deepEqual(await driver.contexts(['l1', 'l2']), ['l3']);

    await tjs.remove(storagePath);
}

async function clearAll() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    await driver.writeBlobFromStream(['a', 'b'], 'k1', createStream(new Uint8Array([1])));
    await driver.writeBlobFromStream(['a', 'b', 'c'], 'k2', createStream(new Uint8Array([2])));

    await driver.clearAll(['a', 'b']);

    assert.eq(await driver.has(['a', 'b'], 'k1'), false);
    assert.eq(await driver.has(['a', 'b', 'c'], 'k2'), false);
    assert.deepEqual(await driver.contexts(['a']), []);

    await tjs.remove(storagePath);
}

async function blobSize() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    const data = new Uint8Array([10, 20, 30, 40, 50]);
    await driver.writeBlobFromStream(['ctx'], 'sized', createStream(data));

    const blob = await driver.openBlob(['ctx'], 'sized');
    assert.eq(blob.size, 5, 'blob size');

    await tjs.remove(storagePath);
}

async function specialCharsInContext() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

    await driver.writeBlobFromStream(['a/b', 'c'], 'key', createStream(new Uint8Array([1])));
    assert.eq(await driver.has(['a/b', 'c'], 'key'), true);
    assert.deepEqual(await driver.contexts([]), ['a/b']);
    assert.deepEqual(await driver.contexts(['a/b']), ['c']);

    await tjs.remove(storagePath);
}

async function multiChunkStream() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createDirBlobDriver(storagePath);

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

    await tjs.remove(storagePath);
}

await setup();
try {
    await writeAndReadRoundTrip();
    await openBlobReturnsEmptyForMissing();
    await hasKey();
    await keysListing();
    await deleteKey();
    await nestedContexts();
    await clearAll();
    await blobSize();
    await specialCharsInContext();
    await multiChunkStream();
} finally {
    await cleanup();
}
