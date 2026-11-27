import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, connect as tcpConnect, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EgressProxy, endpointUrl, hostForgeApiEnvironment, hostForgeEnvironment, hostGitRewrites, type EgressEndpoint, type RelayRequest } from "../apps/runner/src/egress.js";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import type { SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import { defaultHostConfig, ownerOnlyHostConfig, parseHostConfigChange, readHostConfig } from "../packages/shared/src/host-config.js";
import { API_TOKEN_PLACEHOLDER, type EgressGrant, type EgressRepository } from "../packages/shared/src/network.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import { CA_BUNDLE_VARIABLES } from "../apps/runner/src/trust-store.js";
import { startGitHttpServer } from "./helpers/git-http.js";

const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const authorize: SandboxAuthorize = async () => {};
const app: EgressRepository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" };
const endpoint: EgressEndpoint = { port: 40123, token: "t".repeat(32) };

function rewrites(env: Record<string, string>): [string, string][] {
  return Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`]!, env[`GIT_CONFIG_VALUE_${index}`]!]);
}

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Host forge", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

function get(port: number, token: string, path: string): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers: { authorization: `Basic ${Buffer.from(`pikibun:${token}`).toString("base64")}` } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function tunnel(port: number, token: string, target: string): Promise<{ status: number; socket?: import("node:net").Socket }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: "CONNECT", path: target,
      headers: { "proxy-authorization": `Basic ${Buffer.from(`pikibun:${token}`).toString("base64")}` } });
    request.on("connect", (response, socket) => {
      if (response.statusCode === 200) return resolve({ status: 200, socket });
      socket.destroy();
      resolve({ status: response.statusCode! });
    });
    request.on("error", reject);
    request.end();
  });
}

async function forgeProxy(t: TestContext, options: { grant: () => Promise<EgressGrant>; relay?: (request: RelayRequest) => Promise<Response>; connect?: (port: number, host: string) => import("node:net").Socket; sessionBranch?: string }) {
  const directory = await mkdtemp(join(tmpdir(), "host-forge-"));
  const relayed: RelayRequest[] = [];
  const token = "f".repeat(32);
  const instance = new EgressProxy({
    socketPath: join(directory, "unused.sock"), tcp: { token }, unconfined: true,
    grant: options.grant,
    relay: async request => { relayed.push(request); if (options.relay) return options.relay(request); throw new Error("no relay in this test"); },
    publicFetch: async () => { throw new Error("an unconfined proxy leaves other repositories to the host"); },
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.sessionBranch ? { sessionBranch: options.sessionBranch } : {}),
  });
  await instance.start();
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  return { instance, relayed, endpoint: instance.endpoint!, token };
}

test("host commands rewrite only the workspace's repositories to the proxy, in each remote form a forge has", () => {
  const lab: EgressRepository = { bindingId: "binding-lab", provider: "gitlab", host: "gitlab.com", fullName: "group/sub/tool" };
  const azure: EgressRepository = { bindingId: "binding-az", provider: "azure-devops", host: "dev.azure.com", fullName: "org/My Project/repo" };
  const plain: EgressRepository = { bindingId: "binding-git", provider: "git", host: "git.example.org", fullName: "team/repo.git" };
  const base = `${endpointUrl(endpoint)}/git/`;
  assert.deepEqual(hostGitRewrites([app, lab, azure, plain], endpoint), [
    ["https://github.com/acme/app", `${base}github.com/acme/app`],
    ["git@github.com:acme/app", `${base}github.com/acme/app`],
    ["ssh://git@github.com/acme/app", `${base}github.com/acme/app`],
    ["https://gitlab.com/group/sub/tool", `${base}gitlab.com/group/sub/tool`],
    ["git@gitlab.com:group/sub/tool", `${base}gitlab.com/group/sub/tool`],
    ["ssh://git@gitlab.com/group/sub/tool", `${base}gitlab.com/group/sub/tool`],
    ["https://dev.azure.com/org/My%20Project/_git/repo", `${base}dev.azure.com/org/My%20Project/_git/repo`],
    ["https://git.example.org/team/repo", `${base}git.example.org/team/repo`],
  ]);
  const env = hostForgeEnvironment([app], endpoint, "pikibun/s1");
  assert.deepEqual(rewrites(env).map(([key, value]) => [key.replace(base, "<proxy>/"), value]), [
    ["url.<proxy>/github.com/acme/app.insteadOf", "https://github.com/acme/app"],
    ["url.<proxy>/github.com/acme/app.insteadOf", "git@github.com:acme/app"],
    ["url.<proxy>/github.com/acme/app.insteadOf", "ssh://git@github.com/acme/app"],
  ]);
  assert.equal(env.PIKIBUN_SESSION_BRANCH, "pikibun/s1");
  assert.equal(env.PIKIBUN_EGRESS_STATUS, `${endpointUrl(endpoint)}/__pikibun/status`);
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "GH_TOKEN", "GITHUB_TOKEN", "SSL_CERT_FILE"]) assert.equal(env[name], undefined, `${name} stays the host's for other commands`);
  assert.equal(hostForgeEnvironment([], endpoint).GIT_CONFIG_COUNT, "0");
});

test("the CLI tools reach the forge through the proxy, with placeholder tokens and the session's certificates", () => {
  const env = hostForgeApiEnvironment(endpoint, "/session/forge-ca.pem", "corp.example, localhost");
  assert.equal(env.HTTPS_PROXY, endpointUrl(endpoint));
  assert.equal(env.HTTP_PROXY, undefined, "plain HTTP stays on the host's own network");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,corp.example", "the host's own exceptions are kept");
  assert.equal(env.https_proxy, endpointUrl(endpoint));
  for (const name of CA_BUNDLE_VARIABLES) assert.equal(env[name], "/session/forge-ca.pem");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "AZURE_DEVOPS_EXT_PAT"]) assert.equal(env[name], API_TOKEN_PLACEHOLDER);
});

test("an unconfined proxy leaves hosts and other repositories to the host's own network and credentials", async t => {
  const echo: Server = createTcpServer(socket => socket.pipe(socket));
  await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { echo.close(() => resolve()); }));
  const reached: string[] = [];
  const { endpoint: own, token, relayed } = await forgeProxy(t, {
    grant: async () => ({ policy: { mode: "off", domains: [], packageRegistries: false }, repositories: [app] }),
    connect: (port, host) => { reached.push(`${host}:${port}`); return tcpConnect({ port: (echo.address() as AddressInfo).port, host: "127.0.0.1" }); },
  });
  const open = await tunnel(own.port, token, "objects.githubusercontent.com:443");
  assert.equal(open.status, 200, "the workspace's network policy doesn't confine a host session");
  const reply = await new Promise<string>(resolve => { open.socket!.once("data", (chunk: Buffer) => resolve(chunk.toString())); open.socket!.write("ping"); });
  assert.equal(reply, "ping");
  open.socket!.destroy();
  assert.deepEqual(reached, ["objects.githubusercontent.com:443"], "the host resolves the name itself");
  const other443 = await tunnel(own.port, token, "registry.example.com:8443");
  assert.equal(other443.status, 200, "any port: a host session's commands weren't limited to HTTPS before");
  other443.socket!.destroy();
  const other = await get(own.port, token, "/git/github.com/acme/app-other/info/refs?service=git-upload-pack");
  assert.equal(other.status, 302, "a repository that only shares a workspace repository's prefix goes back to the forge, for the host's credentials");
  assert.equal(other.headers.location, "https://github.com/acme/app-other/info/refs?service=git-upload-pack");
  const push = await get(own.port, token, "/git/github.com/acme/app-other/info/refs?service=git-receive-pack");
  assert.equal(push.status, 302, "so is a push to it");
  assert.equal(push.headers.location, "https://github.com/acme/app-other/info/refs?service=git-receive-pack");
  assert.equal(relayed.length, 0);
  assert.equal((await get(own.port, "x".repeat(32), "/__pikibun/status")).status, 401, "other processes on the host need the session's token");
});

test("a host session's git clones and pushes the workspace's repositories through the proxy, and the session branch only", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "host-forge-git-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, "projects");
  await mkdir(join(projects, "acme"), { recursive: true });
  const work = join(directory, "upstream");
  const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };
  const git = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const bare = join(projects, "acme", "app.git");
  await mkdir(work);
  git(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "from upstream\n");
  git(["add", "README.md"], work);
  git(["commit", "-q", "-m", "initial"], work);
  git(["clone", "-q", "--bare", work, bare], directory);
  const server = await startGitHttpServer(projects);
  t.after(() => server.close());
  const paths: Record<string, string> = { "info-refs": "info/refs?service=git-upload-pack", "upload-pack": "git-upload-pack",
    "receive-refs": "info/refs?service=git-receive-pack", "receive-pack": "git-receive-pack" };
  const { instance, relayed } = await forgeProxy(t, {
    grant: async () => ({ policy: { mode: "off", domains: [], packageRegistries: false }, repositories: [app] }),
    sessionBranch: "pikibun/host-forge",
    relay: async request => fetch(`${server.url("acme/app.git")}/${paths[request.service]}`, {
      method: request.service.endsWith("refs") ? "GET" : "POST", body: request.service.endsWith("refs") ? undefined : request.body,
      headers: { ...(request.contentType ? { "content-type": request.contentType } : {}), ...(request.gitProtocol ? { "git-protocol": request.gitProtocol } : {}) },
      ...(request.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
  });
  let forge = true;
  const workspace = new HostWorkspace(binding("host-forge"), join(directory, "session"), {
    forgeEnvironment: async () => forge ? hostForgeEnvironment((await instance.grant()).repositories, instance.endpoint!, "pikibun/host-forge") : undefined,
  });
  t.after(() => workspace.close());
  await workspace.initialize();
  const shell = (command: string) => workspace.execute({ kind: "bash", command }, false, authorize);
  await shell("git clone -q https://github.com/acme/app app && cd app && echo change > change.txt && git add change.txt && git commit -q -m 'Add a change'"
    + ' && git push -q origin "HEAD:$PIKIBUN_SESSION_BRANCH"');
  assert.equal(git(["show", "refs/heads/pikibun/host-forge:change.txt"], bare), "change");
  assert.ok(relayed.some(request => request.service === "upload-pack"));
  assert.ok(relayed.some(request => request.service === "receive-pack"));
  assert.match(await shell("cd app && git config --get remote.origin.url"), /^https:\/\/github\.com\/acme\/app\n?$/, "the remote stays the forge's URL, without the proxy's token");
  await assert.rejects(shell("cd app && git push origin HEAD:main"), /Only this session's branch pikibun\/host-forge can be pushed with plain git/);
  assert.equal(git(["rev-parse", "refs/heads/main"], bare), git(["rev-parse", "main"], work));
  forge = false;
  assert.equal((await shell("echo ${GIT_CONFIG_COUNT:-none} ${PIKIBUN_SESSION_BRANCH:-none}")).trim(), "none none", "without the setting, commands keep the host's own Git");
});

test("git_push on the host: the runner pushes a clone's commit as it is, fast-forward only, without the session's Git ever holding the credential", hostMode, async t => {
  const { performClonePush, PushError } = await import("../apps/runner/src/push.js");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "host-forge-push-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, "projects");
  await mkdir(join(projects, "acme"), { recursive: true });
  const work = join(directory, "upstream");
  const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };
  const git = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const bare = join(projects, "acme", "app.git");
  await mkdir(work);
  git(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "from upstream\n");
  git(["add", "README.md"], work);
  git(["commit", "-q", "-m", "initial"], work);
  git(["clone", "-q", "--bare", work, bare], directory);
  const server = await startGitHttpServer(projects, { authorization: "Basic dXNlcjpzZWNyZXQ=" });
  t.after(() => server.close());
  const workspace = new HostWorkspace(binding("host-push"), join(directory, "session"));
  t.after(() => workspace.close());
  await workspace.initialize();
  git(["clone", "-q", bare, join(workspace.worktree, "app")], directory);
  git(["remote", "set-url", "origin", "https://github.com/acme/app.git"], join(workspace.worktree, "app"));
  await workspace.execute({ kind: "bash", command: "cd app && git switch -q -c feature && echo change > change.txt && git add change.txt && git commit -q -m 'Add a change'" }, false, authorize);
  const head = await workspace.cloneHead("app", authorize);
  assert.equal(head.origin, "https://github.com/acme/app.git");
  const operation = { kind: "git.push" as const, repository: "acme/app", directory: "app", branch: "feature", commit: head.commit };
  const credential = { remote: server.url("acme/app.git"), authorization: "Basic dXNlcjpzZWNyZXQ=" };
  const pushed = await performClonePush({ workspace, operation, credential, authorize });
  assert.equal(pushed.outcome, "pushed");
  assert.deepEqual(pushed.commits.map(commit => commit.subject), ["Add a change"]);
  assert.equal(git(["rev-parse", "refs/heads/feature"], bare), head.commit);
  assert.equal((await performClonePush({ workspace, operation, credential, authorize })).outcome, "up-to-date");
  git(["fetch", "-q", bare, "feature:feature"], work);
  git(["switch", "-q", "feature"], work);
  await writeFile(join(work, "other.txt"), "other\n");
  git(["add", "other.txt"], work);
  git(["commit", "-q", "-m", "Elsewhere"], work);
  git(["push", "-q", bare, "feature"], work);
  await workspace.execute({ kind: "bash", command: "cd app && echo more >> change.txt && git commit -q -am 'More'" }, false, authorize);
  const next = await workspace.cloneHead("app", authorize);
  await assert.rejects(performClonePush({ workspace, operation: { ...operation, commit: next.commit }, credential, authorize }),
    (error: Error) => error instanceof PushError && /fetch and merge or rebase/.test(error.message));
  await assert.rejects(workspace.cloneHead("missing", authorize), /not a Git clone/);
  await assert.rejects(workspace.cloneHead("../escape", authorize), /invalid clone directory/);
  assert.doesNotMatch(await workspace.execute({ kind: "bash", command: "cd app && git config --list --show-origin" }, false, authorize), /secret|dXNlcjpzZWNyZXQ/);
});

test("members' clone sessions on the host always use their own account; the host owner's only once they turn it on", hostMode, async t => {
  const { RunnerService } = await import("../apps/runner/src/server.js");
  const { sha256 } = await import("../packages/shared/src/crypto.js");
  const { randomUUID } = await import("node:crypto");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "host-forge-session-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let ownerForgeAccess = false;
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "host-forge-session-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    egressGrant: async () => ({ policy: { mode: "off", domains: [], packageRegistries: false }, repositories: [app] }),
    hostConfig: async () => ({ ...defaultHostConfig, ownerForgeAccess }),
  });
  await service.initialize();
  t.after(() => service.close());
  const open = async (id: string, connectorOwnerId: string) => {
    const value = binding(id);
    value.session.repositoryMode = "clone";
    value.session.connectorOwnerId = connectorOwnerId;
    value.model = { ...value.model, provider: "faux", modelId: "faux-1", connectorOwnerId };
    const now = Math.floor(Date.now() / 1000);
    const session = await service.provision(value, { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action: "create", policyVersion: 1,
      iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") });
    return async () => (await session.sandbox.execute({ kind: "bash", command: 'echo "${GIT_CONFIG_COUNT:-none} ${GIT_CONFIG_VALUE_0:-none} ${PIKIBUN_SESSION_BRANCH:-none}${HTTPS_PROXY:+ proxied}${GH_TOKEN:+ token}"' },
      false, async () => {})).trim();
  };
  const member = await open("forge-member", "test:host");
  assert.equal(await member(), "3 https://github.com/acme/app pikibun/forge-member proxied token", "a member's session on someone else's host reads as the member, in every command");
  const own = await open("forge-owner", "test:alice");
  assert.equal(await own(), "none none none", "the host owner's own session keeps the host's credentials by default");
  ownerForgeAccess = true;
  assert.match(await own(), /^3 https:\/\/github\.com\/acme\/app pikibun\/forge-owner/);
  ownerForgeAccess = false;
  assert.equal(await member(), "3 https://github.com/acme/app pikibun/forge-member proxied token", "the owner's setting is only about their own sessions");
});

test("every command trusts the session's proxy alongside the host's own certificates, and a host that has its own proxy keeps it", async t => {
  const { hostSessionCertificates, proxyConfigured, sandboxCertificates } = await import("../apps/runner/src/trust-store.js");
  const directory = await mkdtemp(join(tmpdir(), "host-forge-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const own = "-----BEGIN CERTIFICATE-----\nMIIcompany\n-----END CERTIFICATE-----";
  await writeFile(join(directory, "company.pem"), `${own}\n`);
  const bundle = await hostSessionCertificates({ SSL_CERT_FILE: join(directory, "company.pem"), NODE_EXTRA_CA_CERTS: join(directory, "missing.pem") });
  assert.ok(bundle.startsWith(sandboxCertificates()), "the host's store and the proxy's authority");
  assert.ok(bundle.includes(own), "a bundle the host's environment names stays trusted");
  assert.equal(await hostSessionCertificates({}), sandboxCertificates());
  assert.equal(proxyConfigured({ https_proxy: "http://corp:3128" }), true);
  assert.equal(proxyConfigured({ ALL_PROXY: "socks5://corp" }), true);
  assert.equal(proxyConfigured({ HTTP_PROXY: "http://corp:3128" }), false, "plain HTTP alone doesn't reach HTTPS");
});

test("the owner decides whether their own host sessions use their Pikibun account, off by default", () => {
  assert.equal(defaultHostConfig.ownerForgeAccess, false);
  assert.ok(ownerOnlyHostConfig.includes("ownerForgeAccess"));
  assert.deepEqual(parseHostConfigChange({ ownerForgeAccess: true }), { ownerForgeAccess: true });
  assert.throws(() => parseHostConfigChange({ ownerForgeAccess: "yes" }), /forge access/);
  const older = Object.fromEntries(Object.entries(defaultHostConfig).filter(([key]) => key !== "ownerForgeAccess"));
  assert.equal(readHostConfig(older).ownerForgeAccess, false, "a Pikibun server from before the setting keeps the host's own credentials");
});
