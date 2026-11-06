const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url of bytes. */
function base64url(bytes: Uint8Array): string {
  let text = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      text += alphabet[(value >> bits) & 63];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) text += alphabet[(value << (6 - bits)) & 63];
  return text;
}

function randomToken(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * A proof key for the native sign-in (RFC 7636, S256): a 43-character verifier the app keeps, its challenge for the
 * start URL, and a state value the callback must echo.
 */
export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = randomToken(32);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest), state: randomToken(24) };
}
