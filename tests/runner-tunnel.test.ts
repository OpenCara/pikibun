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
import type { RunnerSession } from "../apps/runner/src/session.js";
import type { AuthorizationRequest, ChatOptions, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { toolNames } from "../packages/shared/src/types.js";
import type { WorkspaceExtensionsAnswer } from "../packages/shared/src/host-extensions.js";
import type { HostTunnelStatus, SessionTunnelReport } from "../packages/shared/src/tunnel.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { HostTunnels } from "../apps/runner/src/tunnel-host.js";
import { fakeCloudflared } from "./helpers/fake-cloudflared.js";
import { linuxSandboxMissing } from "./helpers/workspaces.js";

const HOST = "host-1";

function binding(id: string, connector = false): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Preview", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z",
      repositories: [], ...(connector ? { connectorId: HOST, connectorOwnerId: "test:alice" } : {}) },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: [...toolNames], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", ...(connector ? { connectorId: HOST, connectorOwnerId: "test:alice" } : {}) },
  };
}

async function ticket(id: string, action: RunnerAction, actorId = "test:alice", connector = false): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(""),
    ...(connector ? { connectorId: HOST } : {}) };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1500; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

const ready: HostTunnelStatus = { source: "auto", state: "ready", executable: "/usr/local/bin/cloudflared", downloadable: true };

test("the tunnel is off until the workspace turns it on, and a session on its host is never offered it, saying why", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-tunnel-host-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const offered: string[][] = [];
  const instructions: string[] = [];
  const record = (context: { messages: { role: string; toolsAdded?: { name: string }[] }[] }) => {
    offered.push(context.messages.flatMap(message => message.role === "system" ? (message.toolsAdded ?? []).map(tool => tool.name) : []));
    instructions.push(JSON.stringify(context));
  };
  faux.setResponses([
    ((context: never) => { record(context); return fauxAssistantMessage([fauxToolCall("tunnel", { action: "start", serve: { program: "node", args: ["server.js"], port: 4173 } })], { stopReason: "toolUse" }); }) as never,
    fauxAssistantMessage("Off."),
    ((context: never) => { record(context); return fauxAssistantMessage([fauxToolCall("tunnel", { action: "start", serve: { program: "node", args: ["server.js"], port: 4173 } })], { stopReason: "toolUse" }); }) as never,
    fauxAssistantMessage("On the host."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  let opened = 0;
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-tunnel-host-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
    tunnels: { open: async () => { opened++; throw new Error("never opened"); }, status: () => ready },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "tunnel-host-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Put it online.", requestId: "off", admissionId: await sha256("tunnel off") }, "write");
  await idle(session);
  let view = await session.view();
  assert.ok(!offered[0]!.includes("tunnel"));
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool tunnel is not available/);
  const tunnelReason = () => view.extensions?.unavailable?.filter(item => item.source === "piki:tunnel");
  assert.deepEqual(tunnelReason(), []);
  answer = { extensions: [{ source: "piki:tunnel", enabled: true, tools: "automatic", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Now?", requestId: "on-host", admissionId: await sha256("tunnel on host") }, "write");
  await idle(session);
  view = await session.view();
  assert.ok(!offered[1]!.includes("tunnel"));
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool tunnel is not available/);
  assert.deepEqual(tunnelReason(), [{ source: "piki:tunnel", tools: ["tunnel"], reason: "on-host" }]);
  assert.match(instructions[1]!, /This session has no tunnel tool: The tunnel serves only from a session's sandbox, and this session runs on its host itself/);
  assert.equal(view.approvals.length, 0, "nothing asked anyone");
  assert.equal(opened, 0);
  assert.equal(view.tunnel, undefined);
  assert.deepEqual(await session.tunnelAction(await ticket(id, "tunnel"), { action: "stop" }), { stopped: false });
  await assert.rejects(session.tunnelAction(await ticket(id, "tunnel"), { action: "start" }), /Invalid tunnel request/);
  await assert.rejects(session.tunnelAction(await ticket(id, "tunnel"), { action: "stop", reason: "whim" }), /Invalid tunnel request/);
});

test("a tunnel start runs at once for the host's owner and is refused in Read-only; its server stays online in the sandbox until stopped, the session's work stops or the session closes",
  { skip: linuxSandboxMissing(), timeout: 120_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-tunnel-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const serve = { program: "node", args: ["server.js", String(port)], directory: "site", port };
  const start = () => fauxAssistantMessage([fauxToolCall("tunnel", { action: "start", serve })], { stopReason: "toolUse" });
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([start(), fauxAssistantMessage("Online."), start(), fauxAssistantMessage("Read only."),
    start(), fauxAssistantMessage("Again."), start(), fauxAssistantMessage("Last.")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const lines: string[] = [];
  const executable = await fakeCloudflared(directory);
  const hostTunnels = new HostTunnels({ cloudflared: () => ({ executable }), directory: join(directory, "connector-tunnels"), log: line => lines.push(line), connectMs: 5000 });
  t.after(() => hostTunnels.close());
  const reports: SessionTunnelReport[] = [];
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-tunnel-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, connectorId: HOST,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => ({ extensions: [{ source: "piki:tunnel", enabled: true, tools: "automatic", settings: {} }], automaticTools: true }) },
    tunnels: { open: (socket, signal) => hostTunnels.open(socket, signal), status: () => ready },
    reportTunnel: async report => { reports.push(report); },
  });
  await service.initialize();
  let closed = false;
  t.after(async () => { if (!closed) await service.close(); });
  const id = "tunnel-session";
  const session = await service.provision(binding(id, true), await ticket(id, "create", "test:alice", true));
  await session.sandbox.writeFile("site/server.js", `require("node:http").createServer((request, response) => response.end("hello from the sandbox " + request.url))
    .listen(Number(process.argv[2]), "127.0.0.1", () => console.log("listening on " + process.argv[2]));`, async () => {});
  const send = async (requestId: string, options?: ChatOptions) => session.submit(await ticket(id, "submit", "test:alice", true),
    { content: "Put the site online.", requestId, admissionId: await sha256(`tunnel ${requestId}`), ...(options ? { options } : {}) }, "write");
  const edge = async () => Number(lines.map(line => /^FAKE_EDGE=(\d+)$/.exec(line)?.[1]).filter(Boolean).at(-1));

  await send("first");
  await idle(session);
  let view = await session.view();
  assert.deepEqual(view.approvals, [], "nobody is asked");
  const url = view.tunnel?.url;
  assert.match(url ?? "", /^https:\/\/fake-quick-tunnel\.trycloudflare\.com$/);
  assert.deepEqual([view.tunnel!.command, view.tunnel!.port, view.tunnel!.startedBy], [`node server.js ${port}`, port, "test:alice"]);
  assert.match(view.entries.map(entry => entry.text).join("\n"), /fake-quick-tunnel\.trycloudflare\.com/);
  assert.deepEqual(reports.map(report => [report.sessionId, report.event, report.url, report.actorId]), [[id, "started", url, "test:alice"]]);
  assert.equal(await (await fetch(`http://127.0.0.1:${await edge()}/phone`)).text(), "hello from the sandbox /phone");

  await send("read", { access: "read" });
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /a Read-only message doesn't take/);
  assert.equal(view.tunnel?.url, url, "the tunnel online stays");

  assert.deepEqual(await session.tunnelAction(await ticket(id, "tunnel", "test:alice", true), { action: "stop" }), { stopped: true, url });
  assert.equal((await session.view()).tunnel, undefined);
  assert.deepEqual(reports.at(-1), { sessionId: id, event: "stopped", url, reason: "stop", actorId: "test:alice" });
  await assert.rejects(fetch(`http://127.0.0.1:${await edge()}/`), "offline");

  await send("again");
  await idle(session);
  assert.ok((await session.view()).tunnel);
  await session.stop(await ticket(id, "stop", "test:alice", true));
  assert.equal((await session.view()).tunnel, undefined);
  assert.equal(reports.at(-1)!.reason, "session-stop");

  await send("last");
  await idle(session);
  assert.ok((await session.view()).tunnel);
  closed = true;
  await service.close();
  assert.equal(reports.at(-1)!.event, "stopped");
  assert.equal(reports.at(-1)!.reason, "closed");
  assert.deepEqual(reports.map(report => report.event), ["started", "stopped", "started", "stopped", "started", "stopped"]);
});
