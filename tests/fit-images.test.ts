import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, ToolResultEntry, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { SessionBuiltins } from "../apps/runner/src/extensions/builtin.js";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { conversationImageLimits, fitImagesExtension, inTurn, MAX_MODEL_IMAGE_LIMITS, modelImageLimits, prepareImage } from "../apps/runner/src/images.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { fitInputImages } from "../apps/runner/src/session/inputs.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { defaultHostConfig } from "../packages/shared/src/host-config.js";
import { parseWorkspaceExtensions } from "../packages/shared/src/host-extensions.js";
import type { RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";

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
const block = (bytes: Buffer): ImageContent => ({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
const size = (image: ImageContent) => {
  assert.equal(image.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
const images = (content: readonly (TextContent | ImageContent)[]) => content.filter((part): part is ImageContent => part.type === "image");
const text = (content: readonly (TextContent | ImageContent)[]) => content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");

function occupy(): () => Promise<void> {
  const held = Promise.withResolvers<void>();
  const turns = Array.from({ length: 9 }, () => inTurn("model", () => held.promise));
  return async () => { held.resolve(); await Promise.all(turns); };
}

const MODELS = [
  { id: "narrow", inputLimits: { images: { resize: { maxWidth: 100 } } } },
  { id: "wide", inputLimits: { images: { resize: { maxWidth: 300 } } } },
  { id: "huge", inputLimits: { images: { resize: { maxWidth: 100_000, maxHeight: 100_000, maxBytes: 1024 * 1024 * 1024 } } } },
  { id: "plain" },
  { id: "text-only", input: ["text" as const] },
];

async function chat(t: TestContext, tools: ToolRegistration[]) {
  const seen: (TextContent | ImageContent)[][] = [];
  const faux = fauxProvider({ models: MODELS });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") {
      seen.push(last.content);
      return fauxAssistantMessage("done");
    }
    const content = typeof last?.content === "string" ? last.content : "";
    return fauxAssistantMessage(content.startsWith("code:") ? fauxToolCall("codemode", { code: content.slice(5) }) : fauxToolCall(content, {}), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const builtins = new SessionBuiltins();
  t.after(() => builtins.close());
  const codemode = builtins.extensions.get("pi:codemode")!;
  const workspace = defineExtension({ name: "workspace-tools", tools });
  const registry = createRegistry();
  registry.install(workspace);
  registry.install(codemode);
  registry.install(fitImagesExtension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "narrow" },
    extensions: [workspace, codemode, fitImagesExtension], tools: [...tools, ...codemode.tools!] } });
  return {
    models,
    async call(content: string, modelId = "narrow") {
      await root.configure({ model: { provider: "faux", modelId } }, context);
      const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
      assert.equal(settled.status, "done");
      const stored = (await root.context(context)).entries.filter(entry => entry.kind === ToolResultEntry.kind).at(-1) as unknown as { model: { content: (TextContent | ImageContent)[] }[] };
      assert.deepEqual(stored.model[0]!.content, seen.at(-1), "the model gets what the transcript keeps");
      return seen.at(-1)!;
    },
  };
}

const tool = (name: string, execute: ToolRegistration["execute"]) => defineTool({ name, description: name, parameters: obj({}, { open: true }), execute });

test("an oversized image from any tool reaches the model fitted to the conversation model's own limits, within a sane upper bound", async t => {
  const wide = png(400, 100);
  const { call } = await chat(t, [
    tool("picture", async () => ({ output: [{ type: "text", text: "here" }, block(wide)] })),
    tool("small", async () => ({ output: [block(png(8, 6))] })),
    tool("long", async () => ({ output: [block(png(2400, 30))] })),
  ]);

  const narrow = await call("picture");
  assert.deepEqual(size(images(narrow)[0]!), [100, 25]);
  assert.equal(narrow[0]!.type === "text" && narrow[0].text, "here");
  assert.match(text(narrow), /Resized from 400x100 to 100x25\. Multiply coordinates by 4\.00/, "the model is told how to map coordinates back");

  assert.deepEqual(size(images(await call("picture", "wide"))[0]!), [300, 75], "another model, its own limits");
  const plain = await call("picture", "plain");
  assert.deepEqual(images(plain), [block(wide)], "within the limits it is kept as the tool made it");
  assert.doesNotMatch(text(plain), /Resized/);

  assert.deepEqual(size(images(await call("long", "huge"))[0]!), [MAX_MODEL_IMAGE_LIMITS.maxWidth, 25], "a model's huge limits are bounded");
  assert.deepEqual(modelImageLimits(undefined), MAX_MODEL_IMAGE_LIMITS);

  const small = block(png(8, 6));
  assert.deepEqual(images(await call("small")), [small]);

  const textOnly = await call("picture", "text-only");
  assert.deepEqual(size(images(textOnly)[0]!), [400, 100], "a model without image input keeps the image in the transcript, for Pi to replace per request as before");
});

test("code mode's image() reaches the model fitted", async t => {
  const { call } = await chat(t, []);
  const shown = await call(`code:image(${JSON.stringify(block(png(400, 100)))});\nreturn "shown";`);
  assert.deepEqual(images(shown).map(size), [[100, 25]]);
  assert.match(text(shown), /shown/);
});

test("an image read already fitted to the model is kept as it is, without being prepared again", async t => {
  let release: (() => Promise<void>) | undefined;
  let prepared: ImageContent | undefined;
  const { call } = await chat(t, [tool("read_like", async (_args, api) => {
    const result = await prepareImage(png(400, 100), await conversationImageLimits(api));
    assert.ok("image" in result);
    prepared = { type: "image", data: result.image.data, mimeType: result.image.mimeType };
    release = occupy();
    return { output: [{ type: "text", text: "Read image file [image/png]" }, prepared] };
  })]);
  t.after(() => release?.());
  const seen = await call("read_like");
  await release!();
  assert.deepEqual(size(prepared!), [100, 25]);
  assert.deepEqual(seen, [{ type: "text", text: "Read image file [image/png]" }, prepared], "unchanged and without a note, though the line of images waiting was full");
});

test("while too many images are waiting, a tool's oversized image is left out with a note saying so", async t => {
  const { call } = await chat(t, [tool("picture", async () => ({ output: [{ type: "text", text: "here" }, block(png(400, 100))] }))]);
  const release = occupy();
  let seen: (TextContent | ImageContent)[];
  try { seen = await call("picture"); }
  finally { await release(); }
  assert.deepEqual(images(seen), []);
  assert.match(text(seen), /An image \(image\/png\) cannot be prepared for the model and was left out: too many images are being prepared at once; try again shortly\./);
  assert.deepEqual(images(await call("picture")).map(size), [[100, 25]], "once the line clears, the same call's image is fitted");
});

test("an image beyond the decode and size caps is left out without being decoded", async t => {
  const bomb = Buffer.concat([PNG_SIGNATURE, header(40_000, 40_000), chunk("IEND", Buffer.alloc(0))]);
  const { call } = await chat(t, [tool("bomb", async () => ({ output: [block(bomb)] }))]);
  const release = occupy();
  let seen: (TextContent | ImageContent)[];
  try { seen = await call("bomb"); }
  finally { await release(); }
  assert.deepEqual(images(seen), []);
  assert.match(text(seen), /An image \(image\/png\) cannot be prepared for the model and was left out\./, "refused by its header, before it waits for a turn");
  assert.deepEqual(await prepareImage(Buffer.alloc(16 * 1024 * 1024 + 1), MAX_MODEL_IMAGE_LIMITS), { error: "The image cannot be decoded or fitted to the model's image limits" });
});

test("a session fits the images of its workspace extensions' tools and of code mode to the model's limits", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-fit-images-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const picture = png(400, 100).toString("base64");
  await writeFile(join(root, "picture.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "picture", label: "Picture", description: "A picture.", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "image", data: ${JSON.stringify(picture)}, mimeType: "image/png" }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "picture.ts")));
  const [dev] = await loadInstalled(store, []);
  const installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:picture@1.0.0", dev: false } }];
  const answer = { extensions: parseWorkspaceExtensions([{ source: "npm:picture@1.0.0" }]), automaticTools: true };
  const seen: (TextContent | ImageContent)[][] = [];
  const faux = fauxProvider({ models: MODELS });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") { seen.push(last.content); return fauxAssistantMessage("done"); }
    if (last?.role === "user" && typeof last.content !== "string") { seen.push(last.content); return fauxAssistantMessage("seen"); }
    const content = typeof last?.content === "string" ? last.content : "";
    return fauxAssistantMessage(content === "picture" ? fauxToolCall("picture", {})
      : fauxToolCall("codemode", { code: `image(${JSON.stringify({ type: "image", data: picture, mimeType: "image/png" })});\nreturn "shown";` }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const target: RunnerBinding = {
    session: { id: "fit-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Images", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:bob" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "narrow", connectorId: "host-connector", connectorOwnerId: "test:bob" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "fit-images-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    hostConfig: async () => ({ ...defaultHostConfig, builtinExtensions: ["pi:codemode"] }),
    extensions: { installed: () => installed, workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const claims = async (action: RunnerAction) => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId: target.session.id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60,
      jti: randomUUID(), bodyHash: await sha256(""), connectorId: "host-connector" };
  };
  const session = await service.provision(target, await claims("create"));
  const send = async (content: string, options?: { model: { provider: string; modelId: string } }, images?: { mimeType: "image/png"; data: string }[]) => {
    await session.submit(await claims("submit"), { content, requestId: randomUUID(), admissionId: await sha256(randomUUID()), ...(options ? { options } : {}),
      ...(images ? { images } : {}) }, "write");
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
    assert.equal((await session.view()).busy, false);
    return seen.at(-1)!;
  };

  assert.deepEqual(images(await send("picture")).map(size), [[100, 25]], "a workspace extension's tool");
  assert.deepEqual(images(await send("script")).map(size), [[100, 25]], "code mode's image()");
  assert.deepEqual(images(await send("picture", { model: { provider: "faux", modelId: "wide" } })).map(size), [[300, 75]], "the model the message chose");
  const pasted = [{ mimeType: "image/png" as const, data: picture }];
  assert.deepEqual(images(await send("look", { model: { provider: "faux", modelId: "narrow" } }, pasted)).map(size), [[100, 25]], "a pasted image, to the model the message chose");
  assert.deepEqual(images(await send("look again", undefined, pasted)).map(size), [[100, 25]], "and to the conversation's model");
});

test("a queued message's images are fitted again when the model it runs on takes smaller ones", async () => {
  const models = createModels();
  models.setProvider(fauxProvider({ models: MODELS }).provider);
  const narrow = modelImageLimits(models.getModel("faux", "narrow"));
  assert.equal(narrow.maxWidth, 100);
  const small = block(png(8, 6));
  const content = [{ type: "text" as const, text: "look" }, small, block(png(400, 100))];
  const fitted = await fitInputImages(content, narrow);
  assert.ok(typeof fitted !== "string");
  assert.deepEqual(fitted.slice(0, 2), [content[0], small], "what fits stays as it is");
  assert.deepEqual(size(fitted[2] as ImageContent), [100, 25]);
  assert.equal(await fitInputImages([content[0]!, small], narrow).then(result => typeof result !== "string" && result[1] === small), true);
  assert.equal(await fitInputImages("text alone", narrow), "text alone");
});
