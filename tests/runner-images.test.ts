import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { AuthorizationRequest, RunnerBinding, RunnerTicket, SubmitInput } from "../packages/shared/src/types.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import { inTurn } from "../apps/runner/src/images.js";

const SECRET = "runner-images-test-secret-not-a-production-secret";
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const linux = { skip: process.platform !== "linux" };

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Images", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Agent", description: "Test", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "faux-1" },
  };
}
async function ticket(id: string, action: "create" | "submit"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function header(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 2;
  return chunk("IHDR", data);
}
function png(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([x % 256, y % 256, (x + y) % 256], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([PNG_SIGNATURE, header(width, height), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
function gif(frames: number): Buffer {
  const frame = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00]);
  return Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0]), ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

async function service(t: TestContext, unsandboxed: boolean): Promise<RunnerSession> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runner-images-")));
  const authorize = async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 });
  const runner = new RunnerService({ dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed, authorize });
  await runner.initialize();
  t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
  return runner.provision(binding("images"), await ticket("images", "create"));
}

async function read(session: RunnerSession, path: string) {
  await session.submit(await ticket("images", "submit"), { content: `TEST_READ ${path}`, requestId: randomUUID() }, "write");
  for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  const view = await session.view();
  assert.equal(view.busy, false, "runner did not settle");
  const reply = view.entries.findLast(entry => entry.role === "assistant");
  const result = view.entries.findLast(entry => entry.role === "toolResult");
  assert.ok(reply && result, "the model answered the tool result");
  assert.ok(reply.text.startsWith("Deterministic test provider result:\n"), reply.text);
  return { model: reply.text.split("\n").slice(1), transcript: result.text, view: JSON.stringify(view) };
}

async function readsImagesAsTheModelSeesThem(t: TestContext, unsandboxed: boolean) {
  const session = await service(t, unsandboxed);
  await session.sandbox.initialize();
  const worktree = join(session.directory, "sandbox", "worktree");
  const small = png(3, 2);
  const text = "plain text, named like an image\n";
  await writeFile(join(worktree, "pixels.dat"), small);
  await writeFile(join(worktree, "wide.png"), png(2400, 30));
  await writeFile(join(worktree, "notes.png"), text);
  await writeFile(join(worktree, "broken.png"), Buffer.concat([PNG_SIGNATURE, header(3, 2)]));
  await writeFile(join(worktree, "moving.gif"), gif(2));

  const pixels = await read(session, "pixels.dat");
  assert.equal(pixels.model.length, 2);
  assert.equal(pixels.model[0], "Read image file [image/png]", "as Pi's read says it");
  assert.equal(pixels.model[1], `image image/png sha256:${createHash("sha256").update(small).digest("hex")}`);
  assert.equal(pixels.transcript, `${pixels.model[0]}\n[image image/png]`);
  assert.equal(pixels.view.includes(small.toString("base64")), false, "image data must not reach the web view");

  const wide = await read(session, "wide.png");
  assert.equal(wide.model.length, 2);
  assert.equal(wide.model[0], "Read image file [image/png]");
  assert.match(wide.model[1]!, /^image image\/png sha256:[0-9a-f]{64}$/);
  assert.notEqual(wide.model[1], `image image/png sha256:${createHash("sha256").update(png(2400, 30)).digest("hex")}`, "scaled to fit");

  const notes = await read(session, "notes.png");
  assert.deepEqual(notes.model, ["plain text, named like an image", ""], "a text file named like an image is read as text");
  assert.equal(notes.transcript.includes("[image"), false);

  const broken = await read(session, "broken.png");
  assert.match(broken.transcript, /The image cannot be decoded or fitted to the model's image limits/);
  assert.equal(broken.model.some(line => line.startsWith("image ")), false);
  assert.equal(broken.transcript.includes("[image"), false);

  const moving = await read(session, "moving.gif");
  assert.equal(moving.model[0], "Read image file [image/png]", "an animated GIF goes to the model as its first frame, a PNG");
}

test("host read_file gives the model images by signature, prepared to fit, and keeps other files text", hostMode, t => readsImagesAsTheModelSeesThem(t, true));

const base64 = (bytes: Buffer) => bytes.toString("base64");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function send(session: RunnerSession, input: Omit<SubmitInput, "requestId"> & { requestId?: string }) {
  return session.submit(await ticket("images", "submit"), { requestId: randomUUID(), ...input }, "write");
}
async function settle(session: RunnerSession) {
  for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  const view = await session.view();
  assert.equal(view.busy, false, "runner did not settle");
  return view;
}
const waiting = (session: RunnerSession) => readdir(join(session.directory, "inputs")).catch(() => [] as string[]);
const refused = (status: number, message: RegExp) => (error: unknown) => error instanceof RunnerError && error.status === status && message.test(error.message);

test("pasted images reach the model after the message's text, prepared to fit, and the transcript only notes them", hostMode, async t => {
  const session = await service(t, true);
  const small = png(3, 2);
  const wide = png(2400, 30);
  await send(session, { content: "What do these show?", images: [{ mimeType: "image/png", data: base64(small) }, { mimeType: "image/png", data: base64(wide) }] });
  const view = await settle(session);
  const seen = view.entries.findLast(entry => entry.role === "assistant")!.text.split("\n");
  assert.deepEqual(seen.slice(0, 3), ["Deterministic test provider saw:", "What do these show?", `image image/png sha256:${digest(small)}`]);
  assert.match(seen[3]!, /^image image\/png sha256:[0-9a-f]{64}$/);
  assert.notEqual(seen[3], `image image/png sha256:${digest(wide)}`);
  assert.equal(seen.length, 4);
  assert.equal(view.entries.findLast(entry => entry.role === "user")!.text, "What do these show?\n[image image/png]\n[image image/png]");
  assert.equal(JSON.stringify(view).includes(base64(small)), false, "image data must not reach the web view");
  assert.deepEqual(await waiting(session), []);

  await send(session, { content: "", images: [{ mimeType: "image/png", data: base64(small) }] });
  const alone = await settle(session);
  assert.deepEqual(alone.entries.findLast(entry => entry.role === "assistant")!.text.split("\n"), ["Deterministic test provider saw:", `image image/png sha256:${digest(small)}`]);
  assert.equal(alone.entries.findLast(entry => entry.role === "user")!.text, "[image image/png]");
});

test("collaborators' clients read the transcript's images as thumbnails or as the model got them", hostMode, async t => {
  const session = await service(t, true);
  const small = png(3, 2);
  const wide = png(2400, 300);
  await send(session, { content: "Look", images: [{ mimeType: "image/png", data: base64(small) }, { mimeType: "image/png", data: base64(wide) }] });
  const view = await settle(session);
  const message = view.entries.findLast(entry => entry.role === "user")!;
  assert.equal(message.text, "Look\n[image image/png]\n[image image/png]");
  assert.deepEqual(message.images, [{ mimeType: "image/png" }, { mimeType: "image/png" }]);
  assert.equal(view.entries.findLast(entry => entry.role === "assistant")!.images, undefined);
  const ask = async (input: unknown) => (await session.entryImage(await ticket("images", "submit"), input)).image;

  assert.deepEqual(await ask({ entryId: message.id, index: 0, size: "thumbnail" }), { mimeType: "image/png", data: base64(small) });
  assert.deepEqual(await ask({ entryId: message.id, index: 0, size: "full" }), { mimeType: "image/png", data: base64(small) });
  const whole = await ask({ entryId: message.id, index: 1, size: "full" });
  assert.equal(Buffer.from(whole.data, "base64").readUInt32BE(16), 1568);
  const thumbnail = await ask({ entryId: message.id, index: 1, size: "thumbnail" });
  const bytes = Buffer.from(thumbnail.data, "base64");
  assert.ok(thumbnail.data.length <= 64 * 1024);
  if (thumbnail.mimeType === "image/png") assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [480, 60]);
  else assert.equal(thumbnail.mimeType, "image/jpeg");
  assert.deepEqual(await ask({ entryId: message.id, index: 1, size: "thumbnail" }), thumbnail);

  await assert.rejects(ask({ entryId: message.id, index: 2, size: "thumbnail" }), refused(404, /not in the transcript/));
  await assert.rejects(ask({ entryId: "0:99999", index: 0, size: "thumbnail" }), refused(404, /not in the transcript/));
  await assert.rejects(ask({ entryId: `9${message.id}`, index: 0, size: "thumbnail" }), refused(404, /not in the transcript/));
  for (const input of [{ entryId: message.id, index: 0 }, { entryId: message.id, index: -1, size: "full" }, { entryId: "stopped:1", index: 0, size: "full" },
    { entryId: message.id, index: 0, size: "full", path: "x" }, null]) {
    await assert.rejects(ask(input), refused(400, /Invalid image request/));
  }
});

test("one image is prepared at a time; the model's go ahead of waiting thumbnails, and each waits in a line of its own", async () => {
  const ran: string[] = [];
  const held = Promise.withResolvers<void>();
  const work = (name: string, wait?: Promise<void>) => async () => { ran.push(`start ${name}`); await wait; ran.push(`end ${name}`); return name; };
  const first = inTurn("thumbnail", work("thumbnail 0", held.promise));
  const thumbnails = Array.from({ length: 32 }, (_, index) => inTurn("thumbnail", work(`thumbnail ${index + 1}`)));
  assert.equal(typeof await inTurn("thumbnail", work("refused")), "symbol");
  const model = inTurn("model", work("model"));
  await delay(10);
  assert.deepEqual(ran, ["start thumbnail 0"], "nothing starts while an image is prepared");
  held.resolve();
  assert.deepEqual(await Promise.all([first, model, ...thumbnails]), ["thumbnail 0", "model", ...Array.from({ length: 32 }, (_, index) => `thumbnail ${index + 1}`)]);
  assert.deepEqual(ran.slice(0, 4), ["start thumbnail 0", "end thumbnail 0", "start model", "end model"]);
  assert.ok(ran.every((line, index) => line.startsWith(index % 2 ? "end" : "start")));
});

test("pasted images the host can't read or take are refused before anything is queued, and a request ID binds its images", hostMode, async t => {
  const session = await service(t, true);
  const image = { mimeType: "image/png" as const, data: base64(png(3, 2)) };
  await assert.rejects(send(session, { content: "Broken", images: [{ mimeType: "image/png", data: base64(Buffer.concat([PNG_SIGNATURE, header(3, 2)])) }] }), refused(422, /cannot be decoded/));
  await assert.rejects(send(session, { content: "Mislabelled", images: [{ mimeType: "image/jpeg", data: image.data }] }), refused(422, /cannot be decoded/));
  await assert.rejects(send(session, { content: "Mislabelled", images: [{ mimeType: "image/gif", data: image.data }] }), refused(422, /cannot be decoded/));
  for (const images of [Array(5).fill(image), [{ ...image, mimeType: "image/bmp" }], [{ ...image, data: "not base64!" }], [{ ...image, name: "screenshot.png" }], {}]) {
    await assert.rejects(send(session, { content: "Invalid", images: images as never }), refused(400, /images/));
  }
  await assert.rejects(send(session, { content: " ", images: [] }), refused(400, /Invalid submission/));
  assert.deepEqual((await session.view()).queue, []);
  assert.deepEqual(await waiting(session), []);

  const requestId = randomUUID();
  const first = await send(session, { content: "Same", images: [image], requestId });
  assert.equal((await send(session, { content: "Same", images: [image], requestId })).submissionId, first.submissionId);
  await assert.rejects(send(session, { content: "Same", images: [{ mimeType: "image/png", data: base64(png(2, 3)) }], requestId }), refused(409, /different content/));
  await assert.rejects(send(session, { content: "Same", requestId }), refused(409, /different content/));
  await settle(session);
});

test("a queued message's images wait on the host, outside the run ledger, until it runs, and go when it is stopped", hostMode, async t => {
  const session = await service(t, true);
  const small = png(3, 2);
  await send(session, { content: "Warm up", images: [{ mimeType: "image/png", data: base64(small) }] });
  await settle(session);

  await send(session, { content: "TEST_HOLD 3000" });
  const later = png(4, 2);
  const queued = await send(session, { content: "Later", images: [{ mimeType: "image/png", data: base64(later) }] });
  assert.deepEqual(await waiting(session), [`${queued.submissionId}.json`]);
  const database = await Promise.all(["session.sqlite", "session.sqlite-wal"].map(name => readFile(join(session.directory, name)).catch(() => Buffer.alloc(0))));
  assert.equal(database.some(bytes => bytes.includes(base64(later))), false, "queued images stay out of the session database");
  const view = await settle(session);
  assert.equal(view.entries.findLast(entry => entry.role === "assistant")!.text, `Deterministic test provider saw:\nLater\nimage image/png sha256:${digest(later)}`);
  assert.deepEqual(await waiting(session), []);

  await send(session, { content: "TEST_HOLD 3000" });
  await send(session, { content: "Never", images: [{ mimeType: "image/png", data: base64(small) }] });
  assert.equal((await waiting(session)).length, 1);
  assert.equal((await session.stop(await ticket("images", "submit"))).stopped, 2);
  assert.deepEqual(await waiting(session), []);
  await settle(session);

  await send(session, { content: "TEST_HOLD 3000" });
  const lost = await send(session, { content: "Lost", images: [{ mimeType: "image/png", data: base64(small) }] });
  await writeFile(join(session.directory, "inputs", `${lost.submissionId}.json`), "{");
  const ended = await settle(session);
  assert.equal(ended.queue!.find(item => item.submissionId === lost.submissionId)!.status, "images lost");
  assert.equal(ended.entries.some(entry => entry.role === "user" && entry.text === "Lost"), false);
  assert.deepEqual(await waiting(session), []);
});

test("sandboxed read_file gives the model images by signature, prepared to fit, and keeps other files text", linux, t => readsImagesAsTheModelSeesThem(t, false));
