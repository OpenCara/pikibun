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
import type { AuthorizationRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import type { SessionsToolRequest } from "../packages/shared/src/cross-session.js";
import type { WorkspaceExtensionsAnswer } from "../packages/shared/src/host-extensions.js";
import { roleTools, toolsOff } from "../packages/shared/src/tool-groups.js";
import { sha256 } from "../packages/shared/src/crypto.js";

const owner = "test:alice";
const sender = "test:bob";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: owner, agentVersionId: "version-1", title: "Tool groups", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: owner, githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: owner, workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.",
      tools: ["read_file", "write_file", "sessions", "github_merge"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction, actorId = owner): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId: owner, action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

type Context = { messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[] };

function offeredTools(context: Context): string[] {
  const tools = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools];
}

test("a message runs only the tools both its sender and the session's owner have: others' messages can't borrow the owner's tools", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-sender-tools-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const collaborators = { name: "Collaborators", off: toolsOff(roleTools.collaborator) };
  const readers = { name: "Readers", off: toolsOff(["identity", "list_files", "read_file", "search"]) };
  let current: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false, toolGroups: { [sender]: collaborators } };
  const offered: string[][] = [];
  const noting = (context: Context) => { offered.push(offeredTools(context)); return fauxAssistantMessage("Noted."); };
  const narrowed = (context: Context) => {
    offered.push(offeredTools(context));
    current = { ...current, toolGroups: { [sender]: readers } };
    return fauxAssistantMessage([fauxToolCall("sessions", { action: "list" }), fauxToolCall("write_file", { path: "borrowed.txt", content: "x" })], { stopReason: "toolUse" });
  };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    noting, noting, narrowed, fauxAssistantMessage("Refused."),
    fauxAssistantMessage([fauxToolCall("sessions", { action: "list" })], { stopReason: "toolUse" }), fauxAssistantMessage("Listed."),
  ] as never);
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: SessionsToolRequest[] = [];
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-sender-tools-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    crossSessions: async request => { requests.push(request); return { sessions: [] } as never; },
    extensions: { installed: () => [], workspace: async () => current, lastKnown: () => current },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "sender-tools-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const transcript = async () => (await session.view()).entries.map(entry => entry.text).join("\n");
  const send = async (actorId: string, requestId: string) => {
    await session.submit(await ticket(id, "submit", actorId), { content: "Go on.", requestId, admissionId: await sha256(requestId) }, "write");
    await idle(session);
  };

  await send(sender, "collaborator");
  assert.ok(!offered[0]!.includes("github_merge"), `a collaborator's message isn't offered the owner's merges: ${offered[0]!.join()}`);
  for (const tool of ["read_file", "write_file", "sessions"]) assert.ok(offered[0]!.includes(tool), `${tool}: ${offered[0]!.join()}`);

  await send(owner, "owner");
  assert.ok(offered[1]!.includes("github_merge"), "the owner's own message keeps every tool of theirs");

  await send(sender, "narrowed");
  const text = await transcript();
  assert.equal(text.match(/isn't among the tools of the person who sent this message \(Readers\)/g)?.length, 2, text);
  assert.equal(requests.length, 0, "the sessions tool reached nothing");

  await send(owner, "owner-sessions");
  assert.equal(requests.length, 1, "the owner's message still uses the tool their sender lacked");
  assert.equal(requests[0]!.actorId, owner);
});
