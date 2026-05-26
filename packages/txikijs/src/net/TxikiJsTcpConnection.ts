import {
    Bytes,
    Logger,
    Seconds,
    TcpConnection,
    Transport,
} from "@matter/general";

const logger = Logger.get("TxikiJsTcpConnection");

const TCP_CLOSE_TIMEOUT = Seconds(5);

export class TxikiJsTcpConnection implements TcpConnection {
    readonly remoteAddress: string;
    readonly remotePort: number;
    readonly localPort: number;

    readonly #socket: TCPSocket;
    #readable: ReadableStream<Uint8Array> | undefined;
    #writable: WritableStream<Uint8Array> | undefined;
    #ended = false;
    #closePromise?: Promise<void>;

    #chunks = new Array<Uint8Array>();
    #waiter?: (value: IteratorResult<Bytes>) => void;

    constructor(socket: TCPSocket, openInfo?: TCPSocketOpenInfo) {
        this.#socket = socket;
        this.remoteAddress = openInfo?.remoteAddress ?? "";
        this.remotePort = openInfo?.remotePort ?? 0;
        this.localPort = openInfo?.localPort ?? 0;

        if (openInfo) {
            this.#setupStreams(openInfo);
        } else {
            socket.opened.then(info => this.#setupStreams(info)).catch(() => {});
        }
    }

    #setupStreams(openInfo: TCPSocketOpenInfo) {
        this.#readable = openInfo.readable;
        this.#writable = openInfo.writable;

        const reader = this.#readable.getReader();
        const readLoop = async () => {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        this.#ended = true;
                        this.#waiter?.({ value: undefined as unknown as Bytes, done: true });
                        this.#waiter = undefined;
                        break;
                    }
                    if (this.#waiter) {
                        const resolve = this.#waiter;
                        this.#waiter = undefined;
                        resolve({ value, done: false });
                    } else {
                        this.#chunks.push(value);
                    }
                }
            } catch {
                this.#ended = true;
                this.#waiter?.({ value: undefined as unknown as Bytes, done: true });
                this.#waiter = undefined;
            }
        };
        readLoop();
    }

    [Symbol.asyncIterator](): AsyncIterator<Bytes> {
        return {
            next: () => {
                if (this.#chunks.length > 0) {
                    const chunk = this.#chunks.shift()!;
                    return Promise.resolve({ value: chunk, done: false });
                }
                if (this.#ended) {
                    return Promise.resolve({ value: undefined as unknown as Bytes, done: true });
                }
                return new Promise<IteratorResult<Bytes>>(resolve => {
                    this.#waiter = resolve;
                });
            },
        };
    }

    async send(data: Bytes): Promise<void> {
        if (!this.#writable) {
            const info = await this.#socket.opened;
            this.#setupStreams(info);
        }
        if (!this.#writable) throw new Error("TCP connection not established");
        const writer = this.#writable.getWriter();
        try {
            await writer.write(Bytes.of(data));
        } finally {
            writer.releaseLock();
        }
    }

    onClose(listener: () => void): Transport.Listener {
        this.#socket.closed.then(() => {
            this.#ended = true;
            listener();
        }).catch(() => {});
        return {
            close: async () => {},
        };
    }

    onError(_listener: (error: Error) => void): Transport.Listener {
        return {
            close: async () => {},
        };
    }

    close(): Promise<void> {
        return (this.#closePromise ??= this.#doClose());
    }

    async #doClose(): Promise<void> {
        if (this.#ended) return;
        this.#ended = true;
        this.#waiter?.({ value: undefined as unknown as Bytes, done: true });
        this.#waiter = undefined;
        try {
            this.#socket.close();
            await Promise.race([
                this.#socket.closed,
                new Promise(resolve => setTimeout(resolve, TCP_CLOSE_TIMEOUT)),
            ]);
        } catch (error) {
            logger.warn(`Error closing TCP connection ${this.remoteAddress}:${this.remotePort}:`, error);
        }
    }
}
