import {
    Directory,
    FileNotFoundError,
    FileTypeError,
    type Bytes,
    type Filesystem,
    type FilesystemNode,
    type MaybeAsyncIterable,
} from "@matter/general";

export async function nodeExists(path: string): Promise<boolean> {
    try {
        await tjs.stat(path);
        return true;
    } catch {
        return false;
    }
}

export async function nodeStat(path: string): Promise<FilesystemNode.Stat> {
    let s;
    try {
        s = await tjs.stat(path);
    } catch {
        throw new FileNotFoundError(`Not found: ${path}`);
    }
    return {
        size: s.size,
        mtime: s.mtim,
        type: s.isDirectory ? "directory" : "file",
    };
}

export async function* nodeEntries(
    _fs: Filesystem,
    dirPath: string,
    FileClass: new (fs: Filesystem, path: string, name: string, cachedStat?: FilesystemNode.Stat) => Directory.Entry,
    DirClass: new (fs: Filesystem, path: string, name: string, cachedStat?: FilesystemNode.Stat) => Directory,
): AsyncGenerator<Directory.Entry> {
    const dirHandle = await tjs.readDir(dirPath);
    try {
        for await (const dirent of dirHandle) {
            const fullPath = `${dirPath}/${dirent.name}`;
            const s = await tjs.stat(fullPath);
            const cached: FilesystemNode.Stat = {
                size: s.size,
                mtime: s.mtim,
                type: dirent.isDirectory ? "directory" : "file",
            };
            if (dirent.isDirectory) {
                yield new DirClass(_fs, fullPath, dirent.name, cached);
            } else {
                yield new FileClass(_fs, fullPath, dirent.name, cached);
            }
        }
    } finally {
        await dirHandle.close();
    }
}

export function resolveCopyArg(basePath: string, arg: string | FilesystemNode): string {
    if (typeof arg === "string") {
        return `${basePath}/${arg}`;
    }
    if ("path" in arg && typeof arg.path === "string") {
        return arg.path;
    }
    throw new FileTypeError("Cannot resolve path for copy argument");
}

export async function nodeCopy(basePath: string, source: string | FilesystemNode, target: string | FilesystemNode) {
    const srcPath = resolveCopyArg(basePath, source);
    const dstPath = resolveCopyArg(basePath, target);
    await tjs.copyFile(srcPath, dstPath);
}

export function isBytes(value: unknown): value is Bytes {
    return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer;
}

export function toBytes(value: Bytes): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(ArrayBuffer.isView(value) ? value.buffer : value);
}

export async function writeData(
    path: string,
    data: Bytes | string | MaybeAsyncIterable<Bytes> | MaybeAsyncIterable<string>,
): Promise<void> {
    if (typeof data === "string") {
        await tjs.writeFile(path, data);
        return;
    }
    if (isBytes(data)) {
        await tjs.writeFile(path, toBytes(data));
        return;
    }

    const encoder = new TextEncoder();
    const iter = Symbol.asyncIterator in data ? data[Symbol.asyncIterator]() : data[Symbol.iterator]();
    const first = await iter.next();

    if (first.done) {
        await tjs.writeFile(path, new Uint8Array(0));
        return;
    }

    const chunks: Uint8Array[] = [];
    const isText = typeof first.value === "string";
    if (isText) {
        chunks.push(encoder.encode(first.value as string));
        while (true) {
            const next = await iter.next();
            if (next.done) break;
            chunks.push(encoder.encode("\n" + (next.value as string)));
        }
    } else {
        chunks.push(toBytes(first.value as Bytes));
        while (true) {
            const next = await iter.next();
            if (next.done) break;
            chunks.push(toBytes(next.value as Bytes));
        }
    }

    const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    await tjs.writeFile(path, combined);
}
