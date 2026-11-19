import assert from "node:assert/strict";
import { connect as netConnect, createServer, type AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { app } from "../apps/server/src/index.js";
import { connectorWorkspaceExtensions } from "../apps/server/src/extensions.js";
import type { Env } from "../apps/server/src/types.js";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import {
  CACHE_LOCK_STALE_MS, CACHE_MAX_AGE_MS, CACHE_PACKAGES_LIMIT, copySafeTree, defaultExtensionCacheDir, ExtensionCache, extensionCacheKey, installShellCommand,
  refusingDescribe, registryOnlyProxy,
} from "../apps/runner/src/extensions/cache.js";
import { egressSocketPath } from "../apps/runner/src/egress.js";
import { processDescribe } from "../apps/runner/src/extensions/describe.js";
import { HostExtensions, MANAGED_RETRY_MS } from "../apps/runner/src/extensions/host.js";
import { ExtensionStore } from "../apps/runner/src/extensions/store.js";
import { extensionView } from "../apps/runner/src/session/view.js";
import type { ConnectorCredentials, ConnectorPairing } from "../packages/shared/src/connector.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { defaultHostConfig } from "../packages/shared/src/host-config.js";
import {
  extensionAvailability, parseWorkspaceExtensions, parseWorkspaceExtensionsAnswer, type ExtensionAvailability, type InstalledExtension,
  type RegistryExtensionMetadata, type WorkspaceExtension,
} from "../packages/shared/src/host-extensions.js";
import { pikiSessionToolExtensions, sessionToolsOff } from "../packages/shared/src/piki-extensions.js";
import { extensionDescription } from "../packages/shared/src/workspace-tools.js";
import { fakeHub, testDatabase } from "./helpers/control-plane.js";
import { binding as sessionBinding } from "./helpers/workspaces.js";

const digest = (text: string) => `sha512-${createHash("sha512").update(text).digest("base64")}`;
const origin = "http://localhost:8787";
const testSecret = "extension-planes-test-secret-not-for-deployment";

async function tempDir(t: TestContext, prefix = "pikibun-planes-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function serverFixture(t: TestContext, registry: Record<string, { name?: string; version?: string; description?: string; integrity?: string; status?: number }> = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const hub = fakeHub({ rpc: () => Response.json({ error: "Unsupported test relay request" }, { status: 503 }) });
  const fetchedUrls: string[] = [];
  const env: Env = {
    DB: db,
    APP_ORIGIN: origin,
    TEST_AUTH_ENABLED: "true",
    TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
    VAULT_KEY: Buffer.alloc(32, 9).toString("base64url"),
    CONNECTOR_HUB: hub,
    NPM_REGISTRY_FETCH: async input => {
      const url = String(input);
      fetchedUrls.push(url);
      const entry = registry[url];
      if (!entry) return new Response("not found", { status: 404 });
      if (entry.status && entry.status !== 200) return new Response("error", { status: entry.status });
      return Response.json({
        name: entry.name,
        version: entry.version,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        dist: { integrity: entry.integrity },
      });
    },
  };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);

  async function client(name: string) {
    const res = await request("POST", "/api/auth/test", { id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` },
      { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(res);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const { csrfToken } = await json<{ csrfToken: string }>(await request("GET", "/api/auth/csrf", undefined, { Cookie: cookie }));
    return {
      user,
      request: (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
        request(method, path, body, { Cookie: cookie, "X-CSRF-Token": csrfToken, ...headers }),
    };
  }

  async function pairHost(owner: Awaited<ReturnType<typeof client>>, name: string, capabilities: Record<string, unknown>) {
    const { pairing } = await json<{ pairing: ConnectorPairing }>(await owner.request("POST", "/api/connectors/pairings", { name }), 201);
    const claimed = await json<{ credentials: ConnectorCredentials }>(await request("POST", `/api/connectors/pairings/${pairing.id}/claim`, {
      code: pairing.code,
      models: [{ provider: "local-native", modelId: "local/model-v1", name: "Local model" }],
      capabilities: { approvalFree: true, plainGit: true, extensions: true, ...capabilities },
    }), 201);
    const connectionToken = Buffer.from(randomBytes(32)).toString("base64url");
    sqlite.prepare("UPDATE connectors SET connection_hash = ? WHERE id = ?")
      .run(await sha256(connectionToken), claimed.credentials.connectorId);
    const self = (path: string, body: unknown) => request("POST", `/api/connectors/self/${path}`, body, {
      Authorization: `Bearer ${claimed.credentials.token}`,
      "X-Connection-Token": connectionToken,
    });
    const shareWith = (workspaceId: string) => {
      sqlite.prepare("INSERT INTO connector_shares (connector_id, workspace_id, created_at) VALUES (?, ?, ?)")
        .run(claimed.credentials.connectorId, workspaceId, new Date().toISOString());
    };
    return { ...claimed.credentials, connectionToken, self, shareWith };
  }

  return { sqlite, env, request, client, pairHost, fetchedUrls };
}

test("sessionToolSwitches: connectors receive every session-tool switch before their first report, without needing connectorPikiExtensions slots", () => {
  const off = (source: string): WorkspaceExtension => ({ source, enabled: false, tools: "automatic", settings: {} });
  const locked: WorkspaceExtension = {
    source: "npm:pi-web-access@0.46.0",
    enabled: true,
    tools: "automatic",
    settings: {},
    integrity: digest("pi-web-access@0.46.0"),
  };
  const list: WorkspaceExtension[] = [
    locked,
    { source: "piki:gh", enabled: true, tools: "automatic", settings: {} },
    { source: "piki:auto-mode", enabled: true, tools: "automatic", settings: {} },
    off("piki:schedule"),
    off("piki:python"),
    off("piki:notion"),
  ];

  const modern = connectorWorkspaceExtensions(list, undefined, { toolDefinitions: true, sessionToolSwitches: true, extensionLocks: true });
  assert.deepEqual(modern.map(item => item.source), ["npm:pi-web-access@0.46.0", "piki:gh", "piki:schedule", "piki:python", "piki:notion"]);
  assert.equal(modern[0]!.integrity, locked.integrity);

  const withoutLocks = connectorWorkspaceExtensions(list, undefined, { toolDefinitions: true, sessionToolSwitches: true });
  assert.equal(withoutLocks[0]!.integrity, undefined);

  const legacyUnreported = connectorWorkspaceExtensions(list, undefined, { toolDefinitions: true });
  assert.deepEqual(legacyUnreported.map(item => item.source), ["npm:pi-web-access@0.46.0"]);
  assert.equal(legacyUnreported[0]!.integrity, undefined);
});

test("workspace npm extensions lock registry integrity, populate server-verified registryMetadata, refuse mismatches, and never trust connector reports for shared descriptions", async t => {
  const pkgIntegrity = digest("@acme/pi-helper@1.0.0");
  const nextIntegrity = digest("@acme/pi-helper@1.1.0");
  const registryUrl10 = "https://registry.npmjs.org/@acme/pi-helper/1.0.0";
  const registryUrl11 = "https://registry.npmjs.org/@acme/pi-helper/1.1.0";
  const registry: Record<string, { name?: string; version?: string; description?: string; integrity?: string; status?: number }> = {
    [registryUrl10]: { name: "@acme/pi-helper", version: "1.0.0", description: "Verified registry description.", integrity: pkgIntegrity },
    [registryUrl11]: { name: "@acme/pi-helper", version: "1.1.0", description: "Updated registry description.", integrity: nextIntegrity },
  };
  const f = await serverFixture(t, registry);
  const alice = await f.client("alice");
  const bob = await f.client("bob");
  const { workspace: wsA } = await json<{ workspace: { id: string } }>(await alice.request("POST", "/api/workspaces", { name: "Alpha" }), 201);
  const { workspace: wsB } = await json<{ workspace: { id: string } }>(await bob.request("POST", "/api/workspaces", { name: "Beta" }), 201);
  const linuxHost = await f.pairHost(alice, "Linux Box", { platform: "linux", sandbox: true, productionShell: false });
  const winHost = await f.pairHost(alice, "Win Box", { platform: "win32", sandbox: true, productionShell: false });
  linuxHost.shareWith(wsA.id);
  winHost.shareWith(wsA.id);

  const wrongRes = await alice.request("PUT", `/api/workspaces/${wsA.id}/extensions`, {
    source: "npm:@acme/pi-helper@1.0.0",
    enabled: true,
    integrity: digest("tampered"),
  });
  assert.equal((await json<{ code: string }>(wrongRes, 409)).code, "integrity_mismatch");

  const putRes = await json<{ extensions: WorkspaceExtension[] }>(await alice.request("PUT", `/api/workspaces/${wsA.id}/extensions`, {
    source: "npm:@acme/pi-helper@1.0.0",
    enabled: true,
  }));
  const saved = putRes.extensions.find(item => item.source === "npm:@acme/pi-helper@1.0.0")!;
  assert.equal(saved.integrity, pkgIntegrity);

  const getBeforeReport = await json<{ extensions: WorkspaceExtension[]; registryMetadata?: Record<string, RegistryExtensionMetadata> }>(
    await alice.request("GET", `/api/workspaces/${wsA.id}/extensions`),
  );
  assert.deepEqual(getBeforeReport.registryMetadata, {
    "npm:@acme/pi-helper@1.0.0": { name: "@acme/pi-helper", version: "1.0.0", description: "Verified registry description." },
  });
  assert.equal(extensionDescription("npm:@acme/pi-helper@1.0.0", [], getBeforeReport.registryMetadata), "Verified registry description.");

  delete registry[registryUrl10];
  const toggleRes = await json<{ extensions: WorkspaceExtension[] }>(await alice.request("PUT", `/api/workspaces/${wsA.id}/extensions`, {
    source: "npm:@acme/pi-helper@1.0.0",
    enabled: true,
    settings: { mode: "strict" },
  }));
  assert.equal(toggleRes.extensions.find(item => item.source === "npm:@acme/pi-helper@1.0.0")?.integrity, pkgIntegrity);

  const overwriteRes = await alice.request("PUT", `/api/workspaces/${wsA.id}/extensions`, {
    source: "npm:@acme/pi-helper@1.0.0",
    enabled: true,
    integrity: digest("another"),
  });
  assert.equal((await json<{ code: string }>(overwriteRes, 409)).code, "integrity_mismatch");

  const preReportAnswer = parseWorkspaceExtensionsAnswer(await json(await linuxHost.self("extensions/workspace", {
    workspaceId: wsA.id,
    toolDefinitions: true,
    sessionToolSwitches: true,
    extensionLocks: true,
  })));
  assert.ok(sessionToolsOff(preReportAnswer.extensions).has("node"));
  assert.equal(preReportAnswer.extensions.find(item => item.source === "npm:@acme/pi-helper@1.0.0")?.integrity, pkgIntegrity);
  assert.equal(preReportAnswer.autoCache, undefined);

  const legacyAnswer = parseWorkspaceExtensionsAnswer(await json(await linuxHost.self("extensions/workspace", {
    workspaceId: wsA.id,
    toolDefinitions: true,
  })));
  assert.equal(legacyAnswer.extensions.find(item => item.source === "npm:@acme/pi-helper@1.0.0")?.integrity, undefined);

  const bobHost = await f.pairHost(bob, "Poison Host", { platform: "linux", sandbox: true, productionShell: false });
  bobHost.shareWith(wsB.id);
  await json(await bobHost.self("extensions", {
    report: {
      remoteInstalls: true,
      installed: [{
        source: "npm:@acme/pi-helper@1.0.0",
        dev: false,
        name: "@acme/pi-helper",
        version: "1.0.0",
        description: "POISONED DESCRIPTION FROM ANOTHER WORKSPACE HOST",
        modules: [{ path: "index.js", tools: [{ name: "evil_tool", description: "Injected prompt!" }], events: [], flags: [], noops: [], ignored: [] }],
      }],
    },
    results: [],
  }));
  const wsAAfterPoison = await json<{ registryMetadata?: Record<string, RegistryExtensionMetadata> }>(
    await alice.request("GET", `/api/workspaces/${wsA.id}/extensions`),
  );
  assert.equal(wsAAfterPoison.registryMetadata?.["npm:@acme/pi-helper@1.0.0"]?.description, "Verified registry description.");

  const syncAnswer = await json<{ reportAutoCache?: boolean }>(await linuxHost.self("extensions", { report: { remoteInstalls: true, installed: [], autoCache: true }, results: [] }));
  assert.equal(syncAnswer.reportAutoCache, true);
  await json(await winHost.self("extensions", { report: { remoteInstalls: true, installed: [], autoCache: true }, results: [] }));
  const hostDefault = await json<{ hosts: { id: string; availability?: Record<string, ExtensionAvailability> }[] }>(
    await alice.request("GET", `/api/workspaces/${wsA.id}/extensions`),
  );
  assert.deepEqual(hostDefault.hosts.find(item => item.id === linuxHost.connectorId)?.availability?.["npm:@acme/pi-helper@1.0.0"], { status: "auto-cache" });
  assert.deepEqual(hostDefault.hosts.find(item => item.id === winHost.connectorId)?.availability?.["npm:@acme/pi-helper@1.0.0"], { status: "missing" });
  const hostPage = await json<{ autoCache: boolean; autoCacheChoice: string; hostAutoCache?: boolean }>(await alice.request("GET", `/api/connectors/${linuxHost.connectorId}/extensions`));
  assert.deepEqual([hostPage.autoCache, hostPage.autoCacheChoice, hostPage.hostAutoCache], [true, "host", true]);

  assert.deepEqual(await json(await alice.request("PATCH", `/api/connectors/${linuxHost.connectorId}/extensions`, { autoCache: false })),
    { automaticTools: false, autoCache: false });
  const offAnswer = parseWorkspaceExtensionsAnswer(await json(await linuxHost.self("extensions/workspace", {
    workspaceId: wsA.id, toolDefinitions: true, sessionToolSwitches: true, extensionLocks: true,
  })));
  assert.equal(offAnswer.autoCache, false);
  const hostOff = await json<{ hosts: { id: string; availability?: Record<string, ExtensionAvailability> }[] }>(
    await alice.request("GET", `/api/workspaces/${wsA.id}/extensions`),
  );
  assert.deepEqual(hostOff.hosts.find(item => item.id === linuxHost.connectorId)?.availability?.["npm:@acme/pi-helper@1.0.0"], { status: "missing" });
  assert.deepEqual(await json(await alice.request("PATCH", `/api/connectors/${linuxHost.connectorId}/extensions`, { autoCache: null })),
    { automaticTools: false, autoCache: null });
  const backToHost = parseWorkspaceExtensionsAnswer(await json(await linuxHost.self("extensions/workspace", {
    workspaceId: wsA.id, toolDefinitions: true, sessionToolSwitches: true, extensionLocks: true,
  })));
  assert.equal(backToHost.autoCache, undefined);

  await json(await linuxHost.self("extensions", { report: { remoteInstalls: true, installed: [] }, results: [] }));
  await json(await winHost.self("extensions", { report: { remoteInstalls: true, installed: [] }, results: [] }));
  assert.deepEqual(await json(await alice.request("PATCH", `/api/connectors/${linuxHost.connectorId}/extensions`, { autoCache: true })),
    { automaticTools: false, autoCache: true });
  await json(await alice.request("PATCH", `/api/connectors/${winHost.connectorId}/extensions`, { autoCache: true }));

  const wsAWithAutoCache = await json<{ hosts: { id: string; availability?: Record<string, ExtensionAvailability> }[] }>(
    await alice.request("GET", `/api/workspaces/${wsA.id}/extensions`),
  );
  assert.deepEqual(wsAWithAutoCache.hosts.find(item => item.id === linuxHost.connectorId)?.availability?.["npm:@acme/pi-helper@1.0.0"], { status: "auto-cache" });
  assert.deepEqual(wsAWithAutoCache.hosts.find(item => item.id === winHost.connectorId)?.availability?.["npm:@acme/pi-helper@1.0.0"], { status: "missing" });

  const lockAnswer = parseWorkspaceExtensionsAnswer(await json(await linuxHost.self("extensions/workspace", {
    workspaceId: wsA.id,
    toolDefinitions: true,
    sessionToolSwitches: true,
    extensionLocks: true,
  })));
  assert.equal(lockAnswer.autoCache, true);

  const offlinePut = await json<{ extensions: WorkspaceExtension[] }>(await alice.request("PUT", `/api/workspaces/${wsA.id}/extensions`, {
    source: "npm:@acme/offline-pkg@0.1.0",
    enabled: true,
    integrity: digest("unverified-client-digest"),
  }));
  assert.equal(offlinePut.extensions.find(item => item.source === "npm:@acme/offline-pkg@0.1.0")?.integrity, undefined);
  const offlineRealDigest = digest("@acme/offline-pkg@0.1.0");
  registry["https://registry.npmjs.org/@acme/offline-pkg/0.1.0"] = {
    name: "@acme/offline-pkg",
    version: "0.1.0",
    description: "Resolved once registry recovered.",
    integrity: offlineRealDigest,
  };
  const recoveredPut = await json<{ extensions: WorkspaceExtension[] }>(await alice.request("PUT", `/api/workspaces/${wsA.id}/extensions`, {
    source: "npm:@acme/offline-pkg@0.1.0",
    enabled: true,
  }));
  assert.equal(recoveredPut.extensions.find(item => item.source === "npm:@acme/offline-pkg@0.1.0")?.integrity, offlineRealDigest);

  const upgraded = await json<{ extensions: WorkspaceExtension[] }>(await alice.request("PUT", `/api/workspaces/${wsA.id}/extensions`, {
    source: "npm:@acme/pi-helper@1.1.0",
    enabled: true,
  }));
  assert.equal(upgraded.extensions.find(item => item.source === "npm:@acme/pi-helper@1.1.0")?.integrity, nextIntegrity);
  assert.equal(extensionAvailability("git:https://github.com/acme/ext@0123456789abcdef0123456789abcdef01234567", [], { autoCache: true }).status, "missing");
  assert.equal(pikiSessionToolExtensions().length > 20, true);
});

interface FakePackageSpec {
  version?: string;
  integrity?: string;
  resolved?: string;
  link?: boolean;
  noLock?: boolean;
  extraResolved?: string;
  escapeSymlink?: string;
  hardLink?: boolean;
  moduleCode?: string;
}

async function writeFakeNpmInstall(stageDir: string, pkg: string, requestedVersion: string, spec: FakePackageSpec = {}): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "pikibun-fake-work-"));
  try {
    await writeFile(join(workDir, "package.json"), `${JSON.stringify({ name: "pikibun-cached-extension", private: true, dependencies: {} }, null, 2)}\n`, { mode: 0o600 });
    const version = spec.version ?? requestedVersion;
    const pkgDir = join(workDir, "node_modules", ...pkg.split("/"));
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({
      name: pkg,
      version,
      description: `${pkg} cached description`,
      type: "module",
      pi: { extensions: ["./index.js"] },
    }));
    await writeFile(join(pkgDir, "index.js"), spec.moduleCode ?? `import { Type } from "typebox";
export default function (pi) {
  pi.on("input", async event => event.text === "block-me" ? { action: "handled" } : { action: "continue" });
  pi.on("before_agent_start", async event => ({ systemPrompt: event.systemPrompt + "\\n\\ncached ${pkg}@${version}" }));
  pi.registerTool({
    name: "cached_echo",
    label: "Cached echo",
    description: "Echoes from cached extension.",
    parameters: Type.Object({ word: Type.String() }),
    async execute(_id, params) { return { content: [{ type: "text", text: "echo:" + params.word }] }; },
  });
}`);
    const manifest = JSON.parse(await readFile(join(workDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    manifest.dependencies[pkg] = version;
    await writeFile(join(workDir, "package.json"), JSON.stringify(manifest));
    if (spec.escapeSymlink) await symlink(spec.escapeSymlink, join(pkgDir, "escape.txt"));
    if (spec.hardLink) {
      const outside = join(stageDir, "..", "..", `outside-${randomBytes(4).toString("hex")}.txt`);
      await writeFile(outside, "secret");
      await link(outside, join(pkgDir, "hardlinked.txt"));
    }
    if (!spec.noLock) {
      const packages: Record<string, unknown> = {
        "": { dependencies: { [pkg]: version } },
        [`node_modules/${pkg}`]: {
          version,
          resolved: spec.resolved ?? `https://registry.npmjs.org/${pkg}/-/pkg-${version}.tgz`,
          integrity: spec.integrity ?? digest(`${pkg}@${version}`),
          ...(spec.link ? { link: true } : {}),
        },
      };
      if (spec.extraResolved) {
        packages["node_modules/helper-dep"] = {
          version: "1.0.0",
          resolved: spec.extraResolved,
          integrity: digest("helper-dep@1.0.0"),
        };
      }
      await writeFile(join(workDir, "package-lock.json"), JSON.stringify({
        name: "pikibun-cached-extension",
        lockfileVersion: 3,
        requires: true,
        packages,
      }));
    }
    await copySafeTree(workDir, stageDir);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

test("ExtensionCache shares 32-hex installs across connectors, coalesces concurrent installs, recovers stale locks, and prunes by age and count", async t => {
  const root = await tempDir(t);
  const cacheDir = join(root, "shared-cache");
  assert.match(extensionCacheKey("npm:@acme/ext@1.0.0", digest("@acme/ext@1.0.0")), /^[0-9a-f]{32}$/);
  assert.match(defaultExtensionCacheDir(join(root, "state"), { PIKIBUN_CACHE_DIR: "/tmp/refused-cache" }, "linux"), /state[/\\]extensions[/\\]cache$/);

  let installCount = 0;
  let describeCount = 0;
  let now = 10_000_000;
  const makeCache = () => new ExtensionCache(cacheDir, {
    sandboxed: true,
    connectorVersion: "0.34.0",
    now: () => now,
    install: async req => {
      installCount++;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
      await writeFakeNpmInstall(req.stageDir, req.package, req.version);
    },
    describe: async source => {
      describeCount++;
      return processDescribe(source);
    },
  });

  const cache1 = makeCache();
  const cache2 = makeCache();
  const source = "npm:@acme/ext@1.0.0";
  const integrity = digest("@acme/ext@1.0.0");

  const [first, second] = await Promise.all([cache1.ensure(source, integrity), cache2.ensure(source, integrity)]);
  assert.equal(installCount, 1);
  assert.equal(describeCount, 1);
  assert.equal(first.summary.name, "@acme/ext");
  assert.equal(second.root, first.root);
  assert.deepEqual(first.summary.modules[0]!.tools.map(tool => tool.name), ["cached_echo"]);

  const third = await makeCache().ensure(source, integrity);
  assert.equal(installCount, 1);
  assert.equal(describeCount, 1);
  assert.equal(third.root, first.root);

  const staleSource = "npm:@acme/stale-lock@1.0.0";
  const staleIntegrity = digest("@acme/stale-lock@1.0.0");
  const staleKey = extensionCacheKey(staleSource, staleIntegrity);
  const packagesDir = join(cacheDir, "packages");
  const entryKey = extensionCacheKey(source, integrity);
  await writeFile(join(packagesDir, `${entryKey}.lock`), `999999 active-token ${now}\n`);
  const transientFailCache = new ExtensionCache(cacheDir, {
    sandboxed: true,
    connectorVersion: "0.35.0",
    now: () => now,
    describe: async () => { throw new Error("transient describe failure"); },
  });
  await assert.rejects(transientFailCache.ensure(source, integrity, AbortSignal.timeout(80)));
  await rm(join(packagesDir, `${entryKey}.lock`), { force: true });
  assert.equal((await makeCache().ensure(source, integrity)).root, first.root);
  assert.equal(installCount, 1);

  await writeFile(join(packagesDir, `${staleKey}.lock`), `999999 stale-token ${now - CACHE_LOCK_STALE_MS - 1000}\n`);
  const recovered = await cache1.ensure(staleSource, staleIntegrity);
  assert.equal(recovered.summary.source, staleSource);

  const oldKey = "a".repeat(32);
  await mkdir(join(packagesDir, oldKey), { recursive: true });
  const oldDate = new Date(now - CACHE_MAX_AGE_MS - 5000);
  await writeFile(join(packagesDir, oldKey, "used"), "");
  await utimes(join(packagesDir, oldKey, "used"), oldDate, oldDate);
  const removedAge = await cache1.prune(new Set([extensionCacheKey(source, integrity)]));
  assert.ok(removedAge.includes(oldKey));

  for (let i = 0; i < CACHE_PACKAGES_LIMIT + 3; i++) {
    const k = i.toString(16).padStart(32, "0");
    await mkdir(join(packagesDir, k), { recursive: true });
    const d = new Date(now - (CACHE_PACKAGES_LIMIT + 10 - i) * 1000);
    await writeFile(join(packagesDir, k, "used"), "");
    await utimes(join(packagesDir, k, "used"), d, d);
  }
  const removedLimit = await cache1.prune(new Set([extensionCacheKey(source, integrity)]));
  assert.ok(removedLimit.length >= 4);
  const remaining = (await readdir(packagesDir)).filter(name => /^[0-9a-f]{32}$/.test(name));
  assert.equal(remaining.length, CACHE_PACKAGES_LIMIT);
  assert.ok(remaining.includes(extensionCacheKey(source, integrity)));
});

test("ExtensionCache refuses tampered digests, non-registry tarball URLs, links, escaping symlinks, hard links, git sources, and unsandboxed hosts", async t => {
  const root = await tempDir(t);
  const cases: { label: string; spec: FakePackageSpec; match: RegExp }[] = [
    { label: "wrong digest", spec: { integrity: digest("wrong") }, match: /digest isn't the one/ },
    { label: "wrong version", spec: { version: "2.0.0" }, match: /not 1\.0\.0/ },
    { label: "no lockfile", spec: { noLock: true }, match: /no package-lock\.json/ },
    { label: "private tarball URL", spec: { extraResolved: "http://127.0.0.1:8080/evil.tgz" }, match: /outside https:\/\/registry\.npmjs\.org\// },
    { label: "link in lockfile", spec: { link: true }, match: /holds a link/ },
    { label: "absolute symlink", spec: { escapeSymlink: "/etc/passwd" }, match: /absolute symbolic link/ },
    { label: "relative escaping symlink", spec: { escapeSymlink: "../../../../../etc/passwd" }, match: /symbolic link escaping/ },
    { label: "hard link", spec: { hardLink: true }, match: /hard-linked file/ },
    { label: "broken module", spec: { moduleCode: "throw new Error('boom at import');" }, match: /didn't load/ },
  ];

  for (const [index, item] of cases.entries()) {
    const cacheDir = join(root, `case-${index}`);
    const cache = new ExtensionCache(cacheDir, {
      sandboxed: true,
      describe: processDescribe,
      install: req => writeFakeNpmInstall(req.stageDir, req.package, req.version, item.spec),
    });
    const source = "npm:@acme/bad@1.0.0";
    const integrity = digest("@acme/bad@1.0.0");
    await assert.rejects(cache.ensure(source, integrity), item.match, item.label);
    const left = await readdir(join(cacheDir, "packages")).catch(() => []);
    assert.deepEqual(left, [], `${item.label} leaves nothing in packages/`);
  }

  const unsandboxed = new ExtensionCache(join(root, "unsandboxed"), { sandboxed: false });
  await assert.rejects(unsandboxed.ensure("npm:@acme/ok@1.0.0", digest("@acme/ok@1.0.0")), /only on sandboxed hosts/);
  await assert.rejects(refusingDescribe({ root: "", files: [] }), /only inside the host's sandbox/);
  const validCache = new ExtensionCache(join(root, "valid"), { sandboxed: true, describe: processDescribe, install: async () => {} });
  await assert.rejects(validCache.ensure("git:https://github.com/acme/ext@0123456789abcdef0123456789abcdef01234567", digest("git")), /Only npm: extensions/);
  await assert.rejects(validCache.ensure("npm:@acme/ok@1.0.0", "sha1-nope"), /Missing sha512 integrity/);
});

test("Plane 2 vs Plane 3: auto-cached extensions run in sandboxed sessions, respect --no-remote-installs and backoff, and never run in on-host sessions", async t => {
  const root = await tempDir(t);
  let now = 50_000_000;
  let shouldFail = true;
  let installs = 0;
  const pkgSource = "npm:@acme/sandbox-ext@1.0.0";
  const pkgIntegrity = digest("@acme/sandbox-ext@1.0.0");

  const store = new ExtensionStore(join(root, "state", "extensions"));
  const cache = new ExtensionCache(join(root, "cache"), {
    sandboxed: true,
    now: () => now,
    describe: processDescribe,
    install: async req => {
      installs++;
      if (shouldFail) throw new Error("registry temporarily unreachable");
      await writeFakeNpmInstall(req.stageDir, req.package, req.version);
    },
  });

  const noRemoteHost = new HostExtensions(store, { remoteInstalls: false, autoCache: true, cache, now: () => now, log: () => {} });
  await noRemoteHost.load();
  const lockedList: WorkspaceExtension[] = parseWorkspaceExtensions([{ source: pkgSource, enabled: true, integrity: pkgIntegrity }]);
  assert.deepEqual(await noRemoteHost.ensureCached(lockedList, true), []);
  assert.equal(installs, 0);

  const defaultOnHost = new HostExtensions(store, { remoteInstalls: true, autoCache: true, cache, now: () => now, log: () => {} });
  assert.equal(defaultOnHost.autoCacheDefault, true);
  assert.deepEqual([defaultOnHost.canAutoCache(), defaultOnHost.canAutoCache(true), defaultOnHost.canAutoCache(false)], [true, true, false]);
  const refusedHost = new HostExtensions(store, { remoteInstalls: true, autoCache: false, autoCacheRefused: true, cache, now: () => now, log: () => {} });
  assert.equal(refusedHost.autoCacheDefault, false);
  assert.deepEqual([refusedHost.canAutoCache(), refusedHost.canAutoCache(true)], [false, false], "--no-auto-cache-extensions wins over Pikibun's setting");

  const defaultOffHost = new HostExtensions(store, { remoteInstalls: true, cache, now: () => now, log: () => {} });
  await defaultOffHost.load();
  assert.deepEqual(await defaultOffHost.ensureCached(lockedList, false), []);
  assert.equal(installs, 0);

  const host = new HostExtensions(store, { remoteInstalls: true, cache, now: () => now, log: () => {} });
  await host.load();
  assert.deepEqual(await host.ensureCached(lockedList, true), []);
  assert.equal(installs, 1);
  assert.deepEqual(await host.ensureCached(lockedList, true), [], "backed off for 10 minutes");
  assert.equal(installs, 1);

  shouldFail = false;
  now += MANAGED_RETRY_MS + 1000;
  const cached = await host.ensureCached(lockedList, true);
  assert.equal(installs, 2);
  assert.equal(cached.length, 1);
  assert.equal(cached[0]!.summary.source, pkgSource);
  assert.deepEqual(host.report().installed.filter(item => item.source === pkgSource), [], "auto-cached packages stay out of ExtensionStore");

  const b = sessionBinding("plane-test");
  const config = {
    installed: (): readonly InstalledExtension[] => [],
    loaded: () => host.loaded,
    peekCached: (items: readonly WorkspaceExtension[], auto?: boolean) => host.peekCached(items, auto),
    workspace: async () => ({ extensions: lockedList, automaticTools: false, autoCache: true as const }),
  };

  const sandboxedView = await extensionView({
    binding: b,
    config: { workspace: config.workspace, installed: config.loaded, peekCached: config.peekCached },
    sandboxed: true,
    builtins: () => undefined,
    hostConfig: async () => defaultHostConfig,
    requiredExtensions: async () => [],
    toolNames: () => ["read"],
    definedToolsOff: off => off,
    browserUnavailable: () => undefined,
    tunnelUnavailable: () => undefined,
    missingPrograms: () => [],
  });
  assert.deepEqual(sandboxedView.extensions?.running.map(item => [item.source, item.tools]), [[pkgSource, ["cached_echo"]]]);
  assert.deepEqual(sandboxedView.extensions?.missing, []);

  const onHostView = await extensionView({
    binding: b,
    config: { workspace: config.workspace, installed: config.loaded, peekCached: config.peekCached },
    sandboxed: false,
    builtins: () => undefined,
    hostConfig: async () => defaultHostConfig,
    requiredExtensions: async () => [],
    toolNames: () => ["read"],
    definedToolsOff: off => off,
    browserUnavailable: () => undefined,
    tunnelUnavailable: () => undefined,
    missingPrograms: () => [],
  });
  assert.deepEqual(onHostView.extensions?.running, []);
  assert.deepEqual(onHostView.extensions?.missing, [pkgSource], "an on-host session on the same machine does not run auto-cached packages");

  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  const extHost: ExtensionHost = {
    directory: worktree,
    model: () => undefined,
    state: async () => ({ active: true, settings: {} }),
    runTool: async (_call, execute) => execute(new AbortController().signal),
    hookTimeoutMs: 5000,
    warn: (_source, message) => assert.fail(message),
  };
  const sessionExt = new SessionExtensions(extHost, ["read"]);
  try {
    await sessionExt.ensure(cached);
    const { selected } = sessionExt.select([pkgSource]);
    assert.equal(selected.length, 1);
    assert.deepEqual(selected[0]!.tools.map(tool => tool.name), ["cached_echo"]);
    const screened = await sessionExt.input([pkgSource], "block-me", [], "rpc");
    assert.deepEqual(screened, { action: "refused", by: pkgSource });
    const allowed = await sessionExt.input([pkgSource], "ordinary prompt", [], "rpc");
    assert.equal(allowed.action, "continue");
    const prompts = await sessionExt.beforeAgentStart("ordinary prompt", undefined);
    assert.match(prompts[pkgSource] ?? "", /cached @acme\/sandbox-ext@1\.0\.0/);
  } finally {
    await sessionExt.shutdown();
  }
});

test("installer command isolates user and global npmrc, and registryOnlyProxy allows only public registry.npmjs.org", async t => {
  const cmd = installShellCommand("/opt/pikibun/node/bin", "pkg", "@acme/ext@1.0.0");
  for (const required of [
    "npm_config_userconfig=/dev/null",
    "NPM_CONFIG_USERCONFIG=/dev/null",
    "npm_config_globalconfig=/dev/null",
    "NPM_CONFIG_GLOBALCONFIG=/dev/null",
    "npm_config_allow_git=none",
    "NPM_CONFIG_ALLOW_GIT=none",
    "--ignore-scripts",
    "--registry=https://registry.npmjs.org",
  ]) {
    assert.ok(cmd.includes(required), required);
  }

  const echo = createServer(socket => { socket.end(); });
  await new Promise<void>(resolvePromise => echo.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => new Promise<void>(resolvePromise => { echo.close(() => resolvePromise()); }));

  let dnsAddress = "104.16.1.1";
  const connected: string[] = [];
  const socketPath = egressSocketPath("planes-proxy-test", await tempDir(t));
  const proxy = registryOnlyProxy(socketPath, undefined, {
    lookup: async () => [{ address: dnsAddress, family: 4 }],
    connect: (_port, address) => {
      connected.push(address);
      return netConnect({ port: (echo.address() as AddressInfo).port, host: "127.0.0.1" });
    },
  });
  await proxy.start();
  t.after(() => proxy.close());

  const tunnelStatus = (target: string) => new Promise<number>((resolvePromise, reject) => {
    const client = netConnect(proxy.socketPath, () => {
      client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let head = "";
    client.setEncoding("utf8");
    client.on("data", chunk => {
      head += chunk;
      const lineEnd = head.indexOf("\r\n");
      if (lineEnd > 0) {
        const code = Number.parseInt(head.slice(0, lineEnd).split(" ")[1] ?? "0", 10);
        client.destroy();
        resolvePromise(code);
      }
    });
    client.on("error", reject);
  });

  assert.equal(await tunnelStatus("registry.npmjs.org:443"), 200);
  assert.deepEqual(connected, ["104.16.1.1"]);

  assert.equal(await tunnelStatus("registry.yarnpkg.com:443"), 403, "packageRegistries is false so other registries are refused");
  assert.equal(await tunnelStatus("evil.example:443"), 403);
  assert.equal(await tunnelStatus("127.0.0.1:8080"), 403);

  dnsAddress = "10.0.0.5";
  assert.equal(await tunnelStatus("registry.npmjs.org:443"), 403, "non-public DNS answers for registry.npmjs.org are refused");
  dnsAddress = "100.64.0.5";
  assert.equal(await tunnelStatus("registry.npmjs.org:443"), 403, "CGNAT / tailnet DNS answers are refused");
  assert.deepEqual(connected, ["104.16.1.1"]);
});
