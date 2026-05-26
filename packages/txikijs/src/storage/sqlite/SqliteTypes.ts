export interface DatabaseLike {
    prepare(sql: string): {
        run(...args: unknown[]): void;
        all(...args: unknown[]): unknown[];
        finalize(): void;
    };
    exec(sql: string): void;
    close(): void;
}

export type DatabaseCreator = (path: string) => DatabaseLike | Promise<DatabaseLike>;
