import {
    Cache,
    InterfaceType,
    Minutes,
    Network,
    NetworkError,
    NetworkInterface,
    NetworkInterfaceDetails,
    onSameNetwork,
    TCP_CONNECTION_TIMEOUT_MS,
    TcpConnection,
    TcpConnectOptions,
    TcpListener,
    TcpListenerOptions,
    UdpSocket,
    UdpSocketOptions,
} from "@matter/general";
import { TxikiJsTcpConnection } from "./TxikiJsTcpConnection.js";
import { TxikiJsTcpListener } from "./TxikiJsTcpListener.js";
import { TxikiJsUdpSocket } from "./TxikiJsUdpSocket.js";

export class TxikiJsNetwork extends Network {
    static getNetInterfaceZoneIpv6(netInterface: string): string | undefined {
        return netInterface;
    }

    static getDefaultNetInterface(): string | undefined {
        const interfaces = tjs.system.networkInterfaces;
        for (const info of interfaces) {
            if (!info.internal) {
                return info.name;
            }
        }
        return undefined;
    }

    static getNetInterfaceForIp(ip: string) {
        return this.netInterfaces.get(ip);
    }

    private static readonly netInterfaces = new Cache<string | undefined>(
        "Network interface",
        (ip: string) => this.getNetInterfaceForRemoteAddress(ip),
        Minutes(5),
    );

    override async close() {
        await TxikiJsNetwork.netInterfaces.close();
    }

    private static getNetInterfaceForRemoteAddress(ip: string) {
        if (ip.includes("%")) {
            return ip.split("%")[1];
        } else {
            const interfaces = tjs.system.networkInterfaces;
            for (const info of interfaces) {
                if (onSameNetwork(ip, info.address, info.netmask)) {
                    return info.name;
                }
            }
            return undefined;
        }
    }

    getNetInterfaces(configuration: NetworkInterface[] = []): NetworkInterface[] {
        const result = new Array<NetworkInterface>();
        const interfaces = tjs.system.networkInterfaces;
        for (const info of interfaces) {
            if (info.internal) continue;
            let type = InterfaceType.Ethernet;
            if (configuration.length > 0) {
                const nameType = configuration.find(({ name }) => name === info.name);
                if (nameType !== undefined && nameType.type !== undefined) {
                    type = nameType.type;
                }
            }
            if (!result.find(r => r.name === info.name)) {
                result.push({ name: info.name, type });
            }
        }
        return result;
    }

    getIpMac(netInterface: string): NetworkInterfaceDetails | undefined {
        const interfaces = tjs.system.networkInterfaces;
        const matches = interfaces.filter(info => info.name === netInterface);
        if (matches.length === 0) return undefined;
        const mac = matches[0].mac;
        const ipV4 = matches.filter(info => {
            const parts = info.address.split(".");
            return parts.length === 4;
        }).map(({ address }) => address);
        const ipV6 = matches.filter(info => {
            return info.address.includes(":");
        }).map(({ address }) => address);
        return { mac, ipV4, ipV6 };
    }

    override createUdpSocket(options: UdpSocketOptions): Promise<UdpSocket> {
        return TxikiJsUdpSocket.create(options);
    }

    override createTcpListener(options: TcpListenerOptions): Promise<TcpListener> {
        return TxikiJsTcpListener.create(options);
    }

    override async connectTcp(host: string, port: number, options?: TcpConnectOptions): Promise<TcpConnection> {
        if (options?.abort?.aborted) {
            throw new NetworkError("TCP connect aborted");
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let abortListener: (() => void) | undefined;

            const detachAbort = () => {
                if (abortListener !== undefined) {
                    options?.abort?.removeEventListener("abort", abortListener);
                    abortListener = undefined;
                }
            };

            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                detachAbort();
                fn();
            };

            const socket = new TCPSocket(host, port, {
                noDelay: true,
            });

            const onError = (error: Error) => {
                settle(() => {
                    try { socket.close(); } catch {}
                    reject(new NetworkError(error.message));
                });
            };

            const timeout = setTimeout(() => {
                settle(() => {
                    try { socket.close(); } catch {}
                    reject(new NetworkError("TCP connection timeout"));
                });
            }, options?.timeout ?? TCP_CONNECTION_TIMEOUT_MS);

            socket.opened.then(openInfo => {
                clearTimeout(timeout);
                settle(() => resolve(new TxikiJsTcpConnection(socket, openInfo)));
            }).catch(onError);

            abortListener = () => onError(new Error("TCP connect aborted"));
            options?.abort?.addEventListener("abort", abortListener, { once: true });
        });
    }
}
