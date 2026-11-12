import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneCalls } from "../apps/runner/src/connector/control-plane.js";
import type { Generation } from "../apps/runner/src/connector/generation.js";
import { boundedBody, CallbackRefused, decodeJson, refusedReport } from "../apps/runner/src/connector/wire.js";
import { RunnerError } from "../apps/runner/src/protocol.js";

function generation(): Generation {
  return { socket: {} as Generation["socket"], abort: new AbortController(), done: Promise.withResolvers(), welcome: Promise.withResolvers(), connectionToken: "c".repeat(32),
    active: new Set(), tail: Promise.resolve(), waiting: new Set(), incomingBytes: 0, runtimeReady: Promise.withResolvers() };
}

function fixture(answer: (url: string, init: RequestInit) => Response) {
  const asked: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  let authorized = true;
  const current = generation();
  const calls = new ControlPlaneCalls({
    credentials: () => ({ connectorId: "connector-1", token: "t".repeat(32), controlPlaneUrl: "https://pikibun.example" }),
    settings: { version: "1.2.3", fetch: async (input, init) => {
      asked.push({ url: String(input), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      return answer(String(input), init!);
    } },
    lifetime: new AbortController().signal,
    requireGeneration: () => { if (!authorized) throw new Error("Connector generation is no longer authorized"); },
    connection: async () => current,
  });
  return { calls, asked, current, revoke: () => { authorized = false; } };
}

test("connector calls: a callback goes as this connector and connection, and nothing goes once the connection's generation ended", async () => {
  const { calls, asked, current, revoke } = fixture(() => Response.json({ allowed: true, ownerId: "github:1", policyVersion: 3 }));
  const result = await calls.authorize(current, { sessionId: "s1", ownerId: "github:1", actorId: "github:2", permission: "write", host: true, hostSessions: true });
  assert.deepEqual(result, { allowed: true, ownerId: "github:1", policyVersion: 3 });
  assert.equal(asked[0]!.url, "https://pikibun.example/api/connectors/self/authorize");
  assert.equal(asked[0]!.headers.authorization, `Bearer ${"t".repeat(32)}`);
  assert.equal(asked[0]!.headers["x-connection-token"], "c".repeat(32));
  assert.deepEqual(asked[0]!.body, { sessionId: "s1", actorId: "github:2", ownerId: "github:1", permission: "write", host: true, hostSessions: true });
  revoke();
  await assert.rejects(calls.callback(current, "/api/connectors/self/config", {}), /no longer authorized/);
  assert.equal(asked.length, 1);
});

test("connector calls: an authorization for another owner is refused, a refused callback says only its status, and a broker's reason passes through", async () => {
  const other = fixture(() => Response.json({ allowed: true, ownerId: "github:9", policyVersion: 1 }));
  await assert.rejects(other.calls.authorize(other.current, { sessionId: "s1", ownerId: "github:1", actorId: "github:1", permission: "write" }), /Invalid authorization response/);
  const refused = fixture(() => new Response("{}", { status: 400 }));
  await assert.rejects(refused.calls.callback(refused.current, "/x", {}), (error: unknown) => error instanceof CallbackRefused && error.status === 400 && refusedReport(error));
  const broker = fixture(() => Response.json({ error: "Head moved" }, { status: 409 }));
  await assert.rejects(broker.calls.brokerCallback(broker.current, "/x", {}), (error: unknown) => error instanceof RunnerError && error.status === 409 && error.message === "Head moved");
  const opaque = fixture(() => Response.json({ error: "\u0000" }, { status: 502 }));
  await assert.rejects(opaque.calls.brokerCallback(opaque.current, "/x", {}), /Scoped connector callback denied or unavailable/);
});

test("connector calls: reports check what they send, and only a failure that may pass is an error", async () => {
  const { calls, current } = fixture(() => new Response(null, { status: 404 }));
  await calls.reportActivity(current, "s1", "working");
  await assert.rejects(calls.reportActivity(current, "s1", "dancing" as never), /Invalid activity report/);
  await assert.rejects(calls.reportBranches(current, "bad id", []), /Invalid branch report/);
  const busy = fixture(() => new Response(null, { status: 503 }));
  await assert.rejects(busy.calls.reportTunnel(busy.current, { sessionId: "s1" } as never), /Tunnel report unavailable/);
});

test("connector wire: bodies are read within their limit, and only as UTF-8 JSON", async () => {
  assert.deepEqual([...await boundedBody(new Response("abc"), 3)], [97, 98, 99]);
  await assert.rejects(boundedBody(new Response("abcd"), 3), /exceeds connector limit/);
  await assert.rejects(boundedBody(new Response("ab", { headers: { "content-length": "99" } }), 3), /exceeds connector limit/);
  assert.deepEqual(decodeJson(new TextEncoder().encode("{\"a\":1}")), { a: 1 });
  assert.throws(() => decodeJson(new Uint8Array([0xff])), /Invalid control-plane response/);
});
