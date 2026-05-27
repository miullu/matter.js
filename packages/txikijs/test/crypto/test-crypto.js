import assert from 'tjs:assert';
import { createHash } from 'tjs:hashing';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function encryptDecrypt() {
    const key = await crypto.subtle.importKey(
        'raw',
        hexToBytes('abf227feffea8c38e688ddcbffc459f1'),
        { name: 'AES-CCM', length: 128 },
        false,
        ['encrypt', 'decrypt']
    );

    const plainData = hexToBytes('03104f3c0000e98ceb00');
    const nonce = hexToBytes('000ce399000000000000000000');
    const additionalData = hexToBytes('00456a000ce39900');

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-CCM', iv: nonce, additionalData, tagLength: 32 },
        key,
        plainData
    );

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CCM', iv: nonce, additionalData, tagLength: 32 },
        key,
        encrypted
    );

    assert.eq(
        bytesToHex(new Uint8Array(decrypted)),
        bytesToHex(plainData),
        'AES-CCM encrypt/decrypt round-trip'
    );
}

async function sha256Hash() {
    const data = hexToBytes('047e708746f3d9fb3265a73f0c69ad18cdd48860d7956731eb72873f3d09c17b667c13737017574bf3f826239ff27cdb52fb3e69ff4a06ffd2cbccfdc695ff6096');
    const expectedHash = '582418375f09bff6b3bbb2421206ad6aec3c79ff2602f95a68d3e4d23bebe36f';

    const hash = await crypto.subtle.digest('SHA-256', data);
    const hashHex = bytesToHex(new Uint8Array(hash));
    assert.eq(hashHex, expectedHash, 'SHA-256 hash via Web Crypto matches');
}

async function sha256HashTjs() {
    const data = '047e708746f3d9fb3265a73f0c69ad18cdd48860d7956731eb72873f3d09c17b667c13737017574bf3f826239ff27cdb52fb3e69ff4a06ffd2cbccfdc695ff6096';
    const expectedHash = '582418375f09bff6b3bbb2421206ad6aec3c79ff2602f95a68d3e4d23bebe36f';

    const hash = createHash('sha256').update(data).digest();
    assert.eq(hash, expectedHash, 'SHA-256 hash via tjs:hashing matches');
}

async function sha256Streaming() {
    const data = hexToBytes('047e708746f3d9fb3265a73f0c69ad18cdd48860d7956731eb72873f3d09c17b667c13737017574bf3f826239ff27cdb52fb3e69ff4a06ffd2cbccfdc695ff6096');
    const expectedHash = '582418375f09bff6b3bbb2421206ad6aec3c79ff2602f95a68d3e4d23bebe36f';

    const chunk1 = data.slice(0, 30);
    const chunk2 = data.slice(30);

    const hash1 = await crypto.subtle.digest('SHA-256', chunk1);
    const hash2 = await crypto.subtle.digest('SHA-256', chunk2);

    const combined = new Uint8Array([...new Uint8Array(hash1), ...new Uint8Array(hash2)]);
    const hash = await crypto.subtle.digest('SHA-256', combined);
    const hashHex = bytesToHex(new Uint8Array(hash));

    const direct = await crypto.subtle.digest('SHA-256', data);
    assert.eq(hashHex, bytesToHex(new Uint8Array(direct)), 'SHA-256 chunked hash matches full');
}

async function hashAlgorithms() {
    const testData = encoder.encode('Hello World');
    const testData2 = encoder.encode('Test Data!');

    const algorithms = ['SHA-256', 'SHA-384', 'SHA-512'];

    for (const alg of algorithms) {
        const hash1 = await crypto.subtle.digest(alg, testData);
        assert.ok(hash1 instanceof ArrayBuffer, `${alg} produces ArrayBuffer`);
        assert.ok(hash1.byteLength > 0, `${alg} produces non-empty hash`);

        const hash2 = await crypto.subtle.digest(alg, testData2);
        const hex1 = bytesToHex(new Uint8Array(hash1));
        const hex2 = bytesToHex(new Uint8Array(hash2));
        assert.notEqual(hex1, hex2, `${alg} different inputs produce different hashes`);
    }
}

async function hashAlgorithmsTjs() {
    const testData = 'Hello World';
    const testData2 = 'Test Data!';

    const algorithms = ['sha256', 'sha384', 'sha512'];

    for (const alg of algorithms) {
        const hash1 = createHash(alg).update(testData).digest();
        assert.ok(typeof hash1 === 'string', `${alg} produces string`);
        assert.ok(hash1.length > 0, `${alg} produces non-empty hash`);

        const hash2 = createHash(alg).update(testData2).digest();
        assert.notEqual(hash1, hash2, `${alg} different inputs produce different hashes`);
    }
}

async function ecdsaSignVerify() {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    );

    const data = encoder.encode('test data for ECDSA signing');
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        data
    );

    const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.publicKey,
        signature,
        data
    );

    assert.eq(valid, true, 'ECDSA sign/verify round-trip');
}

async function ecdhSharedSecret() {
    const keyPairA = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
    );

    const keyPairB = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
    );

    const sharedA = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: keyPairB.publicKey },
        keyPairA.privateKey,
        256
    );

    const sharedB = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: keyPairA.publicKey },
        keyPairB.privateKey,
        256
    );

    assert.eq(sharedA.byteLength, 32, 'ECDH shared secret is 32 bytes');

    const a = new Uint8Array(sharedA);
    const b = new Uint8Array(sharedB);
    let equal = a.byteLength === b.byteLength;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) equal = false;
    }
    assert.eq(equal, true, 'ECDH both sides derive same secret');
}

async function hkdfDerivation() {
    const keyData = hexToBytes('235bf7e62823d358dca4ba50b1535f4b');
    const salt = hexToBytes('87e1b004e235a130');
    const info = encoder.encode('GroupKey v1.0');

    const key = await crypto.subtle.importKey(
        'raw',
        keyData,
        'HKDF',
        false,
        ['deriveBits']
    );

    const derived = await crypto.subtle.deriveBits(
        { name: 'HKDF', salt, info, hash: 'SHA-256' },
        key,
        128
    );

    assert.eq(bytesToHex(new Uint8Array(derived)), 'a6f5306baf6d050af23ba4bd6b9dd960', 'HKDF derivation matches');
}

async function randomValues() {
    const array = new Uint8Array(32);
    const result = crypto.getRandomValues(array);
    assert.eq(result, array, 'getRandomValues returns same array');
    assert.eq(array.length, 32, 'getRandomValues fills 32 bytes');

    let allZero = true;
    for (let i = 0; i < array.length; i++) {
        if (array[i] !== 0) allZero = false;
    }
    assert.eq(allZero, false, 'getRandomValues produces non-zero values');
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

await encryptDecrypt();
await sha256Hash();
await sha256HashTjs();
await sha256Streaming();
await hashAlgorithms();
await hashAlgorithmsTjs();
await ecdsaSignVerify();
await ecdhSharedSecret();
await hkdfDerivation();
await randomValues();
