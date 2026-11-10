import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(privateKeyObject(ecdh.getPrivateKey(), ecdh.getPublicKey()).export({ format: 'der', type: 'pkcs8' })) };
}

function privateKeyObject(d: Uint8Array, publicKey: Uint8Array): KeyObject {
  return createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(publicKey.subarray(1, 33)), y: b64url(publicKey.subarray(33, 65)) } });
}

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

export function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

const RECORD_SIZE = 4096;

export function encryptPushPayload(payload: Uint8Array, p256dh: string, auth: string, testing?: { salt: Uint8Array; serverPrivateKey: Uint8Array }): Uint8Array<ArrayBuffer> {
  const userAgentPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (userAgentPublic.length !== 65 || authSecret.length !== 16) throw new Error('Invalid subscription keys.');
  if (payload.length > RECORD_SIZE - 17 - 86) throw new Error('Push payload too large.');
  const server = createECDH('prime256v1');
  if (testing) server.setPrivateKey(testing.serverPrivateKey); else server.generateKeys();
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(userAgentPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userAgentPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = testing ? Buffer.from(testing.salt) : randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return new Uint8Array(Buffer.concat([header, serverPublic, record]));
}

const pushServiceHosts = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/];

export function allowedPushEndpoint(endpoint: string): boolean {
  const url = URL.parse(endpoint);
  return !!url && url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443')
    && pushServiceHosts.some(host => host.test(url.hostname)) && endpoint.length <= 1024;
}
