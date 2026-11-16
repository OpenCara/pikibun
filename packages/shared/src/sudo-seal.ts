export interface SealedSudoPassword {
  key: string;
  iv: string;
  data: string;
}

export const SUDO_SEAL_LIMITS = Object.freeze({ key: 100, iv: 20, data: 1500 });
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const value = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    const count = Math.min(3, bytes.length - index) + 1;
    for (let digit = 0; digit < count; digit++) text += ALPHABET[(value >> (18 - digit * 6)) & 63];
  }
  return text;
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new Error("Invalid base64url");
  const bytes = new Uint8Array(new ArrayBuffer(Math.floor(text.length * 3 / 4)));
  let at = 0;
  for (let index = 0; index < text.length; index += 4) {
    const chunk = text.slice(index, index + 4);
    const value = [...chunk.padEnd(4, "A")].reduce((sum, character) => (sum << 6) | ALPHABET.indexOf(character), 0);
    for (let byte = 0; byte < chunk.length - 1; byte++) bytes[at++] = (value >> (16 - byte * 8)) & 0xff;
  }
  return bytes;
}

function copy(bytes: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = new Uint8Array(new ArrayBuffer(source.length));
  out.set(source);
  return out;
}

const encoded = (text: string) => copy(new TextEncoder().encode(text));

async function sealKey(privateKey: CryptoKey, publicKey: Uint8Array<ArrayBuffer>, id: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey("raw", publicKey, P256, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", copy(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(new ArrayBuffer(0)), info: encoded(`pikibun sudo v1\n${id}`) },
    material, { name: "AES-GCM", length: 256 }, false, [usage]);
}

export async function sudoSealKeys(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(P256, false, ["deriveBits"]) as CryptoKeyPair;
  return { publicKey: base64url(copy(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer)), privateKey: pair.privateKey };
}

export async function sealSudoPassword(hostKey: string, id: string, password: string): Promise<SealedSudoPassword> {
  const mine = await crypto.subtle.generateKey(P256, true, ["deriveBits"]) as CryptoKeyPair;
  const key = await sealKey(mine.privateKey, fromBase64url(hostKey), id, "encrypt");
  const iv = copy(crypto.getRandomValues(new Uint8Array(12)));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoded(id) }, key, encoded(password));
  return { key: base64url(copy(await crypto.subtle.exportKey("raw", mine.publicKey) as ArrayBuffer)), iv: base64url(iv), data: base64url(copy(data as ArrayBuffer)) };
}

export async function openSudoPassword(privateKey: CryptoKey, id: string, sealed: SealedSudoPassword): Promise<string> {
  const key = await sealKey(privateKey, fromBase64url(sealed.key), id, "decrypt");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(sealed.iv), additionalData: encoded(id) }, key, fromBase64url(sealed.data));
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

export function parseSealedSudoPassword(value: unknown): SealedSudoPassword {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sealed password.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== "data,iv,key") throw new Error("Invalid sealed password.");
  for (const name of ["key", "iv", "data"] as const) {
    const part = record[name];
    if (typeof part !== "string" || !BASE64URL.test(part) || part.length > SUDO_SEAL_LIMITS[name]) throw new Error("Invalid sealed password.");
  }
  return { key: record.key as string, iv: record.iv as string, data: record.data as string };
}
