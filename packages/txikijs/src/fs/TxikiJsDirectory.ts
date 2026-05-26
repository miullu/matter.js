import { Directory, File, type Filesystem, type FilesystemNode, type MaybePromise } from "@matter/general";
import { nodeCopy, nodeEntries, nodeStat } from "./fs-utils.js";
import { acquireDirectoryLock } from "./lock-utils.js";
import { TxikiJsFile } from "./TxikiJsFile.js";

export class TxikiJsDirectory extends Directory {
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

    override get path() {
        return this.#path;
    }

    async exists(): Promise<boolean> {
        try {
            const s = await tjs.stat(this.#path);
            return s.isDirectory;
        } catch {
            return false;
        }
    }

    stat(): MaybePromise<FilesystemNode.Stat> {
        if (this.#cachedStat) {
            return this.#cachedStat;
        }
        return nodeStat(this.#path);
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

    async *entries(): AsyncIterable<Directory.Entry> {
        yield* nodeEntries(this.#fs, this.#path, TxikiJsFile, TxikiJsDirectory);
    }

    file(name: string): File {
        return new TxikiJsFile(this.#fs, `${this.#path}/${name}`, name);
    }

    directory(name: string): Directory {
        return new TxikiJsDirectory(this.#fs, `${this.#path}/${name}`, name);
    }

    async mkdir(): Promise<void> {
        await tjs.makeDir(this.#path, { recursive: true });
    }

    async copy(source: string | FilesystemNode, target: string | FilesystemNode): Promise<void> {
        await nodeCopy(this.#path, source, target);
    }

    override async lock(): Promise<() => Promise<void>> {
        await this.mkdir();
        return acquireDirectoryLock(this.#path, this.#name);
    }
}
