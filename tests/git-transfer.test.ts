import assert from "node:assert/strict";
import test from "node:test";
import { GitTransferError, lfsDownload, type LfsTarget } from "../packages/shared/src/git-transfer.js";

const oid = "166f2a80e5f501d5902da36c5c0bdbbbc8f083601cb59d8cb53f28f7f9617999";
const content = "coin.png, as Azure DevOps stores it";
const size = Buffer.byteLength(content);
const remote = "https://dev.azure.com/shiningpie/ShiningPie/_git/ShiningPie";
const authorization = "Basic OnBhdA==";
const objectUrl = `${remote}/info/lfs/objects/${oid}`;
const organizationHref = `https://shiningpie@dev.azure.com/shiningpie/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`;
const blobUrl = `https://vsblobprodsu6weus73.vsblob.vsassets.io/b-0123456789abcdef/${oid.toUpperCase()}?sv=2019-07-07&sr=b&se=2026-11-22T06%3A00%3A00Z&sp=r&sig=c2lnbmF0dXJl`;

type Route = (request: Request) => Response;

function azureDevOps(href: string, routes: Record<string, Route>, header?: Record<string, string>) {
  const calls: { url: string; authorization: string | null; accept: string | null; signature: string | null }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, authorization: request.headers.get("authorization"), accept: request.headers.get("accept"), signature: request.headers.get("x-signature") });
    if (request.url === `${remote}.git/info/lfs/objects/batch`) {
      return Response.json({ objects: [{ oid, size, authenticated: true, actions: { download: { href, ...(header ? { header } : {}) } } }] },
        { headers: { "Content-Type": "application/vnd.git-lfs+json" } });
    }
    return routes[request.url]?.(request) ?? new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
  const target: LfsTarget = { remote, provider: "Azure DevOps", fullName: "shiningpie/ShiningPie/ShiningPie", authorization, fetch };
  return { target, calls };
}

const azureObject: Route = request => request.headers.get("authorization") !== authorization
  ? new Response("Sign in", { status: 203, headers: { "Content-Type": "text/html" } })
  : request.headers.get("accept")?.includes("json")
    ? Response.json({ oid, size })
    : new Response(content, { headers: { "Content-Length": String(size) } });

const read = async (target: LfsTarget) => new Response(await lfsDownload(target, { oid, size })).text();
const refused = (code: string) => (error: unknown) => error instanceof GitTransferError && error.status === 502 && error.code === code;

test("an Azure DevOps download href names the organization as its user: it is fetched without it, with the credential", async () => {
  const { target, calls } = azureDevOps(organizationHref, { [objectUrl]: azureObject });
  assert.equal(await read(target), content);
  assert.deepEqual(calls.slice(1), [{ url: objectUrl, authorization, accept: "application/octet-stream", signature: null }]);
});

test("Azure DevOps sending a download on to its blob store gets the credential only on its own origin", async () => {
  const { target, calls } = azureDevOps(organizationHref, {
    [objectUrl]: request => request.headers.get("authorization") === authorization
      ? new Response(null, { status: 303, headers: { Location: blobUrl } }) : new Response("Sign in", { status: 203 }),
    [blobUrl]: request => request.headers.get("authorization") ? new Response("credential sent to the blob store", { status: 400 })
      : new Response(content, { headers: { "Content-Length": String(size) } }),
  });
  assert.equal(await read(target), content);
  assert.deepEqual(calls.slice(1).map(call => [call.url, call.authorization]), [[objectUrl, authorization], [blobUrl, null]]);
});

test("an organization on Azure DevOps' legacy visualstudio.com address gets the credential there, and no other organization does", async () => {
  const legacy = `https://shiningpie.visualstudio.com/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`;
  for (const href of [legacy, legacy.replace("https://", "https://shiningpie@")]) {
    const own = azureDevOps(href, { [legacy]: azureObject });
    assert.equal(await read(own.target), content, href);
    assert.deepEqual(own.calls.slice(1).map(call => [call.url, call.authorization]), [[legacy, authorization]], href);
  }

  for (const href of [`https://contoso.visualstudio.com/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`,
    `https://shiningpie.visualstudio.com:8443/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`,
    `https://shiningpie.visualstudio.com.example.com/info/lfs/objects/${oid}`]) {
    const other = azureDevOps(href, { [href]: azureObject });
    await assert.rejects(read(other.target), GitTransferError, href);
    assert.deepEqual(other.calls.slice(1).map(call => [call.url, call.authorization]), [[href, null]], href);
  }
});

test("Git LFS downloads still refuse credentials in URLs, users off the provider's origin, plain HTTP and endless redirects", async () => {
  for (const href of [`https://shiningpie:pat@dev.azure.com/shiningpie/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`,
    `https://:pat@dev.azure.com/shiningpie/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`,
    `https://shiningpie@media.example.com/${oid}`,
    `https://shiningpie@contoso.visualstudio.com/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`,
    `http://dev.azure.com/shiningpie/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`,
    `https://dev.azure.com:8443/shiningpie/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`.replace("https://", "https://shiningpie@"),
    `/shiningpie/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`]) {
    const { target, calls } = azureDevOps(href, {});
    await assert.rejects(read(target), refused("invalid_lfs_response"), href);
    assert.equal(calls.length, 1, href);
  }

  for (const location of [`https://shiningpie@dev.azure.com/shiningpie/ShiningPie/_git/ShiningPie/info/lfs/objects/${oid}`,
    "http://vsblobprodsu6weus73.vsblob.vsassets.io/object", "https://169.254.169.254/latest/meta-data"]) {
    const { target, calls } = azureDevOps(organizationHref, { [objectUrl]: () => new Response(null, { status: 302, headers: { Location: location } }) });
    await assert.rejects(read(target), refused("lfs_unavailable"), location);
    assert.equal(calls.length, 2, location);
  }

  const hops = ["https://hop1.example.com/", "https://hop2.example.com/", "https://hop3.example.com/", "https://hop4.example.com/"];
  const routes: Record<string, Route> = { [objectUrl]: () => new Response(null, { status: 302, headers: { Location: hops[0]! } }) };
  hops.forEach((hop, index) => { routes[hop] = () => new Response(null, { status: 302, headers: { Location: hops[index + 1] ?? objectUrl } }); });
  const looping = azureDevOps(organizationHref, routes);
  await assert.rejects(read(looping.target), refused("lfs_unavailable"));
  assert.deepEqual(looping.calls.slice(1).map(call => [call.url, call.authorization]),
    [[objectUrl, authorization], [hops[0], null], [hops[1], null], [hops[2], null]]);
});

test("only Azure DevOps downloads ask for application/octet-stream; other providers' requests are as before", async () => {
  const github = "https://github.com/acme/app.git";
  const media = `https://lfs-media.githubusercontent.com/${oid}?sig=1`;
  const accepts: (string | null)[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === `${github}/info/lfs/objects/batch`) return Response.json({ objects: [{ oid, size, actions: { download: { href: media } } }] });
    accepts.push(request.headers.get("accept"));
    return new Response(content, { headers: { "Content-Length": String(size) } });
  }) as typeof globalThis.fetch;
  assert.equal(await read({ remote: github, provider: "GitHub", fullName: "acme/app", authorization, fetch }), content);
  assert.deepEqual(accepts, [null]);
});

test("an action's own headers are kept on the provider's origin, and none of them go to another one", async () => {
  const { target, calls } = azureDevOps(organizationHref, {
    [objectUrl]: () => new Response(null, { status: 302, headers: { Location: blobUrl } }),
    [blobUrl]: () => new Response(content, { headers: { "Content-Length": String(size) } }),
  }, { "X-Signature": "signed", Authorization: "Bearer action" });
  assert.equal(await read(target), content);
  assert.deepEqual(calls.slice(1), [
    { url: objectUrl, authorization: "Bearer action", accept: "application/octet-stream", signature: "signed" },
    { url: blobUrl, authorization: null, accept: "application/octet-stream", signature: null },
  ]);
});
