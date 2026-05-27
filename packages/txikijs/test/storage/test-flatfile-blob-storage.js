import assert from 'tjs:assert';
import path from 'tjs:path';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let testDir;
let counter = 0;

async function setup() {
    testDir = await tjs.makeTempDir('tjs-flat-blob-XXXXXX');
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

function encodeName(context, key) {
    const parts = [...context, key];
    return parts.map(p => encodeURIComponent(p)).join('.');
}

function decodeName(fileName) {
    const parts = fileName.split('.');
    return {
        context: parts.slice(0, -1).map(p => decodeURIComponent(p)),
        key: decodeURIComponent(parts[parts.length - 1]),
    };
}

function createFlatBlobDriver(basePath) {
    return {
        async writeBlobFromStream(context, key, stream) {
            const fileName = encodeName(context, key);
            const filePath = path.join(basePath, fileName);
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
            await tjs.writeFile(filePath, total);
        },

        async openBlob(context, key) {
            const fileName = encodeName(context, key);
            const filePath = path.join(basePath, fileName);
            try {
                const data = await tjs.readFile(filePath);
                return new Blob([data]);
            } catch (_) {
                return new Blob([]);
            }
        },

        async has(context, key) {
            const fileName = encodeName(context, key);
            try {
                await tjs.stat(path.join(basePath, fileName));
                return true;
            } catch (_) {
                return false;
            }
        },

        async keys(context) {
            const prefix = context.map(c => encodeURIComponent(c)).join('.') + '.';
            try {
                const iter = await tjs.readDir(basePath);
                const result = [];
                for await (const item of iter) {
                    if (item.isFile && item.name.startsWith(prefix)) {
                        const decoded = decodeName(item.name);
                        result.push(decoded.key);
                    }
                }
                await iter.close();
                return result.sort();
            } catch (_) {
                return [];
            }
        },

        async delete(context, key) {
            const fileName = encodeName(context, key);
            try { await tjs.remove(path.join(basePath, fileName)); } catch (_) {}
        },

        async contexts(context) {
            const prefix = context.map(c => encodeURIComponent(c)).join('.');
            const prefixStr = prefix ? prefix + '.' : '';
            try {
                const iter = await tjs.readDir(basePath);
                const result = new Set();
                for await (const item of iter) {
                    if (item.isFile && item.name.startsWith(prefixStr)) {
                        const decoded = decodeName(item.name);
                        const ctxPart = decoded.context[context.length];
                        if (ctxPart !== undefined) {
                            result.add(ctxPart);
                        }
                    }
                }
                await iter.close();
                return [...result].sort();
            } catch (_) {
                return [];
            }
        },

        async clearAll(context) {
            if (context.length === 0) {
                const iter = await tjs.readDir(basePath);
                for await (const item of iter) {
                    if (item.isFile) {
                        try { await tjs.remove(path.join(basePath, item.name)); } catch (_) {}
                    }
                }
                await iter.close();
                return;
            }
            const prefix = context.map(c => encodeURIComponent(c)).join('.') + '.';
            const iter = await tjs.readDir(basePath);
            for await (const item of iter) {
                if (item.isFile && item.name.startsWith(prefix)) {
                    try { await tjs.remove(path.join(basePath, item.name)); } catch (_) {}
                }
            }
            await iter.close();
        },
    };
}

async function writeAndReadRoundTrip() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

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
    const driver = createFlatBlobDriver(storagePath);

    const blob = await driver.openBlob(['ctx'], 'nonexistent');
    assert.eq(blob.size, 0, 'empty blob for missing key');

    await tjs.remove(storagePath);
}

async function hasKey() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

    assert.eq(await driver.has(['ctx'], 'key'), false, 'missing key');

    await driver.writeBlobFromStream(['ctx'], 'key', createStream(new Uint8Array([10])));
    assert.eq(await driver.has(['ctx'], 'key'), true, 'existing key');

    await tjs.remove(storagePath);
}

async function keysListing() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

    await driver.writeBlobFromStream(['ctx'], 'a', createStream(new Uint8Array([1])));
    await driver.writeBlobFromStream(['ctx'], 'b', createStream(new Uint8Array([2])));

    const k = await driver.keys(['ctx']);
    assert.deepEqual(k, ['a', 'b'], 'keys listing');

    await tjs.remove(storagePath);
}

async function deleteKey() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

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
    const driver = createFlatBlobDriver(storagePath);

    await driver.writeBlobFromStream(['a', 'b'], 'key', createStream(new Uint8Array([1])));
    await driver.writeBlobFromStream(['a', 'c'], 'key', createStream(new Uint8Array([2])));

    const ctxs = await driver.contexts(['a']);
    assert.deepEqual(ctxs.sort(), ['b', 'c'], 'nested contexts');

    await tjs.remove(storagePath);
}

async function clearAll() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

    await driver.writeBlobFromStream(['a', 'b'], 'k1', createStream(new Uint8Array([1])));
    await driver.writeBlobFromStream(['a', 'b', 'c'], 'k2', createStream(new Uint8Array([2])));
    await driver.writeBlobFromStream(['a'], 'root', createStream(new Uint8Array([3])));

    await driver.clearAll(['a', 'b']);

    assert.eq(await driver.has(['a', 'b'], 'k1'), false);
    assert.eq(await driver.has(['a', 'b', 'c'], 'k2'), false);
    assert.eq(await driver.has(['a'], 'root'), true);

    await tjs.remove(storagePath);
}

async function blobSize() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

    const data = new Uint8Array([10, 20, 30, 40, 50]);
    await driver.writeBlobFromStream(['ctx'], 'sized', createStream(data));

    const blob = await driver.openBlob(['ctx'], 'sized');
    assert.eq(blob.size, 5, 'blob size');

    await tjs.remove(storagePath);
}

async function flatNamingConvention() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

    await driver.writeBlobFromStream(['bin', 'fff1', '8000'], 'prod', createStream(new Uint8Array([1])));

    const iter = await tjs.readDir(storagePath);
    const files = [];
    for await (const item of iter) {
        if (item.isFile) files.push(item.name);
    }
    await iter.close();

    assert.ok(files.includes('bin.fff1.8000.prod'), 'flat naming convention');

    await tjs.remove(storagePath);
}

async function specialCharacters() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

    await driver.writeBlobFromStream(['a b'], 'key', createStream(new Uint8Array([1])));
    assert.eq(await driver.has(['a b'], 'key'), true);
    assert.deepEqual(await driver.keys(['a b']), ['key']);
    assert.deepEqual(await driver.contexts([]), ['a b']);

    const iter = await tjs.readDir(storagePath);
    const files = [];
    for await (const item of iter) {
        if (item.isFile) files.push(item.name);
    }
    await iter.close();

    const encoded = files.find(f => f.includes('a%20b'));
    assert.ok(encoded, 'URI-encoded filename');

    await tjs.remove(storagePath);
}

async function multiChunkStream() {
    const storagePath = path.join(testDir, `test_${++counter}`);
    await tjs.makeDir(storagePath);
    const driver = createFlatBlobDriver(storagePath);

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
    await flatNamingConvention();
    await specialCharacters();
    await multiChunkStream();
} finally {
    await cleanup();
}
