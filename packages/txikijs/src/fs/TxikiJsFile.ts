import {
    File,
    FileHandleTracker,
    FileTypeError,
    type Bytes,
    type Filesystem,
    type FilesystemNode,
    type MaybeAsyncIterable,
    type MaybePromise,
} from "@matter/general";
import { nodeExists, nodeStat, toBytes, writeData } from "./fs-utils.js";

export class TxikiJsFile extends File {
    readonly #fs: Filesystem;
    #path: string;
    #name: string;
    readonly #cachedStat?: FilesystemNode.Stat;

    constructor(fs: Filesystem, path: string, name: string, cachedStat?: FilesystemNode.Stat) {
        super();
        this.#fs = fs;
        this.#path = path;
        this.#name = name;
        this.#cachedStat = cachedStat;
    }

    override get fs() {
        return this.#fs;
    }

    get name() {
        return this.#name;
    }

    get path() {
        return this.#path;
    }

    async exists(): Promise<boolean> {
        return nodeExists(this.#path);
    }

    stat(): MaybePromise<FilesystemNode.Stat> {
        if (this.#cachedStat) {
            return this.#cachedStat;
        }
        return nodeStat(this.#path);
    }

    async *readBytes(): AsyncIterable<Uint8Array> {
        const s = await nodeStat(this.#path);
        if (s.type === "directory") {
            throw new FileTypeError("Cannot read bytes from a directory");
        }
        const data = await tjs.readFile(this.#path);
        yield data;
    }

    async *readText(options?: File.ReadTextOptions): AsyncIterable<string> {
        const s = await nodeStat(this.#path);
        if (s.type === "directory") {
            throw new FileTypeError("Cannot read text from a directory");
        }
        const data = new TextDecoder().decode(await tjs.readFile(this.#path));
        if (options?.lines) {
            const lines = data.split("\n");
            yield* lines;
        } else {
            yield data;
        }
    }

    async write(data: Bytes | string | MaybeAsyncIterable<Bytes> | MaybeAsyncIterable<string>): Promise<void> {
        await writeData(this.#path, data);
    }

    async open(purpose: string, mode?: File.OpenMode): Promise<File.Handle> {
        const flags = mode ?? "r";
        const tjsFlags = flags === "w" ? "w" : flags === "a" ? "a" : "r";
        const handle = await tjs.open(this.#path, tjsFlags);
        return new TxikiJsFileHandle({ fs: this.#fs, path: this.#path, name: this.#name, purpose, handle });
    }

    async rename(newName: string): Promise<void> {
        const newPath = `${this.#path.substring(0, this.#path.lastIndexOf("/"))}/${newName}`;
        await tjs.rename(this.#path, newPath);
        this.#path = newPath;
        this.#name = newName;
    }

    async delete(): Promise<void> {
        await tjs.remove(this.#path);
    }
}

class TxikiJsFileHandle extends File.Handle {
    readonly #fs: Filesystem;
    #path: string;
    #name: string;
    readonly purpose: string;
    readonly #handle: tjs.FileHandle;

    constructor(options: TxikiJsFileHandle.Options) {
        super();
        this.#fs = options.fs;
        this.#path = options.path;
        this.#name = options.name;
        this.purpose = options.purpose;
        this.#handle = options.handle;
        FileHandleTracker.register(this);
    }

    override get fs() {
        return this.#fs;
    }

    get name() {
        return this.#name;
    }

    get path() {
        return this.#path;
    }

    async exists(): Promise<boolean> {
        return nodeExists(this.#path);
    }

    stat(): MaybePromise<FilesystemNode.Stat> {
        return nodeStat(this.#path);
    }

    async *readBytes(): AsyncIterable<Uint8Array> {
        const data = await tjs.readFile(this.#path);
        yield data;
    }

    async *readText(options?: File.ReadTextOptions): AsyncIterable<string> {
        const data = new TextDecoder().decode(await tjs.readFile(this.#path));
        if (options?.lines) {
            const lines = data.split("\n");
            yield* lines;
        } else {
            yield data;
        }
    }

    async write(data: Bytes | string | MaybeAsyncIterable<Bytes> | MaybeAsyncIterable<string>): Promise<void> {
        await writeData(this.#path, data);
    }

    async open(_purpose: string): Promise<File.Handle> {
        return this;
    }

    async writeHandle(data: Bytes | string): Promise<void> {
        const buf = typeof data === "string" ? new TextEncoder().encode(data) : toBytes(data);
        await this.#handle.write(buf, 0);
    }

    cursor(max: number, bufferSize?: number): File.Cursor {
        return new TxikiJsCursor(this.#handle, max, bufferSize ?? 8192);
    }

    async truncate(size?: number): Promise<void> {
        await this.#handle.truncate(size ?? 0);
    }

    async fsync(): Promise<void> {
        await this.#handle.datasync();
    }

    async close(): Promise<void> {
        FileHandleTracker.unregister(this);
        await this.#handle.close();
    }

    async rename(newName: string): Promise<void> {
        const newPath = `${this.#path.substring(0, this.#path.lastIndexOf("/"))}/${newName}`;
        await tjs.rename(this.#path, newPath);
        this.#path = newPath;
        this.#name = newName;
    }

    async delete(): Promise<void> {
        await tjs.remove(this.#path);
    }
}

namespace TxikiJsFileHandle {
    export interface Options {
        fs: Filesystem;
        path: string;
        name: string;
        purpose: string;
        handle: tjs.FileHandle;
    }
}

class TxikiJsCursor extends File.Cursor {
    readonly #handle: tjs.FileHandle;
    readonly #shared: Uint8Array;

    constructor(handle: tjs.FileHandle, max: number, bufferSize: number) {
        super(max);
        this.#handle = handle;
        this.#shared = new Uint8Array(bufferSize);
    }

    protected override async readAt(position: number, length: number, copy?: boolean): Promise<Uint8Array> {
        if (copy || length > this.#shared.length) {
            const buf = new Uint8Array(length);
            const bytesRead = await this.#handle.read(buf, position);
            return bytesRead === null ? new Uint8Array(0) : bytesRead < length ? buf.subarray(0, bytesRead) : buf;
        }

        const bytesRead = await this.#handle.read(this.#shared, position);
        return bytesRead === null ? new Uint8Array(0) : this.#shared.subarray(0, bytesRead);
    }
}
