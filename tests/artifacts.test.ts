import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService } from "../apps/runner/src/server.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import { ArtifactContent, ArtifactIndex, listArtifacts, publishArtifact, readArtifact, type ArtifactReader } from "../apps/runner/src/session/artifacts.js";
import type { Tx } from "@earendil-works/pi-durable";
import {
  artifactFrame, artifactFramePolicy, artifactLimits, artifactRequest, artifactResult, artifactResultText, artifactTitle, checkArtifact, checkArtifactList,
  validArtifactName, type Artifact, type ArtifactSummary,
} from "../packages/shared/src/artifacts.js";
import { artifactsHref, createArtifactSource, publishedArtifact } from "../packages/client/src/artifacts.js";
import { sessionToolsOff } from "../packages/shared/src/piki-extensions.js";
import { withSessionToolsListed } from "../packages/shared/src/host-extensions.js";
import type { AuthorizationRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";

test("artifact names, requests and answers are checked; a version's result line names it for the transcript card", () => {
  for (const name of ["chart", "a", "sales-chart_2", "0x", "a".repeat(64)]) assert.ok(validArtifactName(name), name);
  for (const name of ["", "Chart", "-chart", "_chart", "a b", "a/b", "a".repeat(65), "chart.html"]) assert.ok(!validArtifactName(name), name);
  assert.deepEqual(artifactRequest({}), {});
  assert.deepEqual(artifactRequest({ name: "chart", version: 2 }), { name: "chart", version: 2 });
  for (const input of [null, [], { name: "chart" }, { version: 1 }, { name: "chart", version: 0 }, { name: "chart", version: 1.5 },
    { name: "Chart", version: 1 }, { name: "chart", version: artifactLimits.versions + 1 }, { name: "chart", version: 1, extra: true }]) {
    assert.equal(artifactRequest(input), undefined, JSON.stringify(input));
  }
  assert.equal(artifactTitle("  A   chart\nof sales ", "chart"), "A chart of sales");
  assert.equal(artifactTitle(undefined, "chart"), "chart");
  assert.equal(Array.from(artifactTitle("é".repeat(500), "chart")).length, artifactLimits.title);

  const info = { version: 1, kind: "html" as const, title: "Chart", size: 12, createdAt: "2026-01-01T00:00:00.000Z" };
  const list: ArtifactSummary[] = [{ name: "chart", versions: [info, { ...info, version: 2, kind: "svg" }] }];
  assert.deepEqual(checkArtifactList(list), list);
  for (const bad of [{}, [{ name: "chart", versions: [] }], [{ name: "chart", versions: [{ ...info, version: 2 }] }], [list[0], list[0]],
    [{ name: "chart", versions: [{ ...info, kind: "pdf" }] }], [{ name: "chart", versions: [{ ...info, title: "a\nb" }] }],
    [{ name: "chart", versions: [{ ...info, size: artifactLimits.bytes + 1 }] }]]) {
    assert.equal(checkArtifactList(bad), undefined, JSON.stringify(bad));
  }
  const artifact: Artifact = { name: "chart", ...info, content: "<p>hi</p>" };
  assert.deepEqual(checkArtifact({ ...artifact, extra: 1 }, { name: "chart", version: 1 }), artifact);
  assert.equal(checkArtifact(artifact, { name: "chart", version: 2 }), undefined, "the version asked for, and no other");
  assert.equal(checkArtifact(artifact, { name: "other", version: 1 }), undefined);
  assert.equal(checkArtifact({ ...artifact, content: "x".repeat(artifactLimits.bytes + 1) }, { name: "chart", version: 1 }), undefined);

  const text = artifactResultText({ name: "chart", version: 3, kind: "markdown", title: "Sales" });
  assert.deepEqual(artifactResult(text), { name: "chart", version: 3, kind: "markdown", title: "Sales" });
  assert.deepEqual(artifactResult(text.split("\n")[0]!), { name: "chart", version: 3, kind: "markdown" }, "a brief share keeps the first line, and the card with it");
  assert.equal(artifactResult("Published artifact chart version 3 (pdf)."), undefined);
  assert.equal(artifactResult("Something else"), undefined);
});

test("an artifact's frame runs it with no network, no forms and no frames: only what it holds inline", () => {
  const html = artifactFrame("html", "<script>fetch('https://example.com')</script>");
  assert.ok(html.startsWith(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${artifactFramePolicy}">`),
    "the policy comes before anything of the artifact's");
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "base-uri 'none'", "img-src data: blob:"]) {
    assert.ok(artifactFramePolicy.includes(directive), directive);
  }
  assert.ok(!/https?:/.test(artifactFramePolicy), "no host is ever allowed");
  const svg = artifactFrame("svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>");
  assert.match(svg, /<img alt="" src="data:image\/svg\+xml;charset=utf-8,%3Csvg/, "an SVG is drawn as an image, where its scripts don't run");
  assert.ok(!svg.includes("<svg"), "its markup never becomes the page's");
});

test("the client finds the card's artifact in a publish_artifact result and keeps versions it read, as they never change", async () => {
  const result = { id: "1:3", kind: "message", role: "toolResult", text: artifactResultText({ name: "chart", version: 2, kind: "svg", title: "Chart" }),
    toolResult: { tool: "publish_artifact", callId: "c1" } };
  assert.deepEqual(publishedArtifact(result), { name: "chart", version: 2, kind: "svg", title: "Chart" });
  assert.equal(publishedArtifact({ ...result, toolResult: { tool: "publish_artifact", error: true } }), undefined);
  assert.equal(publishedArtifact({ ...result, toolResult: { tool: "read" } }), undefined, "only the tool's own results are cards");
  assert.equal(publishedArtifact(undefined), undefined);
  assert.equal(artifactsHref({ sessionId: "s 1" }), "/api/sessions/s%201/artifacts");
  assert.equal(artifactsHref({ sessionId: "s" }, { name: "chart", version: 2 }), "/api/sessions/s/artifacts?name=chart&version=2");
  assert.equal(artifactsHref({ shared: true }, { name: "chart", version: 2 }), "/api/shared/artifacts?name=chart&version=2");
  const loaded: string[] = [];
  const source = createArtifactSource({ sessionId: "s" }, async <T,>(href: string) => {
    loaded.push(href);
    if (href.includes("version=9")) throw new Error("gone");
    return { artifact: { name: "chart" }, artifacts: [] } as T;
  });
  await source.read("chart", 1);
  await source.read("chart", 1);
  await source.list();
  await source.list();
  await assert.rejects(source.read("chart", 9), /gone/);
  await assert.rejects(source.read("chart", 9), /gone/);
  assert.deepEqual(loaded, ["/api/sessions/s/artifacts?name=chart&version=1", "/api/sessions/s/artifacts", "/api/sessions/s/artifacts",
    "/api/sessions/s/artifacts?name=chart&version=9", "/api/sessions/s/artifacts?name=chart&version=9"], "a list is read again each time; a failure isn't kept");
});

test("piki:artifacts switches the tool: off until a workspace adds it, as the other Pikibun tools are", () => {
  assert.ok(sessionToolsOff(withSessionToolsListed([])).has("publish_artifact"), "the Pikibun server lists it off for a workspace that never added it");
  assert.ok(!sessionToolsOff([{ source: "piki:artifacts", enabled: true }]).has("publish_artifact"));
  assert.ok(sessionToolsOff([{ source: "piki:artifacts", enabled: false }]).has("publish_artifact"));
});

function memoryStore() {
  const docs = new Map<string, Record<string, unknown>>();
  const commit = async <T,>(change: (tx: Tx) => Promise<T>): Promise<T> => {
    const draft = new Map([...docs].map(([key, value]) => [key, structuredClone(value)]));
    const tx = { doc: async (token: { definition: { kind: string; initial(): Record<string, unknown> } }, key?: string) => {
      const id = `${token.definition.kind}:${key ?? ""}`;
      if (!draft.has(id)) draft.set(id, token.definition.initial());
      return draft.get(id)!;
    } } as unknown as Tx;
    const value = await change(tx);
    docs.clear();
    for (const [key, doc] of draft) docs.set(key, doc);
    return value;
  };
  const reader: ArtifactReader = {
    index: async () => docs.get(`${ArtifactIndex.definition.kind}:`) as never,
    content: async key => docs.get(`${ArtifactContent.definition.kind}:${key}`) as never,
  };
  return { commit, reader, docs };
}

test("publishing keeps each version once, counts versions up, and refuses past the limits without writing anything", async () => {
  const store = memoryStore();
  const now = new Date("2026-01-01T00:00:00Z");
  const publish = (name: string, content: string, callId: string) => publishArtifact(store.commit, { name, kind: "text", title: name, content, callId, now });
  assert.equal((await publish("notes", "one", "call-1")).version, 1);
  assert.equal((await publish("notes", "two", "call-2")).version, 2);
  assert.equal((await publish("notes", "again", "call-2")).version, 2, "a call run again after a crash gets the version it wrote, not another");
  assert.deepEqual((await listArtifacts(store.reader)).map(item => [item.name, item.versions.length]), [["notes", 2]]);
  assert.equal((await readArtifact(store.reader, "notes", 2)).content, "two");
  await assert.rejects(publish("big", "x".repeat(artifactLimits.bytes + 1), "call-3"), /at most 1 MiB/);
  await assert.rejects(publish("big", "é".repeat(artifactLimits.bytes / 2 + 1), "call-3"), /at most 1 MiB/, "the limit is in UTF-8 bytes");
  const filled = memoryStore();
  for (let index = 0; index < 16; index++) await publishArtifact(filled.commit, { name: `part-${index}`, kind: "text", title: "Part", content: "x".repeat(artifactLimits.bytes), callId: `c${index}`, now });
  const before = JSON.stringify([...filled.docs]);
  await assert.rejects(publishArtifact(filled.commit, { name: "more", kind: "text", title: "More", content: "x", callId: "c-more", now }), /16 MiB together/);
  assert.equal(JSON.stringify([...filled.docs]), before, "a refused version writes nothing");
  await assert.rejects(readArtifact(store.reader, "big", 1), /not in this session/);
  await assert.rejects(readArtifact(store.reader, "__proto__", 1), /not in this session/);
});

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Artifacts", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction, actorId = "test:alice"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

test("the agent publishes versions of an artifact into the session's own store; readers list and read them, and they outlive a restart", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-artifacts-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = "<!doctype html><h1>Sales</h1>";
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("publish_artifact", { name: "chart", kind: "html", content: page, title: "Sales chart" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Published."),
    fauxAssistantMessage([fauxToolCall("publish_artifact", { name: "chart", kind: "svg", content: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Again."),
    fauxAssistantMessage([fauxToolCall("publish_artifact", { name: "Bad Name", kind: "text", content: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Refused."),
    fauxAssistantMessage([fauxToolCall("publish_artifact", { name: "notes", kind: "markdown", content: "# Notes" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Not in a Read-only message."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-artifacts-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "artifacts-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const admissionId = await sha256("artifacts admission");
  const send = async (content: string, options?: { access: "read" }) => {
    await session.submit(await ticket(id, "submit"), { content, requestId: randomUUID(), admissionId, ...(options ? { options } : {}) }, "write");
    await idle(session);
  };
  const results = async () => (await session.view()).entries.filter(entry => entry.role === "toolResult");
  const read = async (input: unknown) => session.artifacts(await ticket(id, "artifacts", "test:bob"), input);

  await send("Draw the sales chart.");
  const first = (await results()).at(-1)!;
  assert.deepEqual(publishedArtifact(first), { name: "chart", version: 1, kind: "html", title: "Sales chart" });
  await send("Draw it as SVG.");
  assert.deepEqual(publishedArtifact((await results()).at(-1)!), { name: "chart", version: 2, kind: "svg", title: "chart" }, "the same name makes the next version");
  await send("Publish under a bad name.");
  assert.match((await results()).at(-1)!.text, /name must be lowercase letters/);
  await send("Only look.", { access: "read" });
  assert.match((await results()).at(-1)!.text, /Read-only message/);

  const listed = await read({}) as { artifacts: ArtifactSummary[] };
  assert.deepEqual(listed.artifacts.map(item => [item.name, item.versions.map(version => [version.version, version.kind, version.title, version.size])]),
    [["chart", [[1, "html", "Sales chart", Buffer.byteLength(page)], [2, "svg", "chart", 41]]]]);
  const one = await read({ name: "chart", version: 1 }) as { artifact: Artifact };
  assert.equal(one.artifact.content, page, "a version keeps its bytes after the next one");
  await assert.rejects(read({ name: "chart", version: 3 }), (error: unknown) => error instanceof RunnerError && error.status === 404);
  await assert.rejects(read({ name: "notes", version: 1 }), (error: unknown) => error instanceof RunnerError && error.status === 404);
  await assert.rejects(read({ name: "constructor", version: 1 }), (error: unknown) => error instanceof RunnerError && error.status === 404);
  await assert.rejects(read({ path: "x" }), (error: unknown) => error instanceof RunnerError && error.status === 400);

  await session.restart();
  assert.deepEqual(await read({ name: "chart", version: 1 }), one, "they are in the session's durable store, so a restart, a backup and a move keep them");
});
