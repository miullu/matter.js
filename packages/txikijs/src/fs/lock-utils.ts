import { Logger, StorageLockError } from "@matter/general";

const logger = Logger.get("TxikiJsDirectoryLock");

const LOCK_FILE = "matter.lock";
const PID_FILE = "matter.pid";

const PROCESS_TOKEN = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

interface LockInfo {
    pid: number;
    token?: string;
}

export async function acquireDirectoryLock(dirPath: string, dirName: string): Promise<() => Promise<void>> {
    const lockPath = `${dirPath}/${LOCK_FILE}`;
    const pidPath = `${dirPath}/${PID_FILE}`;

    if (!(await dirExists(dirPath))) {
        return async () => {};
    }

    await acquireLock(lockPath, pidPath);
    await tjs.writeFile(pidPath, `${tjs.pid} ${PROCESS_TOKEN}`);

    logger.debug("Acquired storage lock for", dirName, "pid", tjs.pid);

    return async () => {
        await safeUnlink(pidPath);
        await safeUnlink(lockPath);
        logger.debug("Released storage lock for", dirName);
    };
}

async function acquireLock(lockPath: string, pidPath: string) {
    try {
        await tjs.open(lockPath, "x");
    } catch {
        const info = await readLockInfo(pidPath);

        if (isStale(info)) {
            logger.info("Cleaning stale storage lock");
            await safeUnlink(pidPath);
            await safeUnlink(lockPath);
            try {
                await tjs.open(lockPath, "x");
            } catch {
                throw new StorageLockError("Storage is locked by another process (lock reclaimed during retry)");
            }
        } else if (info?.pid === tjs.pid) {
            throw new StorageLockError("Storage is already locked by this process");
        } else {
            throw new StorageLockError(`Storage is locked by another process (pid ${info?.pid})`);
        }
    }
}

function isStale(info: LockInfo | undefined): boolean {
    if (info === undefined) {
        return true;
    }
    if (info.pid === tjs.pid) {
        return info.token !== PROCESS_TOKEN;
    }
    try {
        tjs.kill(info.pid, "SIGHUP");
        return false;
    } catch {
        return true;
    }
}

async function readLockInfo(pidPath: string): Promise<LockInfo | undefined> {
    try {
        const content = new TextDecoder().decode(await tjs.readFile(pidPath));
        const parts = content.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        if (!Number.isFinite(pid) || pid <= 0) {
            return undefined;
        }
        return { pid, token: parts[1] };
    } catch {
        return undefined;
    }
}

async function dirExists(path: string): Promise<boolean> {
    try {
        const s = await tjs.stat(path);
        return s.isDirectory;
    } catch {
        return false;
    }
}

async function safeUnlink(path: string) {
    try {
        await tjs.remove(path);
    } catch {
        // ignore
    }
}
