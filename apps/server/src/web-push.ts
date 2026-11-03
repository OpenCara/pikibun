import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// Web Push without a library: the message encryption of RFC 8291 (aes128gcm, RFC 8188) and the VAPID authorization of
// RFC 8292, with node:crypto. Pure, so tests decrypt what it makes as a browser would.

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export interface VapidKeys {
  /** The uncompressed P-256 public key (65 bytes), base64url: browsers' applicationServerKey. */
  publicKey: string;
  /** The private key as PKCS#8 DER, base64url. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(privateKeyObject(ecdh.getPrivateKey(), ecdh.getPublicKey()).export({ format: 'der', type: 'pkcs8' })) };
}

/** A P-256 private key object from its raw scalar and uncompressed public point. */
function privateKeyObject(d: Uint8Array, publicKey: Uint8Array): KeyObject {
  return createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(publicKey.subarray(1, 33)), y: b64url(publicKey.subarray(33, 65)) } });
}

/** Whether `value` is an uncompressed P-256 point, base64url, as subscriptions' p256dh keys are. */
export function validP256Point(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{86,88}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 65 || bytes[0] !== 4) return false;
  try {
    createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64url(bytes.subarray(1, 33)), y: b64url(bytes.subarray(33)) } });
    return true;
  } catch {
    return false;
  }
}

/**
 * The value of the Authorization header for a push to `endpoint`: a VAPID JWT (ES256) for the push service's origin,
 * valid for 12 hours, naming `subject` (a mailto: or https: URL) as the contact.
 */
export function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** The record size the body declares; a payload fits in one record. */
const RECORD_SIZE = 4096;

/**
 * `payload` encrypted for a subscription's keys (p256dh: the browser's public key, auth: its 16-byte secret, both
 * base64url) as an aes128gcm body: salt, record size, the server's one-time public key, then the one record.
 * `salt` and `serverKey` are for tests' known-answer vectors; each message otherwise gets fresh ones.
 */
export function encryptPushPayload(payload: Uint8Array, p256dh: string, auth: string, testing?: { salt: Uint8Array; serverPrivateKey: Uint8Array }): Uint8Array<ArrayBuffer> {
  const userAgentPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (userAgentPublic.length !== 65 || authSecret.length !== 16) throw new Error('Invalid subscription keys.');
  if (payload.length > RECORD_SIZE - 17 - 86) throw new Error('Push payload too large.');
  const server = createECDH('prime256v1');
  if (testing) server.setPrivateKey(testing.serverPrivateKey); else server.generateKeys();
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(userAgentPublic);
  // RFC 8291 §3.4: the input keying material, from the ECDH secret and the auth secret, bound to both public keys.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userAgentPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = testing ? Buffer.from(testing.salt) : randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, the last: its padding delimiter is 2, with no padding after it.
  const record = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return new Uint8Array(Buffer.concat([header, serverPublic, record]));
}

/**
 * The push services browsers subscribe with. The server sends only to these, never to an address a client made up:
 * a subscription's endpoint is the client's to give, and the server must not be made to call into other networks.
 */
const pushServiceHosts = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/];

export function allowedPushEndpoint(endpoint: string): boolean {
  const url = URL.parse(endpoint);
  return !!url && url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443')
    && pushServiceHosts.some(host => host.test(url.hostname)) && endpoint.length <= 1024;
}
