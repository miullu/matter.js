import assert from 'tjs:assert';
import path from 'tjs:path';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let testDir;

async function setup() {
    testDir = await tjs.makeTempDir('tjs-json-storage-XXXXXX');
}

async function cleanup() {
    if (testDir) {
        try { await tjs.remove(testDir); } catch (_) {}
    }
}

function getJsonPath() {
    return path.join(testDir, 'storage.json');
}

async function createJsonStorage(filePath) {
    try {
        const data = await tjs.readFile(filePath);
        return JSON.parse(decoder.decode(data));
    } catch (_) {
        return {};
    }
}

async function saveJsonStorage(filePath, data) {
    const json = JSON.stringify(data, null, 1);
    await tjs.writeFile(filePath, json);
}

async function writeAndRead() {
    const filePath = getJsonPath();

    // Write
    const data = {};
    if (!data.context) data.context = {};
    data.context.key = 'value';
    await saveJsonStorage(filePath, data);

    // Read back
    const read = await createJsonStorage(filePath);
    assert.eq(read.context?.key, 'value', 'write and read success');

    // Verify file content format
    const raw = await tjs.readFile(filePath);
    const expected = `{
 "context": {
  "key": "value"
 }
}`;
    assert.eq(decoder.decode(raw), expected, 'file format matches');
}

async function writeAndDelete() {
    const filePath = getJsonPath();

    const data = {};
    data.context = { key: 'value' };
    await saveJsonStorage(filePath, data);

    let read = await createJsonStorage(filePath);
    assert.eq(read.context?.key, 'value', 'value exists');

    // Delete
    delete read.context.key;
    await saveJsonStorage(filePath, read);

    read = await createJsonStorage(filePath);
    assert.eq(read.context?.key, undefined, 'value deleted');

    const raw = await tjs.readFile(filePath);
    const expected = `{
 "context": {}
}`;
    assert.eq(decoder.decode(raw), expected, 'empty context after delete');
}

async function rootLevelKeys() {
    const filePath = getJsonPath();

    const data = { key: 'value' };
    await saveJsonStorage(filePath, data);

    const read = await createJsonStorage(filePath);
    assert.eq(read.key, 'value', 'root-level key');

    delete read.key;
    await saveJsonStorage(filePath, read);

    const read2 = await createJsonStorage(filePath);
    assert.deepEqual(Object.keys(read2), [], 'root-level key removed');
}

async function multipleContextLevels() {
    const filePath = getJsonPath();

    const data = {
        context: {
            subcontext: {
                subsubcontext: {
                    key: 'deep value'
                }
            }
        }
    };
    await saveJsonStorage(filePath, data);

    const read = await createJsonStorage(filePath);
    assert.eq(read.context?.subcontext?.subsubcontext?.key, 'deep value', 'nested context');

    const raw = await tjs.readFile(filePath);
    const parsed = JSON.parse(decoder.decode(raw));
    assert.eq(parsed.context.subcontext.subsubcontext.key, 'deep value', 'nested structure persisted');
}

async function overwriteExisting() {
    const filePath = getJsonPath();

    let data = { context: { key: 'first' } };
    await saveJsonStorage(filePath, data);

    data = { context: { key: 'second' } };
    await saveJsonStorage(filePath, data);

    const read = await createJsonStorage(filePath);
    assert.eq(read.context?.key, 'second', 'overwritten value');
}

await setup();
try {
    await writeAndRead();
    await writeAndDelete();
    await rootLevelKeys();
    await multipleContextLevels();
    await overwriteExisting();
} finally {
    await cleanup();
}
