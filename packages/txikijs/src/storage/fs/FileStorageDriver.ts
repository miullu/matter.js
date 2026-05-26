import {
    FilesystemStorageDriver,
    fromJson,
    Logger,
    MatterAggregateError,
    StorageDriver,
    StorageError,
    SupportedStorageTypes,
    toJson,
    type DataNamespace,
} from "@matter/general";

const logger = new Logger("TxikiJsFileStorageDriver");

interface ContextIndex {
    contexts?: Map<string, ContextIndex>;
    keys?: Set<string>;
}

export class FileStorageDriver extends FilesystemStorageDriver {
    static readonly id = "file";

    static async create(namespace: DataNamespace, _descriptor: StorageDriver.Descriptor) {
        const storage = new FileStorageDriver(namespace);
        try {
            await storage.initialize();
        } catch (error) {
            await storage.close().catch(() => {});
            throw error;
        }
        return storage;
    }

    readonly #path: string;
    readonly #clear: boolean;
    protected isInitialized = false;
    #writeFileBlocker = new Map<string, Promise<void>>();
    #index: ContextIndex = {};

    constructor(namespaceOrPath?: DataNamespace | string, clear = false) {
        super(typeof namespaceOrPath === "string" || namespaceOrPath === undefined ? undefined : namespaceOrPath);
        this.#path =
            typeof namespaceOrPath === "string"
                ? namespaceOrPath
                : namespaceOrPath !== undefined
                  ? this.root!.directory.path
                  : "";
        this.#clear = clear;
    }

    get initialized() {
        return this.isInitialized;
    }

    override async initialize() {
        if (this.isInitialized) {
            throw new StorageError("Storage already initialized!");
        }
        await super.initialize();

        if (this.#clear) {
            this.#index = {};
            await tjs.remove(this.#path).catch(() => {});
        }
        await tjs.makeDir(this.#path, { recursive: true }).catch(() => {});

        try {
            const dirHandle = await tjs.readDir(this.#path);
            try {
                for await (const dirent of dirHandle) {
                    if (StorageDriver.RESERVED_FILENAMES.has(dirent.name)) {
                        continue;
                    }
                    if (dirent.name.endsWith(".tmp")) {
                        logger.info("Deleting orphaned temp file", dirent.name);
                        await tjs.remove(`${this.#path}/${dirent.name}`).catch(() => {});
                        continue;
                    }
                    const parts = decodeURIComponent(dirent.name).split(".");
                    this.#markValue(parts.slice(0, -1), parts[parts.length - 1]);
                }
            } finally {
                await dirHandle.close();
            }
        } catch {
        }

        this.isInitialized = true;
    }

    #indexFor(contexts: string[]) {
        let node = this.#index;
        for (const name of contexts) {
            let child = node.contexts?.get(name);
            if (child === undefined) {
                child = {};
                if (!node.contexts) {
                    node.contexts = new Map();
                }
                node.contexts.set(name, child);
            }
            node = child;
        }
        return node;
    }

    #markValue(contexts: string[], key: string) {
        const index = this.#indexFor(contexts);
        if (!index.keys) {
            index.keys = new Set();
        }
        index.keys.add(key);
    }

    async #finishAllWrites(filename?: string) {
        if (
            (filename !== undefined && this.#writeFileBlocker.has(filename)) ||
            (filename === undefined && this.#writeFileBlocker.size > 0)
        ) {
            for (let i = 0; i < 10; i++) {
                await MatterAggregateError.allSettled(
                    filename !== undefined ? [this.#writeFileBlocker.get(filename)] : this.#writeFileBlocker.values(),
                    "Error on finishing all file system writes to storage",
                );
                if (!this.#writeFileBlocker.size) {
                    return;
                }
            }
            await this.#fsyncStorageDir();
        }
    }

    override async close() {
        this.isInitialized = false;
        await this.#finishAllWrites();
        await super.close();
    }

    filePath(fileName: string) {
        return `${this.#path}/${fileName}`;
    }

    getContextBaseKey(contexts: string[]) {
        for (const ctx of contexts) {
            if (!ctx.length || ctx.includes(".")) {
                throw new StorageError("Context must not contain empty segments or leading or trailing dots.");
            }
        }
        return contexts.join(".");
    }

    buildStorageKey(contexts: string[], key: string) {
        if (!key.length) {
            throw new StorageError("Key must not be an empty string.");
        }
        if (key === "tmp") {
            throw new StorageError(`Key "tmp" is reserved for atomic write operations.`);
        }
        const contextKey = this.getContextBaseKey(contexts);
        const rawName = contextKey.length ? `${contextKey}.${key}` : key;
        return encodeURIComponent(rawName)
            .replace(/[!'()]/g, (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
            .replace(/\*/g, "%2A");
    }

    override async has(contexts: string[], key: string): Promise<boolean> {
        const index = this.#indexFor(contexts);
        return !!index.keys?.has(key);
    }

    async get<T extends SupportedStorageTypes>(contexts: string[], key: string): Promise<T | undefined> {
        const fileName = this.filePath(this.buildStorageKey(contexts, key));
        await this.#finishAllWrites(fileName);

        let value: Uint8Array;
        try {
            value = await tjs.readFile(fileName);
        } catch {
            return undefined;
        }
        try {
            return fromJson(new TextDecoder().decode(value)) as T;
        } catch (error) {
            logger.error(`Failed to parse storage value for key ${key} in context ${contexts.join(".")}`);
        }
    }

    set(contexts: string[], key: string, value: SupportedStorageTypes): Promise<void>;
    set(contexts: string[], values: Record<string, SupportedStorageTypes>): Promise<void>;
    async set(
        contexts: string[],
        keyOrValues: string | Record<string, SupportedStorageTypes>,
        value?: SupportedStorageTypes,
    ) {
        if (typeof keyOrValues === "string") {
            return this.#writeFile(contexts, keyOrValues, toJson(value));
        }

        const promises = new Array<Promise<void>>();
        for (const [key, value] of Object.entries(keyOrValues)) {
            promises.push(this.#writeFile(contexts, key, toJson(value)));
        }
        await MatterAggregateError.allSettled(promises, "Error when writing values into filesystem storage");
    }

    async #writeFile(contexts: string[], key: string, valueOrStream: string): Promise<void> {
        const fileName = this.buildStorageKey(contexts, key);
        if (StorageDriver.RESERVED_FILENAMES.has(fileName)) {
            throw new StorageError(
                `Key "${key}" in context "${contexts.join(".")}" maps to reserved file "${fileName}"`,
            );
        }
        const blocker = this.#writeFileBlocker.get(fileName);
        if (blocker !== undefined) {
            await blocker;
            return this.#writeFile(contexts, key, valueOrStream);
        }

        const promise = this.#writeAndMoveFile(this.filePath(fileName), valueOrStream).finally(() => {
            this.#writeFileBlocker.delete(fileName);
            this.#markValue(contexts, key);
        });
        this.#writeFileBlocker.set(fileName, promise);

        return promise;
    }

    async #writeAndMoveFile(filepath: string, value: string): Promise<void> {
        const tmpName = `${filepath}.tmp`;
        await tjs.writeFile(tmpName, value);
        await tjs.rename(tmpName, filepath);
    }

    async #fsyncStorageDir() {
        try {
            const handle = await tjs.open(this.#path, "r");
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            logger.warn(`Failed to fsync storage directory ${this.#path}`, error);
        }
    }

    async delete(contexts: string[], key: string) {
        await this.#rm(this.buildStorageKey(contexts, key), this.#indexFor(contexts), key);
    }

    async #rm(filename: string, index: ContextIndex, key: string) {
        await this.#finishAllWrites(filename);
        return tjs.remove(this.filePath(filename)).catch(() => {}).finally(() => {
            index.keys?.delete(key);
        });
    }

    async keys(contexts: string[]) {
        const index = this.#indexFor(contexts);
        return index.keys ? [...index.keys] : [];
    }

    async values(contexts: string[]) {
        const values = {} as Record<string, SupportedStorageTypes>;

        const promises = new Array<Promise<void>>();
        for (const key of await this.keys(contexts)) {
            promises.push(
                (async () => {
                    const value = await this.get(contexts, key);
                    if (value !== undefined) {
                        values[key] = value;
                    }
                })(),
            );
        }
        await MatterAggregateError.allSettled(promises, "Error when reading values from filesystem storage");
        return values;
    }

    contexts(contexts: string[]): string[] {
        const index = this.#indexFor(contexts);
        return index.contexts ? [...index.contexts.keys()] : [];
    }

    async clearAll(contexts: string[]) {
        await this.#finishAllWrites();
        const parent = this.#indexFor(contexts.slice(0, -1));
        const name = contexts[contexts.length - 1];
        await this.#clearChildContext(contexts, parent, name);
    }

    async #clearChildContext(contexts: string[], parent: ContextIndex, name: string) {
        const index = parent.contexts?.get(name);
        if (index === undefined) {
            return;
        }

        if (index.contexts) {
            for (const name of index.contexts.keys()) {
                await this.#clearChildContext([...contexts, name], index, name);
            }
        }

        if (index.keys) {
            await MatterAggregateError.allSettled(
                [...index.keys].map(key => this.#rm(this.buildStorageKey(contexts, key), index, key)),
                `Error deleting keys of storage context ${contexts.join(".")}`,
            );
        }
    }
}
