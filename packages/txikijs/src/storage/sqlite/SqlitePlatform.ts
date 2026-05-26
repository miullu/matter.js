import { Logger } from "@matter/general";
import type { DatabaseCreator, DatabaseLike } from "./SqliteTypes.js";

const logger = Logger.get("SqlitePlatform");

export async function platformDatabaseCreator(): Promise<DatabaseCreator> {
    return async (path: string): Promise<DatabaseLike> => {
        const { Database } = await import("tjs:sqlite");
        const db = new Database(path, { create: true, readOnly: false });

        if (path !== ":memory:") {
            db.exec("PRAGMA journal_mode = WAL");
            db.exec("PRAGMA synchronous = NORMAL");
        }

        return {
            prepare(sql: string) {
                const stmt = db.prepare(sql);
                return {
                    run(...args: any[]) { stmt.run(...args); },
                    all(...args: any[]) { return stmt.all(...args); },
                    finalize() { stmt.finalize(); },
                };
            },
            exec(sql: string) {
                db.exec(sql);
            },
            close() {
                try {
                    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
                } catch (error) {
                    logger.warn("WAL checkpoint failed:", error);
                } finally {
                    db.close();
                }
            },
        };
    };
}
