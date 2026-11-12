import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneCalls } from "../apps/runner/src/connector/control-plane.js";
import type { Generation } from "../apps/runner/src/connector/generation.js";
import { boundedBody, CallbackRefused, decodeJson, refusedReport } from "../apps/runner/src/connector/wire.js";
import { RelayFrames } from "../apps/runner/src/connector/frames.js";
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

test("connector calls: every call says the connector's version, and a report whose connection ended while it was sent fails", async () => {
  const { calls, asked, current } = fixture(() => Response.json({}));
  await calls.callback(current, "/api/connectors/self/config", {});
  await calls.brokerCallback(current, "/api/connectors/self/network", {});
  await calls.reportActivity(current, "s1", "working");
  await calls.reportTunnel(current, { sessionId: "s1", event: "stopped", url: "https://a.trycloudflare.com", reason: "stop" });
  await calls.reportBranches(current, "s1", [{ repository: "acme/app", branch: "feature" } as never]);
  assert.deepEqual(asked.map(call => call.url.slice("https://pikibun.example/api/connectors/self/".length)), ["config", "network", "activity", "tunnel", "branches"]);
  assert.deepEqual(asked.map(call => call.headers["x-pikibun-version"]), Array(5).fill("1.2.3"));
  assert.deepEqual(asked.map(call => call.headers["x-connection-token"]), Array(5).fill("c".repeat(32)));
  assert.deepEqual(asked[4]!.body, { sessionId: "s1", branches: [{ repository: "acme/app", branch: "feature" }] });
  for (const send of [
    (sent: ReturnType<typeof fixture>) => sent.calls.reportActivity(sent.current, "s1", "working"),
    (sent: ReturnType<typeof fixture>) => sent.calls.reportTunnel(sent.current, { sessionId: "s1", event: "stopped", url: "https://a.trycloudflare.com", reason: "stop" }),
    (sent: ReturnType<typeof fixture>) => sent.calls.reportBranches(sent.current, "s1", []),
  ]) {
    const ending: ReturnType<typeof fixture> = fixture(() => { ending.revoke(); return new Response(null, { status: 204 }); });
    await assert.rejects(send(ending), /no longer authorized/);
    assert.equal(ending.asked.length, 1);
  }
});

function frames(options: { connected?: boolean; restarting?: boolean; callback?: () => Promise<unknown> } = {}) {
  const reasons: string[] = [];
  const current = generation();
  const relay = new RelayFrames({
    secret: "s".repeat(48), state: () => ({ connectorId: "connector-1", token: "t".repeat(32), controlPlaneUrl: "https://pikibun.example" }),
    restarting: () => options.restarting === true, runtime: () => undefined, welcomed: () => options.connected === false ? undefined : current,
    calls: { callback: options.callback ?? (async () => { throw new Error("no control plane"); }) },
    disconnect: (_generation, reason) => { reasons.push(reason); }, requireGeneration: () => {},
  });
  return { relay, reasons, current };
}

const request = (id: string) => ({ type: "request", id, method: "GET", path: "/v1/not-a-route", body: "", ticket: {
  aud: "runner", sessionId: "s1", actorId: "github:1", ownerId: "github:1", action: "view", policyVersion: 1, iat: 0, exp: Math.floor(Date.now() / 1000) + 60,
  jti: id, bodyHash: "h".repeat(43), connectorId: "connector-1" } });

test("connector frames: a malformed frame, a request the host can't route and a replayed one each end the connection", async () => {
  const { relay, reasons, current } = frames();
  relay.dispatch(current, { type: "request" }, 10);
  assert.deepEqual(reasons, ["Invalid relay request"]);
  relay.dispatch(current, request("r1"), 10);
  assert.equal(current.incomingBytes, 10);
  await Promise.all([...current.active]);
  assert.equal(reasons[1], "Relay request failed: Relay path is not allowed");
  assert.equal(current.incomingBytes, 0);
  relay.dispatch(current, request("r1"), 10);
  assert.equal(reasons[2], "Replayed relay request");
  await relay.settled();
});

test("connector frames: an upload sent straight to the host needs a connection and a grant the control plane confirms", async () => {
  const offline = await frames({ connected: false }).relay.direct({ grant: "g", body: "{}" });
  assert.equal(offline.status, 503);
  const invalid = await frames().relay.direct({ grant: 1 as never, body: "{}" });
  assert.equal(invalid.status, 400);
  const refused = await frames().relay.direct({ grant: "g", body: "{}" });
  assert.deepEqual([refused.status, JSON.parse(refused.body)], [403, { error: "The control plane refused the upload grant.", code: "connector_reply_error" }]);
});

test("connector frames: uploads sent straight to the host fill only their own share of the replay guard, so relay requests still run", async () => {
  let sent = 0;
  const granted = () => ({ ticket: { ...request(`upload-${sent}`).ticket, action: "upload" }, size: 1, path: "/v1/sessions/s1/upload" });
  const { relay, reasons, current } = frames({ callback: async () => granted() });
  const upload = async () => { sent++; return relay.direct({ grant: "g", body: "{\"size\":1}" }); };
  for (let index = 0; index < 4097; index++) assert.equal((await upload()).status, 400);
  const full = await upload();
  assert.deepEqual([full.status, JSON.parse(full.body)], [503, { error: "The host is taking too many requests at once; try again shortly.", code: "connector_reply_error" }]);
  sent = 1;
  const again = await relay.direct({ grant: "g", body: "{\"size\":1}" });
  assert.deepEqual([again.status, JSON.parse(again.body).error], [409, "That upload grant was already used."]);
  relay.dispatch(current, request("relayed-1"), 10);
  await Promise.all([...current.active]);
  assert.deepEqual(reasons, ["Relay request failed: Relay path is not allowed"]);
  relay.dispatch(current, request("upload-1"), 10);
  assert.equal(reasons[1], "Replayed relay request");
  await relay.settled();
});

test("connector wire: bodies are read within their limit, and only as UTF-8 JSON", async () => {
  assert.deepEqual([...await boundedBody(new Response("abc"), 3)], [97, 98, 99]);
  await assert.rejects(boundedBody(new Response("abcd"), 3), /exceeds connector limit/);
  await assert.rejects(boundedBody(new Response("ab", { headers: { "content-length": "99" } }), 3), /exceeds connector limit/);
  assert.deepEqual(decodeJson(new TextEncoder().encode("{\"a\":1}")), { a: 1 });
  assert.throws(() => decodeJson(new Uint8Array([0xff])), /Invalid control-plane response/);
});
