import { Directory, File, FileTypeError, Filesystem, type FilesystemNode } from "@matter/general";
import { TxikiJsDirectory } from "./TxikiJsDirectory.js";
import { TxikiJsFile } from "./TxikiJsFile.js";
import { nodeCopy, nodeEntries, nodeExists, nodeStat } from "./fs-utils.js";

export class TxikiJsFilesystem extends Filesystem {
    readonly #rootPath: string | (() => string);
    #tempCounter = 0;

    constructor(workingDirectory: string | (() => string)) {
        super();
        this.#rootPath = workingDirectory;
    }

    get name() {
        return "";
    }

    override get path() {
        return typeof this.#rootPath === "function" ? this.#rootPath() : this.#rootPath;
    }

    async exists(): Promise<boolean> {
        return nodeExists(this.path);
    }

    stat(): Promise<FilesystemNode.Stat> {
        return nodeStat(this.path);
    }

    rename(): Promise<void> {
        throw new FileTypeError("Cannot rename root");
    }

    async delete(): Promise<void> {
        await tjs.remove(this.path);
    }

    async *entries(): AsyncIterable<Directory.Entry> {
        yield* nodeEntries(this, this.path, TxikiJsFile, TxikiJsDirectory);
    }

    file(name: string): File {
        return new TxikiJsFile(this, `${this.path}/${name}`, name);
    }

    directory(name: string): Directory {
        return new TxikiJsDirectory(this, `${this.path}/${name}`, name);
    }

    async mkdir(): Promise<void> {
        await tjs.makeDir(this.path, { recursive: true });
    }

    async copy(source: string | FilesystemNode, target: string | FilesystemNode): Promise<void> {
        await nodeCopy(this.path, source, target);
    }

    tempFilename(): string {
        return `${tjs.tmpDir}/matter-${tjs.pid}-${Date.now()}-${this.#tempCounter++}`;
    }

    tempDirectory(): Directory {
        return new TxikiJsDirectory(this, this.tempFilename(), "");
    }
}
