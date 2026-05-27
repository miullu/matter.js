import assert from 'tjs:assert';
import path from 'tjs:path';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let testDir;

async function setup() {
    testDir = await tjs.makeTempDir('tjs-fs-test-XXXXXX');
}

async function cleanup() {
    if (testDir) {
        try { await tjs.remove(testDir); } catch (_) {}
    }
}

async function writeAndReadText() {
    const filePath = path.join(testDir, 'hello.txt');
    await tjs.writeFile(filePath, 'Hello, world!');

    const data = await tjs.readFile(filePath);
    assert.eq(decoder.decode(data), 'Hello, world!', 'write and readAllText');
}

async function writeAndReadBytes() {
    const filePath = path.join(testDir, 'data.bin');
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await tjs.writeFile(filePath, data);

    const result = await tjs.readFile(filePath);
    assert.deepEqual([...result], [1, 2, 3, 4, 5], 'write and readAllBytes');
}

async function fileExists() {
    const missingPath = path.join(testDir, 'nope.txt');
    let err;
    try { await tjs.stat(missingPath); } catch (e) { err = e; }
    assert.eq(err.code, 'ENOENT', 'exists returns false for missing file');

    const existingPath = path.join(testDir, 'exists.txt');
    await tjs.writeFile(existingPath, 'x');
    const st = await tjs.stat(existingPath);
    assert.ok(st.isFile, 'exists returns true for existing file');
}

async function statReturnsInfo() {
    const filePath = path.join(testDir, 'info.txt');
    await tjs.writeFile(filePath, 'hello');

    const st = await tjs.stat(filePath);
    assert.ok(st.isFile, 'type is file');
    assert.eq(st.size, 5, 'size is correct');
    assert.ok(st.mtim instanceof Date, 'mtime is Date');
}

async function statThrowsForMissing() {
    const missingPath = path.join(testDir, 'missing.txt');
    let err;
    try { await tjs.stat(missingPath); } catch (e) { err = e; }
    assert.ok(err, 'stat throws for missing file');
    assert.eq(err.code, 'ENOENT', 'error is ENOENT');
}

async function deleteFile() {
    const filePath = path.join(testDir, 'removeme.txt');
    await tjs.writeFile(filePath, 'bye');
    let st = await tjs.stat(filePath);
    assert.ok(st.isFile, 'file exists before delete');

    await tjs.remove(filePath);
    let err;
    try { await tjs.stat(filePath); } catch (e) { err = e; }
    assert.eq(err.code, 'ENOENT', 'file is gone after delete');
}

async function overwriteFile() {
    const filePath = path.join(testDir, 'overwrite.txt');
    await tjs.writeFile(filePath, 'first');
    await tjs.writeFile(filePath, 'second');

    const data = await tjs.readFile(filePath);
    assert.eq(decoder.decode(data), 'second', 'overwrite replaces content');
}

async function renameFile() {
    const oldPath = path.join(testDir, 'old.txt');
    const newPath = path.join(testDir, 'new.txt');
    await tjs.writeFile(oldPath, 'content');
    await tjs.rename(oldPath, newPath);

    const data = await tjs.readFile(newPath);
    assert.eq(decoder.decode(data), 'content', 'renamed file has content');

    let err;
    try { await tjs.stat(oldPath); } catch (e) { err = e; }
    assert.eq(err.code, 'ENOENT', 'old path no longer exists');
}

async function mkdir() {
    const dirPath = path.join(testDir, 'subdir');
    await tjs.makeDir(dirPath);
    const st = await tjs.stat(dirPath);
    assert.ok(st.isDirectory, 'mkdir creates a directory');
}

async function mkdirRecursive() {
    const dirPath = path.join(testDir, 'a', 'b', 'c');
    await tjs.makeDir(dirPath, { recursive: true });
    const st = await tjs.stat(dirPath);
    assert.ok(st.isDirectory, 'recursive mkdir works');
}

async function mkdirExistingNoop() {
    const dirPath = path.join(testDir, 'subdir2');
    await tjs.makeDir(dirPath);
    await tjs.makeDir(dirPath);
    const st = await tjs.stat(dirPath);
    assert.ok(st.isDirectory, 'mkdir existing is no-op');
}

async function listFiles() {
    const listingDir = path.join(testDir, 'listing');
    await tjs.makeDir(listingDir);
    await tjs.writeFile(path.join(listingDir, 'a.txt'), 'a');
    await tjs.writeFile(path.join(listingDir, 'b.txt'), 'b');

    const dirIter = await tjs.readDir(listingDir);
    const files = [];
    for await (const item of dirIter) {
        if (item.isFile) files.push(item.name);
    }
    await dirIter.close();

    assert.deepEqual(files.sort(), ['a.txt', 'b.txt'], 'files lists file names');
}

async function listDirectories() {
    const listingDir = path.join(testDir, 'listing2');
    await tjs.makeDir(listingDir);
    await tjs.makeDir(path.join(listingDir, 'sub1'));
    await tjs.makeDir(path.join(listingDir, 'sub2'));
    await tjs.writeFile(path.join(listingDir, 'a.txt'), 'a');

    const dirIter = await tjs.readDir(listingDir);
    const dirs = [];
    for await (const item of dirIter) {
        if (item.isDirectory) dirs.push(item.name);
    }
    await dirIter.close();

    assert.deepEqual(dirs.sort(), ['sub1', 'sub2'], 'directories lists subdirectory names');
}

async function listEntries() {
    const entriesDir = path.join(testDir, 'entries');
    await tjs.makeDir(entriesDir);
    await tjs.writeFile(path.join(entriesDir, 'f.txt'), 'f');
    await tjs.makeDir(path.join(entriesDir, 'd'));

    const dirIter = await tjs.readDir(entriesDir);
    const entries = [];
    for await (const item of dirIter) {
        entries.push({ name: item.name, kind: item.isDirectory ? 'directory' : 'file' });
    }
    await dirIter.close();

    entries.sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(entries, [
        { name: 'd', kind: 'directory' },
        { name: 'f.txt', kind: 'file' },
    ], 'entries yields file and directory objects');
}

async function deleteDirectoryRecursive() {
    const dirPath = path.join(testDir, 'todelete');
    await tjs.makeDir(dirPath);
    await tjs.writeFile(path.join(dirPath, 'f.txt'), 'x');
    await tjs.makeDir(path.join(dirPath, 'sub'));

    await tjs.remove(dirPath);
    let err;
    try { await tjs.stat(dirPath); } catch (e) { err = e; }
    assert.eq(err.code, 'ENOENT', 'directory removed recursively');
}

async function nestedFile() {
    const dirPath = path.join(testDir, 'a', 'b');
    await tjs.makeDir(dirPath, { recursive: true });
    const filePath = path.join(dirPath, 'deep.txt');
    await tjs.writeFile(filePath, 'deep');

    const data = await tjs.readFile(filePath);
    assert.eq(decoder.decode(data), 'deep', 'file in subdirectory with pre-created parent');
}

async function openReturnsFile() {
    const filePath = path.join(testDir, 'openfile.txt');
    await tjs.writeFile(filePath, 'hello');

    const fh = await tjs.open(filePath, 'r');
    const buf = new Uint8Array(32);
    const nread = await fh.read(buf);
    await fh.close();

    assert.eq(decoder.decode(buf.subarray(0, nread)), 'hello', 'open returns file handle for reading');
}

async function fileHandleReadableStream() {
    const filePath = path.join(testDir, 'stream.txt');
    await tjs.writeFile(filePath, 'stream content');

    const fh = await tjs.open(filePath, 'r');
    const reader = fh.readable.getReader();
    const chunks = [];
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    await fh.close();

    const combined = chunks.reduce((acc, v) => {
        const r = new Uint8Array(acc.length + v.length);
        r.set(acc);
        r.set(v, acc.length);
        return r;
    }, new Uint8Array(0));

    assert.eq(decoder.decode(combined), 'stream content', 'readable stream from file handle');
}

async function fileHandleWritableStream() {
    const filePath = path.join(testDir, 'wstream.txt');

    const fh = await tjs.open(filePath, 'w');
    const writer = fh.writable.getWriter();
    await writer.write(encoder.encode('written via '));
    await writer.write(encoder.encode('stream'));
    await writer.close();
    await fh.close();

    const data = await tjs.readFile(filePath);
    assert.eq(decoder.decode(data), 'written via stream', 'writable stream to file handle');
}

async function copyFile() {
    const src = path.join(testDir, 'src.txt');
    const dst = path.join(testDir, 'dst.txt');
    await tjs.writeFile(src, 'copy me');
    await tjs.copyFile(src, dst);

    const data = await tjs.readFile(dst);
    assert.eq(decoder.decode(data), 'copy me', 'copyFile duplicates content');
}

await setup();
try {
    await writeAndReadText();
    await writeAndReadBytes();
    await fileExists();
    await statReturnsInfo();
    await statThrowsForMissing();
    await deleteFile();
    await overwriteFile();
    await renameFile();
    await mkdir();
    await mkdirRecursive();
    await mkdirExistingNoop();
    await listFiles();
    await listDirectories();
    await listEntries();
    await deleteDirectoryRecursive();
    await nestedFile();
    await openReturnsFile();
    await fileHandleReadableStream();
    await fileHandleWritableStream();
    await copyFile();
} finally {
    await cleanup();
}
