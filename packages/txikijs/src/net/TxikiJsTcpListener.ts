import {
    Logger,
    NetworkError,
    Seconds,
    TcpConnection,
    TcpListener,
    TcpListenerOptions,
    Transport,
    withTimeout,
} from "@matter/general";
import { TxikiJsTcpConnection } from "./TxikiJsTcpConnection.js";

const logger = Logger.get("TxikiJsTcpListener");

const TCP_LISTEN_TIMEOUT = Seconds(10);
const TCP_LISTENER_CLOSE_TIMEOUT = Seconds(2);

export class TxikiJsTcpListener implements TcpListener {
    readonly #server: TCPServerSocket;
    readonly #activeSockets = new Set<TCPSocket>();
    readonly #port: number;

    static async create(options: TcpListenerOptions = {}): Promise<TxikiJsTcpListener> {
        const { listeningPort, listeningAddress } = options;
        const host = listeningAddress ?? "0.0.0.0";

        const server = new TCPServerSocket(host, {
            localPort: listeningPort,
            backlog: 511,
        });

        const openInfo = await withTimeout(TCP_LISTEN_TIMEOUT, server.opened, () => {
            server.close();
            throw new NetworkError("TCP server listen timeout");
        });

        const port = openInfo.localPort;
        logger.debug(`TCP server listening on ${listeningAddress ?? "all interfaces"} port ${port}`);

        return new TxikiJsTcpListener(server, port);
    }

    private constructor(server: TCPServerSocket, port: number) {
        this.#server = server;
        this.#port = port;
        this.#startAccepting();
    }

    async #startAccepting() {
        try {
            const openInfo = await this.#server.opened;
            const reader = openInfo.readable.getReader();

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const tcpSocket = value;
                this.#activeSockets.add(tcpSocket);
                tcpSocket.closed.then(() => this.#activeSockets.delete(tcpSocket)).catch(() => {});
                const connection = new TxikiJsTcpConnection(tcpSocket);
                for (const listener of this.#connectionListeners) {
                    listener(connection);
                }
            }
        } catch (error) {
            logger.debug("TCP listener accept loop ended:", error);
        }
    }

    #connectionListeners = new Set<(socket: TcpConnection) => void>();

    get port(): number {
        return this.#port;
    }

    onConnection(listener: (socket: TcpConnection) => void): Transport.Listener {
        this.#connectionListeners.add(listener);
        return {
            close: async () => {
                this.#connectionListeners.delete(listener);
            },
        };
    }

    async close(): Promise<void> {
        for (const socket of this.#activeSockets) {
            try { socket.close(); } catch {}
        }
        this.#activeSockets.clear();

        try {
            this.#server.close();
            await Promise.race([
                this.#server.closed,
                new Promise(resolve => setTimeout(resolve, TCP_LISTENER_CLOSE_TIMEOUT)),
            ]);
        } catch (error) {
            logger.warn("TCP listener close error:", error);
        }
    }
}
