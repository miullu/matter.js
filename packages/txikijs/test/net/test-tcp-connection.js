import assert from 'tjs:assert';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let server;
let serverPort;

async function setup() {
    server = new TCPServerSocket('127.0.0.1');
    const { localPort } = await server.opened;
    serverPort = localPort;
}

async function cleanup() {
    if (server) server.close();
}

async function connectClient() {
    const { readable: serverReadable } = await server.opened;
    const serverReader = serverReadable.getReader();

    const client = new TCPSocket('127.0.0.1', serverPort);
    const clientInfo = await client.opened;

    const { value: serverConn } = await serverReader.read();
    const serverConnInfo = await serverConn.opened;
    serverReader.releaseLock();

    return { client, clientInfo, serverConn, serverConnInfo };
}

async function exposesRemoteAddressAndPort() {
    const { client, serverConn, serverConnInfo, clientInfo } = await connectClient();
    try {
        assert.eq(clientInfo.remoteAddress, '127.0.0.1', 'remote address is localhost');
        assert.ok(clientInfo.localPort > 0, 'local port is set');
    } finally {
        serverConn.close();
        client.close();
    }
}

async function sendsDataToPeer() {
    const { client, serverConn, serverConnInfo } = await connectClient();
    try {
        const { writable: clientWritable } = await client.opened;
        const writer = clientWritable.getWriter();
        await writer.write(encoder.encode('hello'));

        const { readable: serverReadable } = await serverConn.opened;
        const reader = serverReadable.getReader();
        const { value } = await reader.read();
        assert.eq(decoder.decode(value), 'hello', 'data sent to peer');
        reader.releaseLock();
        writer.close();
    } finally {
        serverConn.close();
        client.close();
    }
}

async function receivesDataViaAsyncIteration() {
    const { client, serverConn } = await connectClient();
    try {
        const { writable: serverWritable } = await serverConn.opened;
        const writer = serverWritable.getWriter();
        await writer.write(encoder.encode('world'));

        const { readable: clientReadable } = await client.opened;
        const reader = clientReadable.getReader();
        const { value, done } = await reader.read();
        assert.eq(done, false, 'not done');
        assert.eq(decoder.decode(value), 'world', 'received data via iteration');
        reader.releaseLock();
        writer.close();
    } finally {
        serverConn.close();
        client.close();
    }
}

async function onCloseFiresWhenPeerDisconnects() {
    const { client, serverConn } = await connectClient();
    try {
        const closedPromise = client.closed;

        serverConn.close();

        await closedPromise;
    } finally {
        serverConn.close();
        client.close();
    }
}

async function concurrentCloseCalls() {
    const { client, serverConn } = await connectClient();
    try {
        serverConn.close();
        client.close();
    } catch (_) {
        // Should not throw
    }
}

await setup();
try {
    await exposesRemoteAddressAndPort();
    await sendsDataToPeer();
    await receivesDataViaAsyncIteration();
    await onCloseFiresWhenPeerDisconnects();
    await concurrentCloseCalls();
} finally {
    await cleanup();
}
