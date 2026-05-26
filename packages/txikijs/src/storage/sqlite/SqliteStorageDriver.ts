import {
    type CloneableStorage,
    type DataNamespace,
    FilesystemStorageDriver,
    fromJson,
    type StorageDriver,
    type SupportedStorageTypes,
    toJson,
} from "@matter/general";

import { platformDatabaseCreator } from "./SqlitePlatform.js";
import type { DatabaseLike } from "./SqliteTypes.js";

export class SqliteStorageDriver extends FilesystemStorageDriver implements CloneableStorage {
    static readonly id = "sqlite";

    static async create(namespace: DataNamespace, _descriptor: StorageDriver.Descriptor) {
        const storage = new SqliteStorageDriver(namespace);
        await storage.initialize();
        return storage;
    }

    readonly #path: string;
    #db: DatabaseLike | undefined;
    #initialized = false;

    constructor(namespaceOrPath?: DataNamespace | string) {
        super(typeof namespaceOrPath === "string" || namespaceOrPath === undefined ? undefined : namespaceOrPath);
        this.#path =
            typeof namespaceOrPath === "string"
                ? namespaceOrPath
                : namespaceOrPath !== undefined
                  ? this.root!.directory.path
                  : ":memory:";
    }

    override async initialize() {
        if (this.#initialized) return;
        await super.initialize();

        const createDatabase = await platformDatabaseCreator();
        this.#db = await createDatabase(this.#path);

        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS kv_store (
                context TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                PRIMARY KEY (context, key)
            )
        `);

        this.#initialized = true;
    }

    get initialized() {
        return this.#initialized;
    }

    #ensureDb() {
        if (!this.#db) throw new Error("SqliteStorageDriver not initialized");
        return this.#db;
    }

    async get<T extends SupportedStorageTypes>(contexts: string[], key: string): Promise<T | undefined> {
        const db = this.#ensureDb();
        const ctx = contexts.join("\x00");
        const rows = db.prepare("SELECT value FROM kv_store WHERE context = ? AND key = ?").all(ctx, key) as {
            value: string | null;
        }[];
        if (rows.length === 0) return undefined;
        const value = rows[0].value;
        if (value === null || value === undefined) return undefined;
        return fromJson(value) as T;
    }

    set(contexts: string[], key: string, value: SupportedStorageTypes): Promise<void>;
    set(contexts: string[], values: Record<string, SupportedStorageTypes>): Promise<void>;
    async set(
        contexts: string[],
        keyOrValues: string | Record<string, SupportedStorageTypes>,
        value?: SupportedStorageTypes,
    ): Promise<void> {
        const db = this.#ensureDb();
        const ctx = contexts.join("\x00");
        const upsert = db.prepare(
            "INSERT OR REPLACE INTO kv_store (context, key, value) VALUES (?, ?, ?)",
        );

        if (typeof keyOrValues === "string") {
            upsert.run(ctx, keyOrValues, toJson(value));
        } else {
            for (const [key, val] of Object.entries(keyOrValues)) {
                upsert.run(ctx, key, toJson(val));
            }
        }
    }

    override async has(contexts: string[], key: string): Promise<boolean> {
        const db = this.#ensureDb();
        const ctx = contexts.join("\x00");
        const rows = db.prepare("SELECT 1 FROM kv_store WHERE context = ? AND key = ?").all(ctx, key) as unknown[];
        return rows.length > 0;
    }

    async delete(contexts: string[], key: string): Promise<void> {
        const db = this.#ensureDb();
        const ctx = contexts.join("\x00");
        db.prepare("DELETE FROM kv_store WHERE context = ? AND key = ?").run(ctx, key);
    }

    async keys(contexts: string[]): Promise<string[]> {
        const db = this.#ensureDb();
        const ctx = contexts.join("\x00");
        const rows = db.prepare(
            `SELECT key FROM kv_store WHERE context = ?`,
        ).all(ctx) as { key: string }[];
        return rows.map(r => r.key);
    }

    async values(contexts: string[]): Promise<Record<string, SupportedStorageTypes>> {
        const db = this.#ensureDb();
        const ctx = contexts.join("\x00");
        const rows = db.prepare(
            "SELECT key, value FROM kv_store WHERE context = ?",
        ).all(ctx) as { key: string; value: string }[];
        const result: Record<string, SupportedStorageTypes> = {};
        for (const row of rows) {
            if (row.value !== null) {
                result[row.key] = fromJson(row.value) as SupportedStorageTypes;
            }
        }
        return result;
    }

    contexts(contexts: string[]): string[] {
        const db = this.#ensureDb();
        const ctx = contexts.join("\x00");
        const rows = db.prepare(
            `SELECT DISTINCT SUBSTR(context, ?) AS child FROM kv_store WHERE context LIKE ? AND context != ?`,
        ).all(ctx.length + 1, `${ctx}\x00%`, ctx) as { child: string }[];
        const result = new Set<string>();
        for (const row of rows) {
            const child = row.child as string;
            const idx = child.indexOf("\x00");
            result.add(idx >= 0 ? child.substring(0, idx) : child);
        }
        return [...result];
    }

    async clearAll(contexts: string[]): Promise<void> {
        const db = this.#ensureDb();
        const ctx = contexts.join("\x00");
        db.prepare("DELETE FROM kv_store WHERE context = ?").run(ctx);
    }

    override async close() {
        if (this.#db) {
            this.#db.close();
            this.#db = undefined;
        }
        this.#initialized = false;
        await super.close();
    }

    async clone(): Promise<StorageDriver> {
        const clone = new SqliteStorageDriver(this.#path);
        await clone.initialize();
        const data = await this.snapshot();
        await clone.restore(data);
        return clone;
    }

    async snapshot(): Promise<Record<string, SupportedStorageTypes>> {
        const db = this.#ensureDb();
        const rows = db.prepare("SELECT context, key, value FROM kv_store").all() as {
            context: string;
            key: string;
            value: string | null;
        }[];
        const result: Record<string, SupportedStorageTypes> = {};
        for (const row of rows) {
            const key = `${row.context}\x00${row.key}`;
            if (row.value !== null) {
                result[key] = fromJson(row.value) as SupportedStorageTypes;
            }
        }
        return result;
    }

    async restore(data: Record<string, SupportedStorageTypes>): Promise<void> {
        const db = this.#ensureDb();
        db.exec("DELETE FROM kv_store");
        const insert = db.prepare("INSERT INTO kv_store (context, key, value) VALUES (?, ?, ?)");
        for (const [key, value] of Object.entries(data)) {
            const lastSep = key.lastIndexOf("\x00");
            const ctx = lastSep >= 0 ? key.substring(0, lastSep) : "";
            const k = lastSep >= 0 ? key.substring(lastSep + 1) : key;
            insert.run(ctx, k, toJson(value));
        }
    }
}
