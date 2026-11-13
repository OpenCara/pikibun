import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_SIGNING_KEY, updateSignatureMessage, verifyUpdateSignature } from "../packages/shared/src/update-signature.js";
import { releasePublicKey, signUpdate, updateMessage } from "../scripts/sign-update.mjs";

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "update-signature-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("the release script signs what the app checks: the asset's name and SHA-256, with the key the app carries", async t => {
  const dir = await directory(t);
  const file = join(dir, "Pikibun-0.21.0-linux-x86_64.tar.gz");
  await writeFile(file, "the app");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  assert.equal(signUpdate(file, privateKey, publicKey), "Pikibun-0.21.0-linux-x86_64.tar.gz.sig");
  const signature = await readFile(`${file}.sig`, "utf8");
  const sha256 = createHash("sha256").update("the app").digest("hex");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.equal(await verifyUpdateSignature("Pikibun-0.21.0-linux-x86_64.tar.gz", sha256, signature, spki), true);
  assert.equal(await verifyUpdateSignature("Pikibun-0.21.0-linux-x86_64.tar.gz", "0".repeat(64), signature, spki), false);
  assert.equal(await verifyUpdateSignature("Pikibun-0.20.0-linux-x86_64.tar.gz", sha256, signature, spki), false, "a signature never carries over to another version");
  assert.equal(updateMessage("Pikibun-0.21.0-linux-x86_64.tar.gz", sha256), updateSignatureMessage("Pikibun-0.21.0-linux-x86_64.tar.gz", sha256));
});

test("the release refuses to sign with a key the app doesn't carry, rather than publish updates every app refuses", async t => {
  const dir = await directory(t);
  const file = join(dir, "Pikibun-0.21.0-macos-arm64.dmg");
  await writeFile(file, "the app");
  const signer = generateKeyPairSync("ed25519");
  assert.throws(() => signUpdate(file, signer.privateKey, releasePublicKey()), /doesn't match UPDATE_SIGNING_KEY/);
  await assert.rejects(readFile(`${file}.sig`), "nothing is written");
});

test("the key the apps carry is Pikibun's release key, and the release script reads the same one", () => {
  assert.equal(UPDATE_SIGNING_KEY, "MCowBQYDK2VwAyEAkkmONiPQ1e6ifWP7lzO66UkXZg/UzytvMQik0Czbv6Q=");
  assert.equal(releasePublicKey().export({ format: "der", type: "spki" }).toString("base64"), UPDATE_SIGNING_KEY);
  assert.equal(releasePublicKey().asymmetricKeyType, "ed25519");
  assert.throws(() => updateSignatureMessage("../escape", "0".repeat(64)));
});
