import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const KEY_SOURCE = new URL("../packages/shared/src/update-signature.ts", import.meta.url);

export function updateMessage(name, sha256) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(name) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid update asset: ${name}`);
  return `pikibun app update v1\n${name}\n${sha256}\n`;
}

export function releasePublicKey(source = readFileSync(KEY_SOURCE, "utf8")) {
  const found = /export const UPDATE_SIGNING_KEY = "([A-Za-z0-9+/=]+)";/.exec(source);
  if (!found) throw new Error("UPDATE_SIGNING_KEY not found in packages/shared/src/update-signature.ts");
  return createPublicKey({ key: Buffer.from(found[1], "base64"), format: "der", type: "spki" });
}

export function signUpdate(file, privateKey, publicKey) {
  const name = basename(file);
  const message = Buffer.from(updateMessage(name, createHash("sha256").update(readFileSync(file)).digest("hex")));
  const signature = sign(null, message, privateKey);
  if (!verify(null, message, publicKey, signature)) {
    throw new Error("The signing key doesn't match UPDATE_SIGNING_KEY in packages/shared/src/update-signature.ts: the app would refuse this update.");
  }
  writeFileSync(`${file}.sig`, `${signature.toString("base64")}\n`);
  return `${name}.sig`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pem = process.env.APP_UPDATE_SIGNING_KEY;
  if (!pem) {
    console.error("APP_UPDATE_SIGNING_KEY is not set: desktop updates can't be signed, and the app refuses unsigned ones.");
    process.exit(1);
  }
  const privateKey = createPrivateKey(pem);
  const publicKey = releasePublicKey();
  for (const file of process.argv.slice(2)) console.log(`Signed ${signUpdate(file, privateKey, publicKey)}`);
}
