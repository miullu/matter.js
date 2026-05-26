import {
    Bytes,
    ChannelType,
    createPromise,
    Diagnostic,
    isIPv4,
    isIPv6,
    Lifetime,
    Logger,
    MAX_UDP_MESSAGE_SIZE,
    Millis,
    NetworkError,
    repackErrorAs,
    Seconds,
    Time,
    UdpSocket,
    UdpSocketOptions,
    UdpSocketType,
} from "@matter/general";
import { TxikiJsNetwork } from "./TxikiJsNetwork.js";

const logger = Logger.get("TxikiJsUdpSocket");

const UDP_SEND_TIMEOUT_CHECK_INTERVAL = Seconds.one;

export class TxikiJsUdpSocket implements UdpSocket {
    readonly #lifetime: Lifetime;
    readonly #type: UdpSocketType;
    #socket: UDPSocket | undefined;
    readonly #netInterface: string | undefined;
    #observedInterface?: string;
    #listeningAddress?: string;
    #listeningPort?: number;
    #opened = false;

    static async create({
        lifetime: lifetimeOwner,
        listeningPort,
        type,
        listeningAddress,
        netInterface,
    }: UdpSocketOptions) {
        const name = `${listeningAddress?.includes(":") ? `[${listeningAddress}]` : (listeningAddress ?? "*")}:${listeningPort}`;
        using lifetime = (lifetimeOwner ?? Lifetime.process).join("socket", Diagnostic.strong(name));
        lifetime.details.intf = netInterface;

        return new TxikiJsUdpSocket(lifetime, type, listeningAddress, listeningPort, netInterface);
    }

    readonly maxPayloadSize = MAX_UDP_MESSAGE_SIZE;

    readonly #sendTimer = Time.getTimer("UDPChannel.send timeout check", UDP_SEND_TIMEOUT_CHECK_INTERVAL, () =>
        this.#rejectDanglingSends(),
    );
    readonly #sendsInProgress = new Map<Promise<void>, { sendMs: number; rejecter: (reason?: any) => void }>();

    private constructor(
        lifetime: Lifetime,
        type: UdpSocketType,
        listeningAddress?: string,
        listeningPort?: number,
        netInterface?: string,
    ) {
        this.#lifetime = lifetime;
        this.#type = type;
        this.#listeningAddress = listeningAddress;
        this.#listeningPort = listeningPort;
        this.#netInterface = netInterface;
    }

    async #ensureOpened() {
        if (this.#opened) return;

        const localPort = this.#listeningPort ?? 0;
        const localAddress = this.#listeningAddress;

        const options: UDPSocketOptions = {};
        if (localAddress) {
            options.localAddress = localAddress;
        }
        if (localPort > 0) {
            options.localPort = localPort;
        }
        if (this.#type === "udp6") {
            options.ipv6Only = true;
        }

        this.#socket = new UDPSocket(options);
        const openInfo = await this.#socket.opened;
        this.#listeningAddress = openInfo.localAddress;
        this.#listeningPort = openInfo.localPort;
        this.#opened = true;

        logger.debug(
            "Socket created and bound ",
            Diagnostic.dict({
                localAddress: `${openInfo.localAddress}:${openInfo.localPort}`,
            }),
        );

        this.#startReading(openInfo);
    }

    #startReading(openInfo: UDPSocketOpenInfo) {
        const reader = openInfo.readable.getReader();

        const readLoop = async () => {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    this.#onMessage(value);
                }
            } catch (error) {
                logger.debug("UDP read loop error:", error);
            }
        };
        readLoop();
    }

    #dataListeners = new Set<
        (netInterface: string | undefined, peerAddress: string, peerPort: number, data: Bytes) => void
    >();

    #onMessage(message: UDPMessage) {
        const peerAddress = message.remoteAddress ?? "";
        const peerPort = message.remotePort ?? 0;
        const netInterface = this.#netInterface ?? TxikiJsNetwork.getNetInterfaceForIp(peerAddress);
        if (netInterface && this.#observedInterface === undefined) {
            this.#observedInterface = netInterface;
        }
        for (const listener of this.#dataListeners) {
            listener(netInterface, peerAddress, peerPort, message.data);
        }
    }

    async #getMulticastController() {
        if (!this.#socket) return undefined;
        const info = await this.#socket.opened;
        return info.multicastController;
    }

    async addMembership(membershipAddress: string) {
        await this.#ensureOpened();
        const controller = await this.#getMulticastController();
        if (!controller) {
            logger.warn(`Cannot add membership for ${membershipAddress}: no multicast controller`);
            return;
        }
        try {
            await controller.joinGroup(membershipAddress);
        } catch (error) {
            logger.warn(`Error adding membership for address ${membershipAddress}: ${error}`);
        }
    }

    async dropMembership(membershipAddress: string) {
        await this.#ensureOpened();
        const controller = await this.#getMulticastController();
        if (!controller) {
            logger.warn(`Cannot drop membership for ${membershipAddress}: no multicast controller`);
            return;
        }
        try {
            await controller.leaveGroup(membershipAddress);
        } catch (error) {
            logger.warn(`Error removing membership for address ${membershipAddress}: ${error}`);
        }
    }

    onData(listener: (netInterface: string | undefined, peerAddress: string, peerPort: number, data: Bytes) => void) {
        this.#dataListeners.add(listener);
        return {
            close: async () => {
                this.#dataListeners.delete(listener);
            },
        };
    }

    #rejectDanglingSends() {
        if (this.#sendsInProgress.size === 0) {
            return;
        }
        const now = Time.nowMs;
        for (const [promise, { sendMs, rejecter }] of this.#sendsInProgress) {
            const elapsed = Millis(now - sendMs);
            if (elapsed >= UDP_SEND_TIMEOUT_CHECK_INTERVAL) {
                this.#sendsInProgress.delete(promise);
                rejecter(new NetworkError("UDP send timeout"));
            }
        }
        if (this.#sendsInProgress.size > 0) {
            this.#sendTimer.start();
        }
    }

    async send(host: string, port: number, data: Bytes) {
        await this.#ensureOpened();

        const { promise, resolver, rejecter } = createPromise<void>();

        this.#sendsInProgress.set(promise, { sendMs: Time.nowMs, rejecter });
        if (!this.#sendTimer.isRunning) {
            this.#sendTimer.start();
        }

        try {
            if (!this.#socket) throw new NetworkError("Socket not opened");
            const writer = (await this.#socket.opened).writable.getWriter();
            const message: UDPMessage = {
                data: Bytes.of(data),
                remoteAddress: host,
                remotePort: port,
            };
            await writer.write(message);
            writer.releaseLock();
            this.#sendsInProgress.delete(promise);
            resolver();
        } catch (error) {
            this.#sendsInProgress.delete(promise);
            rejecter(repackErrorAs(error, NetworkError));
        }

        return promise;
    }

    async close() {
        using _closing = this.#lifetime.closing();
        this.#sendTimer.stop();
        if (this.#socket) {
            try {
                this.#socket.close();
                await this.#socket.closed;
            } catch (error) {
                logger.debug("Error on closing socket", error);
            }
        }
    }

    get port() {
        return this.#listeningPort ?? 0;
    }

    supports(type: ChannelType, address?: string) {
        if (type !== ChannelType.UDP) {
            return false;
        }
        if (address === undefined) {
            return true;
        }
        if (this.#type === "udp4") {
            return isIPv4(address);
        }
        return isIPv6(address);
    }
}
