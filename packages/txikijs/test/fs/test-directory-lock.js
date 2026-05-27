import assert from 'tjs:assert';
import path from 'tjs:path';

let testDir;

async function setup() {
    testDir = await tjs.makeTempDir('tjs-lock-test-XXXXXX');
}

async function cleanup() {
    if (testDir) {
        try { await tjs.remove(testDir); } catch (_) {}
    }
}

function acquireLock(dir, name) {
    const lockFile = path.join(dir, `matter_${name}.lock`);
    const pidFile = path.join(dir, `matter_${name}.pid`);

    async function tryLock() {
        try {
            const existingLock = await tjs.stat(lockFile);
            if (existingLock) {
                const pidData = await tjs.readFile(pidFile);
                const pidStr = decoder.decode(pidData).trim();
                const existingPid = parseInt(pidStr.split(/\s+/)[0], 10);
                if (existingPid === tjs.pid) {
                    throw new Error('Storage is already locked by this process');
                }
                try { tjs.kill(existingPid, 0); } catch (_) {
                    // Process is dead, clean up stale lock
                }
                throw new Error(`Storage is locked by another process (pid ${existingPid})`);
            }
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        const token = Math.random().toString(16).substring(2, 18);
        await tjs.writeFile(lockFile, '');
        await tjs.writeFile(pidFile, `${tjs.pid} ${token}`);

        return async () => {
            try { await tjs.remove(lockFile); } catch (_) {}
            try { await tjs.remove(pidFile); } catch (_) {}
        };
    }

    return tryLock();
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function acquiresAndReleasesLock() {
    const release = await acquireLock(testDir, 'test');

    let st;
    try { st = await tjs.stat(path.join(testDir, 'matter_test.lock')); } catch (_) {}
    assert.ok(st, 'lock file exists');

    let pidSt;
    try { pidSt = await tjs.stat(path.join(testDir, 'matter_test.pid')); } catch (_) {}
    assert.ok(pidSt, 'pid file exists');

    const pidContent = await tjs.readFile(path.join(testDir, 'matter_test.pid'));
    const parts = decoder.decode(pidContent).trim().split(/\s+/);
    assert.eq(parts.length, 2, 'pid file has two parts');
    assert.eq(parseInt(parts[0], 10), tjs.pid, 'pid matches current process');
    assert.ok(/^[0-9a-f]{16}$/.test(parts[1]), 'token is 16 hex chars');

    await release();

    let err;
    try { await tjs.stat(path.join(testDir, 'matter_test.lock')); } catch (e) { err = e; }
    assert.eq(err.code, 'ENOENT', 'lock file removed');

    try { await tjs.stat(path.join(testDir, 'matter_test.pid')); } catch (e) { err = e; }
    assert.eq(err.code, 'ENOENT', 'pid file removed');
}

async function throwsOnInProcessConflict() {
    const release = await acquireLock(testDir, 'conflict');
    try {
        let threw = false;
        try {
            await acquireLock(testDir, 'conflict');
        } catch (e) {
            threw = true;
            assert.ok(e.message.includes('already locked'), 'in-process conflict throws');
        }
        assert.ok(threw, 'throws on conflict');
    } finally {
        await release();
    }
}

async function cleansUpStaleLockFromDeadProcess() {
    const lockFile = path.join(testDir, 'matter_stale.lock');
    const pidFile = path.join(testDir, 'matter_stale.pid');

    await tjs.writeFile(lockFile, '');
    await tjs.writeFile(pidFile, '2147483647 deadbeefdeadbeef');

    const release = await acquireLock(testDir, 'stale');

    const pidContent = await tjs.readFile(pidFile);
    const currentPid = parseInt(decoder.decode(pidContent).trim().split(/\s+/)[0], 10);
    assert.eq(currentPid, tjs.pid, 'acquired stale lock');

    await release();
}

async function cleansUpStaleLockFromReusedPid() {
    const lockFile = path.join(testDir, 'matter_reused.lock');
    const pidFile = path.join(testDir, 'matter_reused.pid');

    await tjs.writeFile(lockFile, '');
    await tjs.writeFile(pidFile, `${tjs.pid} aaaaaaaaaaaaaaaa`);

    const release = await acquireLock(testDir, 'reused');

    const pidContent = await tjs.readFile(pidFile);
    const parts = decoder.decode(pidContent).trim().split(/\s+/);
    assert.eq(parseInt(parts[0], 10), tjs.pid, 'pid matches');
    assert.notEqual(parts[1], 'aaaaaaaaaaaaaaaa', 'token is different');

    await release();
}

async function cleansUpStaleLockFromOldFormat() {
    const lockFile = path.join(testDir, 'matter_old.lock');
    const pidFile = path.join(testDir, 'matter_old.pid');

    await tjs.writeFile(lockFile, '');
    await tjs.writeFile(pidFile, '2147483647');

    const release = await acquireLock(testDir, 'old');
    await release();
}

await setup();
try {
    await acquiresAndReleasesLock();
    await throwsOnInProcessConflict();
    await cleansUpStaleLockFromDeadProcess();
    await cleansUpStaleLockFromReusedPid();
    await cleansUpStaleLockFromOldFormat();
} finally {
    await cleanup();
}
