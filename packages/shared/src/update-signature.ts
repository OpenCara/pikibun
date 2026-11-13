export const UPDATE_SIGNING_KEY = "MCowBQYDK2VwAyEAkkmONiPQ1e6ifWP7lzO66UkXZg/UzytvMQik0Czbv6Q=";

export const UPDATE_SIGNATURE_SUFFIX = ".sig";

const SHA256 = /^[0-9a-f]{64}$/;
const ASSET = /^[A-Za-z0-9._-]{1,200}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function updateSignatureMessage(name: string, sha256: string): string {
  if (!ASSET.test(name) || !SHA256.test(sha256)) throw new Error("Invalid update asset");
  return `pikibun app update v1\n${name}\n${sha256}\n`;
}

function base64Bytes(text: string): Uint8Array | null {
  const clean = text.trim();
  if (!clean || clean.length % 4 !== 0 || !BASE64.test(clean)) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(clean.length / 4 * 3 - padding);
  let at = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const value = [0, 1, 2, 3].map(offset => { const found = alphabet.indexOf(clean[index + offset]!); return found < 0 ? 0 : found; })
      .reduce((sum, digit) => (sum << 6) | digit, 0);
    for (const shift of [16, 8, 0]) if (at < bytes.length) bytes[at++] = (value >> shift) & 0xff;
  }
  return bytes;
}

export async function verifyUpdateSignature(name: string, sha256: string, signature: string, publicKey: string = UPDATE_SIGNING_KEY): Promise<boolean> {
  const signed = base64Bytes(signature);
  const key = base64Bytes(publicKey);
  if (!signed || signed.length !== 64 || !key) return false;
  let message: Uint8Array;
  try { message = new TextEncoder().encode(updateSignatureMessage(name, sha256)); } catch { return false; }
  try {
    const imported = await crypto.subtle.importKey("spki", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, imported, signed, message);
  } catch {
    return false;
  }
}
