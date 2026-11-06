import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { apiRule, apiRules, graphqlWrites, parseApiCredentialGrant, placeholderOf, restRepository, type UpstreamRequest, type UpstreamResponse } from "../apps/runner/src/api-access.js";
import { EgressProxy, egressEnvironment, parseEgressGrant, type EgressEntry } from "../apps/runner/src/egress.js";
import { InterceptionAuthority } from "../apps/runner/src/interception-ca.js";
import { API_TOKEN_PLACEHOLDER, apiWriteLease, apiWriteToken, credentialedApiHosts, type ApiAccessKind, type ApiCredentialGrant, type EgressApi, type EgressGrant,
  type NetworkPolicy } from "../packages/shared/src/network.js";

const authority = new InterceptionAuthority(credentialedApiHosts);
const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" } as const;
const credentials: ApiCredentialGrant = { available: true, cacheSeconds: 60, credentials: [
  { account: "acme", authorization: "Bearer ghs_acme", repositories: ["acme/app"], expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  { account: "tools", authorization: "Bearer ghs_tools", repositories: ["tools/cli"], expiresAt: new Date(Date.now() + 3600_000).toISOString() },
] };

interface Answer { status: number; headers?: Record<string, string>; body?: string }
async function proxy(t: TestContext, options: { policy?: Partial<NetworkPolicy>; apis?: boolean | EgressApi[];
  credential?: (host: string, access: ApiAccessKind) => Promise<unknown>; answer?: (request: UpstreamRequest) => Answer } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "api-"));
  const upstream: UpstreamRequest[] = [];
  const asked: string[] = [];
  const instance = new EgressProxy({
    socketPath: join(directory, "proxy.sock"),
    grant: async (): Promise<EgressGrant> => ({ policy: { mode: "off", domains: [], packageRegistries: false, ...options.policy }, repositories: [repository],
      ...(options.apis === false ? {} : { apis: Array.isArray(options.apis) ? options.apis : [{ host: "api.github.com", provider: "github" }] }) }),
    relay: async () => new Response("unused"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: () => { throw new Error("A credentialed API is never tunnelled"); },
    apiCredential: async (host, access) => { asked.push(access === "write" ? `${host} (write)` : host); return options.credential ? options.credential(host, access) : credentials; },
    apiAuthority: authority,
    apiUpstream: async (request): Promise<UpstreamResponse> => {
      upstream.push(request);
      const answer = options.answer?.(request) ?? { status: 200, headers: { "content-type": "application/json" }, body: "{\"ok\":true}" };
      return { status: answer.status, headers: answer.headers ?? {}, body: Readable.from([Buffer.from(answer.body ?? "")]) };
    },
  });
  await instance.start();
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  const log = () => instance.entries().filter((entry: EgressEntry) => entry.kind === "api");
  return { instance, upstream, asked, log, socketPath: instance.socketPath };
}

/** A CONNECT through the proxy's socket, then TLS that trusts only the proxy's authority, as a sandboxed client does. */
function connect(socketPath: string, host = "api.github.com"): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method: "CONNECT", path: `${host}:443` });
    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) return reject(new Error(`CONNECT ${response.statusCode}`));
      const secure = tlsConnect({ socket, servername: host, ca: authority.certificate, ALPNProtocols: ["h2", "http/1.1"] }, () => resolve(secure));
      secure.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

async function call(socketPath: string, path: string, init: { method?: string; headers?: Record<string, string | undefined>; body?: string; host?: string } = {})
  : Promise<{ status: number; headers: IncomingHttpHeaders; body: string; protocol: string | false }> {
  const host = init.host ?? "api.github.com";
  const socket = await connect(socketPath, host);
  const headers = Object.fromEntries(Object.entries({ host, authorization: `token ${API_TOKEN_PLACEHOLDER}`, "user-agent": "GitHub CLI 2.80.0", ...init.headers })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  return new Promise((resolve, reject) => {
    const request = httpRequest({ createConnection: () => socket, method: init.method ?? "GET", path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => { resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8"), protocol: socket.alpnProtocol ?? false }); socket.destroy(); });
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

test("the proxy's authority vouches only for the credentialed API hosts, for strict clients too", async t => {
  const ca = new X509Certificate(authority.certificate);
  assert.equal(ca.ca, true);
  const leaf = authority.issue("api.github.com");
  const certificate = new X509Certificate(leaf.certificate);
  assert.ok(certificate.verify(ca.publicKey));
  assert.equal(certificate.checkHost("api.github.com"), "api.github.com");
  assert.equal(certificate.checkHost("github.com"), undefined);
  assert.equal(certificate.ca, false);
  assert.throws(() => authority.context("example.com"), /doesn't answer for example\.com/);

  // OpenSSL's strict checks (as Python 3.13 applies them) accept it, and the name constraint refuses any other host
  // even with a certificate the authority itself signed.
  const openssl = spawnSync("openssl", ["version"]).status === 0;
  if (!openssl) return t.diagnostic("openssl is not installed: strict verification not checked");
  const directory = await mkdtemp(join(tmpdir(), "ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "ca.pem"), authority.certificate);
  await writeFile(join(directory, "leaf.pem"), leaf.certificate);
  await writeFile(join(directory, "other.pem"), authority.issue("evil.example").certificate);
  const verify = (file: string) => spawnSync("openssl", ["verify", "-x509_strict", "-CAfile", join(directory, "ca.pem"), join(directory, file)], { encoding: "utf8" });
  assert.equal(verify("leaf.pem").status, 0, verify("leaf.pem").stderr);
  const other = verify("other.pem");
  assert.notEqual(other.status, 0);
  assert.match(`${other.stdout}${other.stderr}`, /permitted subtree violation/);
});

test("sandboxed commands get a placeholder token for each forge's API, never a real one", () => {
  const environment = egressEnvironment();
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "AZURE_DEVOPS_EXT_PAT"]) assert.equal(environment[name], API_TOKEN_PLACEHOLDER, name);
});

test("GitHub API reads get the session's read-only token at the proxy, whatever the network policy", async t => {
  const { socketPath, upstream, asked, log } = await proxy(t);
  const answer = await call(socketPath, "/repos/acme/app/actions/runs/40860931084?per_page=1");
  assert.equal(answer.status, 200);
  assert.equal(answer.body, "{\"ok\":true}");
  // HTTP/1.1 even for a client that offers h2, such as gh.
  assert.equal(answer.protocol, "http/1.1");
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0]!.url.href, "https://api.github.com/repos/acme/app/actions/runs/40860931084?per_page=1");
  assert.equal(upstream[0]!.method, "GET");
  assert.equal(upstream[0]!.headers.authorization, "Bearer ghs_acme");
  assert.equal(upstream[0]!.headers.host, "api.github.com");
  assert.equal(upstream[0]!.headers["user-agent"], "GitHub CLI 2.80.0");
  assert.doesNotMatch(JSON.stringify(upstream[0]!.headers), new RegExp(API_TOKEN_PLACEHOLDER));
  assert.deepEqual(asked, ["api.github.com"]);
  assert.deepEqual(log().map(entry => [entry.target, entry.outcome, entry.reason]),
    [["GET api.github.com/repos/acme/app/actions/runs/40860931084", "allowed", "read-only token for acme (200)"]]);

  // Another installation's repository gets its own token, and the credential is reused for a minute.
  await call(socketPath, "/repos/Tools/CLI/pulls");
  assert.equal(upstream[1]!.headers.authorization, "Bearer ghs_tools");
  assert.deepEqual(asked, ["api.github.com"]);
});

test("writes are refused at the proxy and never reach GitHub", async t => {
  const { socketPath, upstream, log } = await proxy(t, { policy: { mode: "open" } });
  for (const [method, path] of [["POST", "/repos/acme/app/issues/1/comments"], ["PATCH", "/repos/acme/app/pulls/2"], ["DELETE", "/repos/acme/app/git/refs/heads/main"],
    ["PUT", "/repos/acme/app/pulls/2/merge"]] as const) {
    const answer = await call(socketPath, path, { method, body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(answer.status, 403, `${method} ${path}`);
    assert.match(JSON.parse(answer.body).message, /only read through the GitHub API.*github_comment/);
  }
  const mutation = await call(socketPath, "/graphql", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "# merge it\nmutation Merge($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }", variables: { id: "x" } }) });
  assert.equal(mutation.status, 403);
  assert.match(JSON.parse(mutation.body).message, /^GraphQL mutations: /);
  assert.equal(upstream.length, 0);
  assert.equal(log().every(entry => entry.outcome === "refused"), true);
});

test("GraphQL queries are read with the token of the owner they name", async t => {
  const { socketPath, upstream } = await proxy(t);
  const query = "query PullRequest($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { pullRequest(number: 1) { title } } }";
  const body = JSON.stringify({ query, variables: { owner: "tools", repo: "cli" } });
  const answer = await call(socketPath, "/graphql", { method: "POST", body, headers: { "content-type": "application/json" } });
  assert.equal(answer.status, 200);
  assert.equal(upstream[0]!.headers.authorization, "Bearer ghs_tools");
  assert.equal(Buffer.from(upstream[0]!.body!).toString("utf8"), body);
  // A query naming no owner gets the first installation's.
  await call(socketPath, "/graphql", { method: "POST", body: JSON.stringify({ query: "{ viewer { login } }" }), headers: { "content-type": "application/json" } });
  assert.equal(upstream[1]!.headers.authorization, "Bearer ghs_acme");
  assert.equal((await call(socketPath, "/graphql", { method: "POST", body: "not json" })).status, 400);
});

test("other repositories, and requests carrying their own credential, follow the network policy", async t => {
  const closed = await proxy(t);
  const other = await call(closed.socketPath, "/repos/someone/else/issues");
  assert.equal(other.status, 403);
  assert.match(JSON.parse(other.body).message, /someone\/else is not one of this workspace's repositories/);
  const own = await call(closed.socketPath, "/repos/acme/app", { headers: { authorization: "token ghp_their_own" } });
  assert.equal(own.status, 403);
  assert.match(JSON.parse(own.body).message, /carries its own credential/);
  assert.equal(closed.upstream.length, 0);

  const open = await proxy(t, { policy: { mode: "allowlist", domains: ["api.github.com"] } });
  await call(open.socketPath, "/repos/someone/else/issues");
  assert.equal(open.upstream[0]!.headers.authorization, undefined, "other repositories are read without a credential");
  await call(open.socketPath, "/repos/acme/app", { headers: { authorization: "token ghp_their_own" } });
  assert.equal(open.upstream[1]!.headers.authorization, "token ghp_their_own");
  assert.deepEqual(open.log().map(entry => entry.reason), ["without a credential (200)", "the command's own credential (200)"]);
});

test("without a credential from Pikibun, the proxy says why", async t => {
  const reason = "Reading the GitHub API from sessions needs a GitHub App";
  const { socketPath, upstream } = await proxy(t, { credential: async () => ({ available: false, reason, cacheSeconds: 60 }) });
  const answer = await call(socketPath, "/repos/acme/app/actions/runs");
  assert.equal(answer.status, 403);
  assert.match(JSON.parse(answer.body).message, new RegExp(`^${reason}; api\\.github\\.com is reachable only with that credential`));
  assert.equal(upstream.length, 0);

  // An unreachable control plane is the same, briefly cached.
  const failing = await proxy(t, { credential: async () => { throw new Error("offline"); } });
  assert.equal((await call(failing.socketPath, "/repos/acme/app")).status, 403);
});

test("downloads GitHub redirects to its storage are fetched by the proxy without the credential; other redirects pass", async t => {
  const { socketPath, upstream } = await proxy(t, { answer: (request): Answer => {
    if (request.url.pathname.endsWith("/logs")) return { status: 302, headers: { location: "https://results-receiver.actions.githubusercontent.com/logs/1?sig=abc" } };
    if (request.url.pathname.endsWith("/elsewhere")) return { status: 302, headers: { location: "https://evil.example/collect" } };
    if (request.url.pathname.endsWith("/artifacts/7/zip")) return { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/a/start" } };
    // A storage host's own relative redirect is relative to it, not to api.github.com.
    if (request.url.pathname === "/a/start") return { status: 302, headers: { location: "/a/blob?sig=1" } };
    if (request.url.hostname !== "api.github.com") return { status: 200, headers: { "content-type": "text/plain" }, body: "2026-10-29T11:09:42Z Unable to resolve \"./types.js\"" };
    return { status: 200 };
  } });
  const logs = await call(socketPath, "/repos/acme/app/actions/jobs/123405325811/logs");
  assert.equal(logs.status, 200);
  assert.match(logs.body, /Unable to resolve/);
  assert.equal(upstream[1]!.url.href, "https://results-receiver.actions.githubusercontent.com/logs/1?sig=abc");
  assert.equal(upstream[1]!.headers.authorization, undefined);
  const elsewhere = await call(socketPath, "/repos/acme/app/elsewhere");
  assert.equal(elsewhere.status, 302);
  assert.equal(elsewhere.headers.location, "https://evil.example/collect");
  assert.equal(upstream.length, 3);

  const artifact = await call(socketPath, "/repos/acme/app/actions/artifacts/7/zip");
  assert.equal(artifact.status, 200);
  assert.deepEqual(upstream.slice(3).map(request => request.url.href), ["https://api.github.com/repos/acme/app/actions/artifacts/7/zip",
    "https://pipelines.actions.githubusercontent.com/a/start", "https://pipelines.actions.githubusercontent.com/a/blob?sig=1"]);
  assert.equal(upstream[5]!.headers.authorization, undefined);
});

test("without the API in its grant (a pinned session, an older control plane), the placeholder never reaches GitHub", async t => {
  const closed = await proxy(t, { apis: false });
  const refused = await call(closed.socketPath, "/repos/acme/app/releases/latest");
  assert.equal(refused.status, 403);
  assert.match(JSON.parse(refused.body).message, /^Pikibun gives this session no credential for the GitHub API/);
  assert.deepEqual(closed.asked, [], "no credential is asked for");
  assert.equal(closed.upstream.length, 0);

  // Where the policy allows api.github.com, requests go on as they did through a tunnel, without the placeholder.
  const open = await proxy(t, { apis: false, policy: { mode: "open" } });
  assert.equal((await call(open.socketPath, "/repos/acme/app/releases/latest")).status, 200);
  assert.equal(open.upstream[0]!.headers.authorization, undefined);
  assert.deepEqual(open.asked, []);
});

test("grants keep only the credentialed APIs this connector knows; credentials parse strictly", () => {
  const policy = { mode: "off", domains: [], packageRegistries: false };
  assert.deepEqual(parseEgressGrant({ policy, repositories: [], apis: [{ host: "api.github.com", provider: "github" }, { host: "management.azure.com", provider: "azure" },
    { host: "gitlab.com", provider: "gitlab" }, { host: "dev.azure.com", provider: "github" }] }).apis,
    [{ host: "api.github.com", provider: "github" }, { host: "gitlab.com", provider: "gitlab" }], "a host keeps only its own provider");
  assert.equal(parseEgressGrant({ policy, repositories: [] }).apis, undefined);
  assert.throws(() => parseEgressGrant({ policy, repositories: [], apis: "api.github.com" }), /Invalid APIs/);
  assert.deepEqual(parseApiCredentialGrant(credentials), credentials);
  assert.throws(() => parseApiCredentialGrant({ ...credentials, credentials: [{ ...credentials.credentials[0], authorization: "Bearer a\nb" }] }), /Invalid API credential/);
  assert.throws(() => parseApiCredentialGrant({ available: true, cacheSeconds: 60, credentials: [] }), /Invalid API credential/);
});

test("the rules: reads and GraphQL queries read, anything else writes; which paths are each API's", () => {
  const github = apiRules["api.github.com"]!;
  assert.equal(apiRule(github, "GET", "/repos/a/b"), "read");
  assert.equal(apiRule(github, "HEAD", "/"), "read");
  assert.equal(apiRule(github, "POST", "/graphql"), "graphql");
  assert.equal(apiRule(github, "POST", "/repos/a/b/issues"), "write");
  assert.equal(apiRule(github, "PUT", "/graphql"), "write");
  const gitlab = apiRules["gitlab.com"]!;
  assert.equal(apiRule(gitlab, "POST", "/api/graphql"), "graphql");
  assert.equal(gitlab.api("/api/v4/projects"), true);
  assert.equal(gitlab.api("/group/project/-/merge_requests"), false, "gitlab.com's website is not its API");
  assert.deepEqual(apiRules["dev.azure.com"]!.scope("/Contoso/App/_apis/git/repositories"), { account: "contoso" });
  assert.deepEqual(github.scope("/repos/acme/app/pulls"), { repository: "acme/app" });
  assert.equal(graphqlWrites("query { viewer { login } }"), false);
  assert.equal(graphqlWrites("{ repository(owner: \"a\", name: \"mutation\") { id } }"), false);
  assert.equal(graphqlWrites("# mutation in a comment\nquery { viewer { login } }"), false);
  assert.equal(graphqlWrites("mutation { addComment(input: {}) { clientMutationId } }"), true);
  assert.equal(graphqlWrites("query A { viewer { login } }\nmutation B { x }"), true);
  assert.equal(graphqlWrites("  subscription S { x }"), true);
  assert.equal(graphqlWrites(",mutation{x}"), true);
  assert.equal(graphqlWrites("query{a},mutation{b}"), true);
  assert.equal(graphqlWrites("query Q($id: ID!) { node(id: $id) { ... on Issue { mutationCount } } }"), false);
  assert.equal(restRepository("/repos/acme/app/actions/runs"), "acme/app");
  assert.equal(restRepository("/repos/acme"), undefined);
  assert.equal(restRepository("/user"), undefined);
});


test("placeholders are found where each tool sends its token: Bearer and token, Basic (az devops), PRIVATE-TOKEN (glab)", () => {
  const lease = "L".repeat(43);
  assert.deepEqual(placeholderOf({ authorization: `token ${API_TOKEN_PLACEHOLDER}` }), { placeholder: true, own: false });
  assert.deepEqual(placeholderOf({ authorization: `Bearer ${apiWriteToken(lease)}` }), { placeholder: true, lease, own: false });
  assert.deepEqual(placeholderOf({ authorization: `Basic ${Buffer.from(`:${apiWriteToken(lease)}`).toString("base64")}` }), { placeholder: true, lease, own: false });
  assert.deepEqual(placeholderOf({ "private-token": API_TOKEN_PLACEHOLDER }), { placeholder: true, own: false });
  assert.deepEqual(placeholderOf({ authorization: "token ghp_their_own" }), { placeholder: false, own: true });
  assert.deepEqual(placeholderOf({ "private-token": "glpat-their-own" }), { placeholder: false, own: true });
  assert.deepEqual(placeholderOf({}), { placeholder: false, own: false });
  assert.equal(apiWriteLease(apiWriteToken(lease)), lease);
  assert.equal(apiWriteLease(`${API_TOKEN_PLACEHOLDER}.write.short`), undefined);
});

const owners: ApiCredentialGrant = { available: true, cacheSeconds: 60, credentials: [
  { account: "session-owner", authorization: "Bearer gho_owner", repositories: ["acme/app"], expiresAt: new Date(Date.now() + 3600_000).toISOString() },
] };

test("an approved call's write lease writes as the session owner, and only while it holds", async t => {
  const { instance, socketPath, upstream, asked, log } = await proxy(t, { credential: async (_host, access) => access === "write" ? owners : credentials });
  const lease = instance.apiLease()!;
  const comment = await call(socketPath, "/repos/acme/app/issues/1/comments", { method: "POST", body: "{\"body\":\"hi\"}",
    headers: { "content-type": "application/json", authorization: `token ${lease.token}` } });
  assert.equal(comment.status, 200);
  assert.equal(upstream[0]!.method, "POST");
  assert.equal(upstream[0]!.headers.authorization, "Bearer gho_owner");
  assert.equal(Buffer.from(upstream[0]!.body!).toString("utf8"), "{\"body\":\"hi\"}", "the body goes on as it was");
  assert.doesNotMatch(JSON.stringify(upstream[0]!.headers), new RegExp(API_TOKEN_PLACEHOLDER));
  // Its reads and mutations go as the owner too, and the owner's credential is still only for the workspace's repositories.
  const mutation = await call(socketPath, "/graphql", { method: "POST", headers: { "content-type": "application/json", authorization: `bearer ${lease.token}` },
    body: JSON.stringify({ query: "mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }" }) });
  assert.equal(mutation.status, 200);
  assert.equal(upstream[1]!.headers.authorization, "Bearer gho_owner");
  const elsewhere = await call(socketPath, "/repos/someone/else/issues", { method: "POST", body: "{}", headers: { authorization: `token ${lease.token}` } });
  assert.equal(elsewhere.status, 403);
  assert.deepEqual(asked, ["api.github.com", "api.github.com (write)"]);
  assert.match(log()[0]!.reason!, /^the session owner's token for session-owner \(200\)$/);

  // Released, its token is the plain placeholder's: writes are refused again.
  lease.release();
  const after = await call(socketPath, "/repos/acme/app/issues/1/comments", { method: "POST", body: "{}", headers: { authorization: `token ${lease.token}` } });
  assert.equal(after.status, 403);
  assert.match(JSON.parse(after.body).message, /or the gh tool \(piki:gh\), approved, on the session owner's own host$/);
  // A lease never handed out is no lease.
  const forged = await call(socketPath, "/repos/acme/app/issues/1/comments", { method: "POST", body: "{}", headers: { authorization: `token ${apiWriteToken("F".repeat(43))}` } });
  assert.equal(forged.status, 403);
  assert.equal(upstream.length, 2);
});

test("a write lease on a host that doesn't get the owner's credential reads as before, and its writes say why", async t => {
  const reason = "Writes through the API act as the session owner, so Pikibun allows them only on the session owner's own hosts";
  const { instance, socketPath, upstream } = await proxy(t, { credential: async (_host, access) => access === "write" ? { available: false, reason, cacheSeconds: 60 } : credentials });
  const lease = instance.apiLease()!;
  t.after(() => lease.release());
  const read = await call(socketPath, "/repos/acme/app/pulls/2", { headers: { authorization: `token ${lease.token}` } });
  assert.equal(read.status, 200);
  assert.equal(upstream[0]!.headers.authorization, "Bearer ghs_acme");
  const write = await call(socketPath, "/repos/acme/app/pulls/2/merge", { method: "PUT", body: "{}", headers: { authorization: `token ${lease.token}` } });
  assert.equal(write.status, 403);
  assert.match(JSON.parse(write.body).message, new RegExp(`^${reason}; PUT /repos/acme/app/pulls/2/merge didn't reach GitHub$`));
  assert.equal(upstream.length, 1);
});

test("gitlab.com: glab's requests get the owner's token, its website goes on as a tunnel would", async t => {
  const gitlab: ApiCredentialGrant = { available: true, cacheSeconds: 60, credentials: [
    { account: "gitlab.com", authorization: "Bearer glpat-owner", repositories: [], expiresAt: new Date(Date.now() + 3600_000).toISOString() }] };
  const closed = await proxy(t, { apis: [{ host: "gitlab.com", provider: "gitlab" }], credential: async () => gitlab });
  const project = await call(closed.socketPath, "/api/v4/projects/group%2Fproject/pipelines", { host: "gitlab.com", headers: { authorization: undefined, "private-token": API_TOKEN_PLACEHOLDER } });
  assert.equal(project.status, 200);
  assert.equal(closed.upstream[0]!.headers.authorization, "Bearer glpat-owner");
  assert.equal(closed.upstream[0]!.headers["private-token"], undefined);
  assert.deepEqual(closed.asked, ["gitlab.com"]);
  const note = await call(closed.socketPath, "/api/v4/projects/1/merge_requests/2/notes", { host: "gitlab.com", method: "POST", body: "{}", headers: { authorization: undefined, "private-token": API_TOKEN_PLACEHOLDER } });
  assert.equal(note.status, 403);
  assert.match(JSON.parse(note.body).message, /only read through the GitLab API; it writes only with the glab tool \(piki:glab\)/);
  // The website, and the API without the placeholder, aren't Pikibun's to answer: only where the policy allows gitlab.com.
  const page = await call(closed.socketPath, "/group/project/-/raw/main/README.md", { host: "gitlab.com", headers: { authorization: undefined } });
  assert.equal(page.status, 403);
  assert.match(JSON.parse(page.body).message, /network policy doesn't allow gitlab\.com/);
  const open = await proxy(t, { apis: [{ host: "gitlab.com", provider: "gitlab" }], credential: async () => gitlab, policy: { mode: "open" } });
  const form = await call(open.socketPath, "/users/sign_in", { host: "gitlab.com", method: "POST", body: "a=b", headers: { authorization: undefined } });
  assert.equal(form.status, 200);
  assert.equal(open.upstream[0]!.headers.authorization, undefined);
  assert.equal(Buffer.from(open.upstream[0]!.body!).toString("utf8"), "a=b");
  assert.deepEqual(open.asked, [], "no credential is asked for what isn't the API");
});

test("dev.azure.com: az devops's Basic placeholder gets the owner's token for the organization the request names", async t => {
  const azure: ApiCredentialGrant = { available: true, cacheSeconds: 60, credentials: [
    { account: "fabrikam", authorization: "Basic ZmFicmlrYW0=", repositories: [], expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    { account: "contoso", authorization: "Basic Y29udG9zbw==", repositories: [], expiresAt: new Date(Date.now() + 3600_000).toISOString() }] };
  const { socketPath, upstream } = await proxy(t, { apis: [{ host: "dev.azure.com", provider: "azure-devops" }], credential: async () => azure });
  const basic = `Basic ${Buffer.from(`:${API_TOKEN_PLACEHOLDER}`).toString("base64")}`;
  const answer = await call(socketPath, "/Contoso/App/_apis/git/pullrequests?api-version=7.1", { host: "dev.azure.com", headers: { authorization: basic } });
  assert.equal(answer.status, 200);
  assert.equal(upstream[0]!.headers.authorization, "Basic Y29udG9zbw==");
  const create = await call(socketPath, "/contoso/App/_apis/git/repositories/r/pullrequests", { host: "dev.azure.com", method: "POST", body: "{}", headers: { authorization: basic } });
  assert.equal(create.status, 403);
  assert.match(JSON.parse(create.body).message, /the az tool \(piki:azure-cli\)/);
  // An organization the session owner has no token for gets none, not another organization's (review of #158).
  const other = await call(socketPath, "/elsewhere/_apis/projects", { host: "dev.azure.com", headers: { authorization: basic } });
  assert.equal(other.status, 403);
  assert.match(JSON.parse(other.body).message, /^elsewhere is not an organization of this workspace's repositories/);
  assert.equal(upstream.length, 1);
});

test("GraphQL mutations count wherever they stand, commas and all: none reaches GitLab without a lease (review of #158)", async t => {
  const gitlab: ApiCredentialGrant = { available: true, cacheSeconds: 60, credentials: [
    { account: "gitlab.com", authorization: "Bearer glpat-owner", repositories: [], expiresAt: new Date(Date.now() + 3600_000).toISOString() }] };
  const { socketPath, upstream } = await proxy(t, { apis: [{ host: "gitlab.com", provider: "gitlab" }], credential: async () => gitlab });
  for (const query of [",mutation{destroyIssue(input:{id:1}){errors}}", "query{a},mutation{b}", "\ufeffmutation{b}", "fragment F on Issue{id} mutation{b}",
    "query{a}\n,\n,mutation M{b}", "{a} subscription{b}", "query{a} \"unclosed", "{a}}mutation{b}"]) {
    const answer = await call(socketPath, "/api/graphql", { host: "gitlab.com", method: "POST", body: JSON.stringify({ query }),
      headers: { authorization: `Bearer ${API_TOKEN_PLACEHOLDER}`, "content-type": "application/json" } });
    assert.equal(answer.status, 403, query);
  }
  assert.equal(upstream.length, 0);
  const read = await call(socketPath, "/api/graphql", { host: "gitlab.com", method: "POST", body: JSON.stringify({ query: "query{project(fullPath:\"a/mutation\"){mutation: id}}" }),
    headers: { authorization: `Bearer ${API_TOKEN_PLACEHOLDER}`, "content-type": "application/json" } });
  assert.equal(read.status, 200, "a field or string named mutation is still a read");
});

test("the API's upstream takes public addresses and a local proxy's fake-IP ones, never the host's networks", async () => {
  const { upstreamAddresses } = await import("../apps/runner/src/api-access.js");
  const answer = (...addresses: string[]) => async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
  assert.deepEqual(await upstreamAddresses("api.github.com", answer("140.82.112.6")), [{ address: "140.82.112.6", family: 4 }]);
  // Clash, sing-box and Surge answer from 198.18.0.0/15 for the names they route, and pass the connection on.
  assert.deepEqual(await upstreamAddresses("api.github.com", answer("198.18.0.1")), [{ address: "198.18.0.1", family: 4 }]);
  assert.deepEqual(await upstreamAddresses("gitlab.com", answer("::ffff:198.19.255.254")), [{ address: "::ffff:198.19.255.254", family: 6 }]);
  // Just past the benchmarking network is the internet again.
  assert.equal((await upstreamAddresses("api.github.com", answer("198.20.0.1"))).length, 1);
  for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"]) {
    await assert.rejects(upstreamAddresses("api.github.com", answer(address)), /does not resolve to a public address \(it resolves to/);
  }
  // A name that resolves to both is refused whole, and an address given as the host is never a fake-IP one.
  await assert.rejects(upstreamAddresses("api.github.com", answer("198.18.0.1", "10.0.0.1")), /resolves to 10\.0\.0\.1 on this host/);
  // The error names the address it refused, not the first one.
  await assert.rejects(upstreamAddresses("api.github.com", answer("140.82.112.6", "192.168.1.1")), /resolves to 192\.168\.1\.1 on this host/);
  await assert.rejects(upstreamAddresses("198.18.0.1"), /public address/);
  await assert.rejects(upstreamAddresses("api.github.com", async () => { throw new Error("ENOTFOUND"); }), /does not resolve to a public address$/);
});
