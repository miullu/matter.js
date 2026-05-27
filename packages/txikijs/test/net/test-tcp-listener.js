import assert from 'tjs:assert';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function acceptsConnections() {
    const server = new TCPServerSocket('127.0.0.1');
    const { readable, localPort } = await server.opened;

    assert.ok(localPort > 0, 'reports correct port');

    const client = new TCPSocket('127.0.0.1', localPort);

    const serverReader = readable.getReader();
    const { value: conn } = await serverReader.read();
    assert.ok(conn, 'accepted a connection');
    const connInfo = await conn.opened;
    assert.ok(connInfo.remoteAddress, 'has remote address');
    assert.ok(connInfo.remotePort > 0, 'has remote port');

    conn.close();
    client.close();
    serverReader.releaseLock();
    server.close();
}

async function dataFlow() {
    const server = new TCPServerSocket('127.0.0.1');
    const { readable, localPort } = await server.opened;

    const received = new Promise((resolve) => {
        (async () => {
            const reader = readable.getReader();
            const { value: conn } = await reader.read();
            const { readable: connReadable } = await conn.opened;
            const connReader = connReadable.getReader();
            const { value } = await connReader.read();
            resolve(decoder.decode(value));
            conn.close();
            connReader.releaseLock();
            reader.releaseLock();
        })();
    });

    const client = new TCPSocket('127.0.0.1', localPort);
    const { writable } = await client.opened;
    const writer = writable.getWriter();
    await writer.write(encoder.encode('hello from client'));
    writer.close();

    const data = await received;
    assert.eq(data, 'hello from client', 'data flows from client to server');

    client.close();
    server.close();
}

async function stopsAcceptingAfterClose() {
    const server = new TCPServerSocket('127.0.0.1');
    const { localPort } = await server.opened;

    let connectionSeen = false;

    const acceptLoop = (async () => {
        const { readable } = await server.opened;
        const reader = readable.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            connectionSeen = true;
        }
        reader.releaseLock();
    })();

    server.close();

    try {
        const client = new TCPSocket('127.0.0.1', localPort);
        await client.opened;
        client.close();
        assert.eq(connectionSeen, false, 'no connection after close');
    } catch (_) {
        // Expected: connection refused
    }

    await acceptLoop;
}

async function usesOsAssignedPort() {
    const server = new TCPServerSocket('127.0.0.1');
    const { localPort } = await server.opened;
    assert.ok(localPort > 0, 'OS assigned a valid port');
    server.close();
}

await acceptsConnections();
await dataFlow();
await stopsAcceptingAfterClose();
await usesOsAssignedPort();
