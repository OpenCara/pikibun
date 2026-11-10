import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserRequest, browserShellCommand, browserTarget } from "../apps/runner/src/browser-command.js";
import { browserAt, downloadedBrowsers, hostBrowser, sandboxBrowserMount, SANDBOX_BROWSER_DIRECTORY, SANDBOX_BROWSER_DRIVER } from "../apps/runner/src/browser-toolchain.js";
import { BROWSER_DRIVER } from "../apps/runner/src/sandbox-python.generated.js";
import { validateOperation } from "../apps/runner/src/protocol.js";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { Sandbox } from "../apps/runner/src/sandbox.js";
import { BROWSER_KEPT, BROWSER_OUTPUT, parseBrowserReport } from "../packages/shared/src/browser.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import { linuxSandboxMissing } from "./helpers/workspaces.js";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Browser", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "",
      tools: ["browser"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Faux", provider: "faux", modelId: "faux-1" },
  };
}

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

test("the browser tool takes a page, actions and a server to serve, and refuses what it can't run before any card", () => {
  assert.deepEqual(browserRequest({ url: "http://localhost:5173/", actions: [{ action: "click", selector: "text=Sign in" },
    { action: "type", selector: "#email", text: "a@example.com", submit: true }, { action: "wait", ms: 500 }, { action: "screenshot", full_page: true }],
  serve: { program: "pnpm", args: ["dev", "--port", "5173"], port: 5173, directory: "./app/" }, viewport: { width: 390, height: 844 } }), {
    url: "http://localhost:5173/",
    actions: [{ action: "click", selector: "text=Sign in" }, { action: "type", selector: "#email", text: "a@example.com", submit: true },
      { action: "wait", ms: 500 }, { action: "screenshot", full_page: true }],
    viewport: { width: 390, height: 844 },
    serve: { program: "pnpm", args: ["dev", "--port", "5173"], directory: "app", port: 5173 },
  });
  assert.deepEqual(browserRequest({ serve: { program: "python3", args: ["-m", "http.server", "8000"], directory: "site", venv: ".venv", port: 8000 } }).serve,
    { program: "python3", args: ["-m", "http.server", "8000"], directory: "site", venv: ".venv", port: 8000 });
  assert.deepEqual(browserRequest({}), {});
  assert.deepEqual(browserRequest({ url: "file:///work/app/dist/index.html", actions: [{ action: "click", x: 10, y: 20 }, { action: "back" }] }).actions,
    [{ action: "click", x: 10, y: 20 }, { action: "back" }]);
  const refused: [Record<string, unknown>, RegExp][] = [
    [{ url: "javascript:alert(1)" }, /http, https or file URL/],
    [{ url: "chrome://settings" }, /http, https or file URL/],
    [{ url: "localhost:3000" }, /http, https or file URL|whole URL/],
    [{ url: "" }, /non-empty text/],
    [{ actions: [{ action: "tap", selector: "a" }] }, /action is one of/],
    [{ actions: [{ action: "click" }] }, /needs a selector, or x and y/],
    [{ actions: [{ action: "click", selector: "a", x: 1, y: 2 }] }, /not both/],
    [{ actions: [{ action: "type", selector: "#q" }] }, /needs text/],
    [{ actions: [{ action: "goto", url: "ftp://example.com" }] }, /http, https or file URL/],
    [{ actions: [{ action: "press", key: "Hyper" }] }, /a single character/],
    [{ actions: [{ action: "wait", selector: "a", ms: 10 }] }, /one of selector, text or ms/],
    [{ actions: [{ action: "wait", ms: 600_000 }] }, /from 0 to 60000/],
    [{ actions: [{ action: "evaluate", expression: "1", selector: "a" }] }, /evaluate takes expression, not selector/],
    [{ actions: Array.from({ length: 51 }, () => ({ action: "reload" })) }, /at most 50/],
    [{ serve: { program: "pnpm", args: ["dev"], port: 5173, directory: "../elsewhere" } }, /serve: directory is a path within the session's worktree/],
    [{ serve: { program: "pnpm", args: ["dev"] } }, /serve.port/],
    [{ serve: { command: "pnpm dev", port: 80 } }, /serve is \{program/],
    [{ serve: { program: "bash", args: ["-c", "pnpm dev"], port: 80 } }, /serve.program is one of the node and python tools' programs/],
    [{ serve: { program: "npm", args: ["publish"], port: 80 } }, /serve: npm publish acts on a package registry as an account/],
    [{ serve: { program: "pnpm", args: ["dev"], venv: ".venv", port: 80 } }, /serve.venv is a virtual environment, for Python's programs/],
    [{ viewport: { width: 50, height: 800 } }, /viewport.width/],
    [{ timeout_seconds: 0 }, /timeout_seconds/],
    [{ headless: false }, /not headless/],
  ];
  for (const [input, error] of refused) assert.throws(() => browserRequest(input), error, JSON.stringify(input));
});

test("the browser tool's command runs the driver with the host's Chromium and the call as JSON, quoted, in the worktree", () => {
  const browser = { driver: "/opt/pikibun/browser/pikibun-browser", chromium: "/opt/pikibun/chromium/chrome" };
  const request = browserRequest({ url: "https://example.com/it's", actions: [{ action: "click", selector: "text=More" }] });
  assert.equal(browserShellCommand(request, browser, { seconds: 600 }),
    "'/opt/pikibun/browser/pikibun-browser' '--chrome' '/opt/pikibun/chromium/chrome' '--time-limit' '600' "
    + "'{\"url\":\"https://example.com/it'\\''s\",\"actions\":[{\"action\":\"click\",\"selector\":\"text=More\"}]}' </dev/null 2>&1");
  assert.equal(browserShellCommand(browserRequest({ serve: { program: "pnpm", args: ["dev"], port: 3000 } }), browser, { seconds: 30, nodeBin: "/opt/pikibun/node/bin" }),
    "'/opt/pikibun/browser/pikibun-browser' '--chrome' '/opt/pikibun/chromium/chrome' '--time-limit' '30' '--node-bin' '/opt/pikibun/node/bin' "
    + "'{\"serve\":{\"program\":\"pnpm\",\"args\":[\"dev\"],\"port\":3000}}' </dev/null 2>&1");
  assert.doesNotMatch(browserShellCommand(browserRequest({ serve: { program: "python3", args: ["-m", "http.server"], port: 8000 } }), browser,
    { seconds: 30, nodeBin: "/opt/pikibun/node/bin" }), /--node-bin/);
  assert.doesNotThrow(() => validateOperation({ kind: "bash", command: browserShellCommand(request, browser, { seconds: 30 }) }));
  assert.throws(() => browserShellCommand(browserRequest({ actions: Array.from({ length: 3 }, () => ({ action: "evaluate", expression: "x".repeat(3000) })) }), browser, { seconds: 30 }),
    /over 8192 characters/);
  assert.equal(browserTarget(request), "https://example.com/it's → click");
  assert.equal(browserTarget(browserRequest({ serve: { program: "pnpm", args: ["dev"], port: 3000 } })), "(the last page) → serve: pnpm dev");
});

test("a browser report is taken only as far as it has the expected shape: the worktree is the agent's to change", () => {
  const report = parseBrowserReport(JSON.stringify({
    time: "2026-11-04T20:11:52Z", url: "http://localhost:8765/", title: "Test", status: 200, text: "Hello", seconds: 1.5,
    screenshot: "browser-output/20261104-201152-305.png",
    actions: [{ action: "click", ok: true }, { action: "screenshot", ok: true, screenshot: "../../etc/passwd" }, { nonsense: true }],
    elements: [{ selector: "#name", tag: "input", text: "Your name", checked: false }, { tag: "a" }],
    console: [{ level: "error", text: "boom", source: "network" }, { level: 3 }],
    page_errors: ["Error: boom", 7],
    failed_requests: [{ url: "http://localhost:8765/missing.json", status: 404 }],
  }));
  assert.deepEqual(report, {
    time: "2026-11-04T20:11:52Z", url: "http://localhost:8765/", title: "Test", text: "Hello", status: 200, seconds: 1.5,
    screenshot: "browser-output/20261104-201152-305.png",
    actions: [{ action: "click", ok: true }, { action: "screenshot", ok: true }],
    elements: [{ selector: "#name", tag: "input", text: "Your name", checked: false }],
    console: [{ level: "error", text: "boom", source: "network" }],
    page_errors: ["Error: boom"],
    failed_requests: [{ url: "http://localhost:8765/missing.json", status: 404 }],
  });
  assert.equal(parseBrowserReport(JSON.stringify({ screenshot: "browser-output/../secret.png" }))?.screenshot, undefined);
  assert.deepEqual(parseBrowserReport(JSON.stringify({ request: { url: {}, full_page: "yes", viewport: { width: 390 },
    actions: [{ action: "type", text: null, selector: "#q" }, { action: "nonsense" }, "click"],
    serve: { program: "pnpm", args: ["dev", 5173], port: 5173, directory: ["app"] } } }))?.request, {
    actions: [{ action: "type", selector: "#q" }], serve: { program: "pnpm", port: 5173, args: ["dev"] },
  });
  assert.equal(parseBrowserReport("Sandbox process failed"), undefined);
  assert.equal(parseBrowserReport("[1, 2]"), undefined);
});

test("the host's Chromium: an installation, never a wrapper script, a lone binary or the user's home", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-find-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const install = async (directory: string, name: string, marker = "icudtl.dat") => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), ELF, { mode: 0o755 });
    if (marker) await writeFile(join(directory, marker), "");
    return join(directory, name);
  };
  const chrome = await install(join(root, "opt", "google", "chrome"), "chrome");
  assert.deepEqual(browserAt(chrome, { platform: "linux", home }), { executable: chrome, directory: join(root, "opt", "google", "chrome") });
  await mkdir(join(root, "bin"));
  await symlink(chrome, join(root, "bin", "google-chrome"));
  assert.equal(browserAt(join(root, "bin", "google-chrome"), { platform: "linux", home })?.executable, chrome);
  const script = join(root, "opt", "google", "chrome", "wrapper");
  await writeFile(script, "#!/bin/sh\nexec chrome \"$@\"\n", { mode: 0o755 });
  assert.equal(browserAt(script, { platform: "linux", home }), undefined);
  assert.equal(browserAt(await install(join(root, "lone"), "chrome", ""), { platform: "linux", home }), undefined);
  assert.equal(browserAt(await install(home, "chrome"), { platform: "linux", home }), undefined, "never the home, which would be mounted whole");
  await symlink(home, join(root, "linked-home"));
  assert.equal(browserAt(join(home, "chrome"), { platform: "linux", home: join(root, "linked-home") }), undefined);
  assert.equal(browserAt(join(root, "missing"), { platform: "linux", home }), undefined);
  await writeFile(join(root, "opt", "google", "chrome", "plain"), ELF, { mode: 0o644 });
  assert.equal(browserAt(join(root, "opt", "google", "chrome", "plain"), { platform: "linux", home }), undefined, "not executable");

  const cache = join(home, ".cache");
  const older = await install(join(cache, "ms-playwright", "chromium_headless_shell-1140", "chrome-linux"), "headless_shell", "headless_lib_data.pak");
  const newer = await install(join(cache, "ms-playwright", "chromium_headless_shell-1169", "chrome-headless-shell-linux64"), "chrome-headless-shell", "headless_lib_data.pak");
  const puppeteer = await install(join(cache, "puppeteer", "chrome", "linux-131.0.6778.85", "chrome-linux64"), "chrome");
  const found = downloadedBrowsers(cache);
  assert.ok(found.indexOf(newer) < found.indexOf(older) && found.includes(puppeteer));
  assert.ok(hostBrowser({ env: {}, platform: "linux", home }));
  assert.equal(hostBrowser({ env: { PIKIBUN_BROWSER: older }, platform: "linux", home })?.executable, older);
  assert.equal(hostBrowser({ env: { PIKIBUN_BROWSER: script }, platform: "linux", home }), undefined, "never another browser than the one named");
  assert.equal(hostBrowser({ env: {}, platform: "win32", home }), undefined);
  assert.equal(hostBrowser({ env: { PIKIBUN_BROWSER: chrome }, platform: "darwin", home }), undefined);
  assert.equal(browserAt(chrome, { platform: "darwin", home }), undefined);
});

test("only the session's Linux sandbox has a browser: never a session on the host itself", { skip: process.platform !== "linux" }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-where-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chrome = { executable: "/opt/google/chrome/chrome", directory: "/opt/google/chrome" };
  assert.deepEqual(new Sandbox(binding("in-opt"), join(root, "opt"), undefined, { browser: chrome }).browser,
    { driver: SANDBOX_BROWSER_DRIVER, chromium: `${SANDBOX_BROWSER_DIRECTORY}/chrome` });
  assert.deepEqual(new Sandbox(binding("in-usr"), join(root, "usr"), undefined, { browser: { executable: "/usr/lib/chromium/chromium", directory: "/usr/lib/chromium" } }).browser,
    { driver: SANDBOX_BROWSER_DRIVER, chromium: "/usr/lib/chromium/chromium" });
  assert.equal(new Sandbox(binding("none"), join(root, "none"), undefined, { browser: null }).browser, undefined);
  assert.equal((new HostWorkspace(binding("host"), join(root, "host")) as { browser?: unknown }).browser, undefined);
});

test("the Linux sandbox gives commands the Chromium installation alone, read-only, unless they see it in /usr", () => {
  assert.deepEqual(sandboxBrowserMount({ executable: "/usr/lib/chromium/chromium", directory: "/usr/lib/chromium" }), { executable: "/usr/lib/chromium/chromium" });
  assert.deepEqual(sandboxBrowserMount({ executable: "/opt/google/chrome/chrome", directory: "/opt/google/chrome" }),
    { mount: { source: "/opt/google/chrome", target: SANDBOX_BROWSER_DIRECTORY }, executable: `${SANDBOX_BROWSER_DIRECTORY}/chrome` });
  assert.equal(sandboxBrowserMount(undefined), undefined);
});

const chromium = process.env.PIKIBUN_TEST_BROWSER ? browserAt(process.env.PIKIBUN_TEST_BROWSER) : hostBrowser();
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout?.trim() ?? "";

test("the driver opens a served page, runs the actions, and leaves a screenshot and a report it prunes", { skip: (!chromium && "no Chromium on this host (PIKIBUN_TEST_BROWSER names one)") || (!python && "python3 is not installed") }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-driver-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  const home = join(root, "sessions", "0".repeat(64), "home");
  await mkdir(join(worktree, "site"), { recursive: true });
  await mkdir(join(home, ".tmp"), { recursive: true });
  await writeFile(join(worktree, "site", "index.html"), `<!doctype html><title>Test app</title><h2>Greet</h2>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hi ' + document.getElementById('name').value; console.log('submitted')">
<label>Name <input id="name" placeholder="Your name"></label><select id="color"><option value="r">Red</option><option value="g">Green</option></select>
<button type="submit">Greet</button></form><p id="out"></p><a href="/second.html">Second page</a>
<script>console.error('loaded with an error'); fetch('/missing.json')</script>`);
  await writeFile(join(worktree, "site", "second.html"), "<!doctype html><title>Second</title><p>Arrived</p>");
  await mkdir(join(worktree, BROWSER_OUTPUT));
  for (let index = 0; index < BROWSER_KEPT; index++) {
    const stamp = `20000101-0000${String(index).padStart(2, "0")}-000`;
    await writeFile(join(worktree, BROWSER_OUTPUT, `${stamp}.json`), JSON.stringify({ url: "about:blank" }));
    await writeFile(join(worktree, BROWSER_OUTPUT, `${stamp}.png`), "");
  }
  const driver = join(root, "pikibun-browser");
  await writeFile(driver, BROWSER_DRIVER);
  await chmod(driver, 0o700);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const request = browserRequest({
    serve: { program: "python3", args: ["-m", "http.server", String(port), "--bind", "127.0.0.1"], port, directory: "site" }, url: `http://127.0.0.1:${port}/`,
    actions: [{ action: "type", selector: "#name", text: "Ada" }, { action: "select", selector: "#color", value: "Green" },
      { action: "click", selector: "text=Greet" }, { action: "evaluate", expression: "document.getElementById('out').textContent" },
      { action: "screenshot" }, { action: "click", selector: "text=Second page" }, { action: "click", selector: "#missing" }, { action: "reload" }],
  });
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(python, ["-I", driver, "--chrome", chromium!.executable, "--time-limit", "90", JSON.stringify(request)],
      { cwd: worktree, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: join(home, ".tmp") } });
    let text = "";
    child.stdout.on("data", chunk => { text += chunk; });
    child.stderr.on("data", chunk => { text += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(text));
  });
  const report = parseBrowserReport(output);
  assert.ok(report, output);
  const { elements: _elements, ...said } = report;
  const detail = JSON.stringify(said, null, 1);
  assert.deepEqual(report.actions?.map(item => [item.action, item.ok]), [["type", true], ["select", true], ["click", true], ["evaluate", true], ["screenshot", true], ["click", true], ["click", false]], detail);
  assert.equal(report.title, "Second", detail);
  assert.equal(report.url, `http://127.0.0.1:${port}/second.html`, detail);
  assert.equal(report.status, 200, detail);
  assert.match(report.text ?? "", /Arrived/, detail);
  assert.equal(report.actions?.[3]?.value, "Hi Ada");
  assert.match(report.error ?? "", /action 7 \(click\) failed: no element matches #missing/);
  assert.equal(report.skipped, 1);
  assert.ok(report.console?.some(entry => entry.level === "error" && entry.text === "loaded with an error"));
  assert.ok(report.failed_requests?.some(entry => entry.status === 404 && entry.url.endsWith("/missing.json")));
  assert.match(report.serve_output ?? "", /GET \/ HTTP/);
  for (const path of [report.screenshot!, report.actions![4]!.screenshot!]) {
    assert.deepEqual((await readFile(join(worktree, path))).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"), path);
  }
  const files = await readdir(join(worktree, BROWSER_OUTPUT));
  assert.equal(files.filter(name => name.endsWith(".json")).length, BROWSER_KEPT);
  assert.ok(!files.includes("20000101-000000-000.json") && !files.includes("20000101-000000-000.png"), "the oldest call's files are gone");
  assert.deepEqual(parseBrowserReport(await readFile(join(worktree, report.report!), "utf8"))?.request, request);

  const again = await new Promise<string>(resolve => {
    const child = spawn(python, ["-I", driver, "--chrome", chromium!.executable, "--time-limit", "60", "{}"], { cwd: worktree, env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: join(home, ".tmp") } });
    let text = "";
    child.stdout.on("data", chunk => { text += chunk; });
    child.on("close", () => resolve(text));
  });
  const reopened = parseBrowserReport(again);
  assert.equal(reopened?.reopened, `http://127.0.0.1:${port}/second.html`);
  assert.match(reopened?.error ?? "", /ERR_CONNECTION_REFUSED.*only within the same call, started with serve/);
});

test("a Chromium that starts but never answers is reported with what it printed, not as a page with no title", { skip: !python && "python3 is not installed" }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-silent-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = join(root, "pikibun-browser");
  await writeFile(driver, BROWSER_DRIVER);
  await chmod(driver, 0o700);
  const silent = join(root, "chromium");
  await writeFile(silent, "#!/bin/sh\necho 'stuck before DevTools' >&2\nexec sleep 60\n");
  await chmod(silent, 0o700);
  const temporary = join(root, "tmp");
  await mkdir(temporary);
  const output = await new Promise<string>(resolve => {
    const child = spawn(python, ["-I", driver, "--chrome", silent, "--time-limit", "8", JSON.stringify({ url: "about:blank" })],
      { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: temporary } });
    let text = "";
    child.stdout.on("data", chunk => { text += chunk; });
    child.on("close", () => resolve(text));
  });
  const report = parseBrowserReport(output);
  assert.ok(report, output);
  assert.match(report.error ?? "", /^Chromium did not answer within \d+ seconds of starting: stuck before DevTools/, output);
});

test("in the Linux sandbox, the driver runs the host's Chromium, given read-only, with the session's own files", { skip: linuxSandboxMissing() ?? ((!chromium && "no Chromium on this host (PIKIBUN_TEST_BROWSER names one)") || undefined) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-sandbox-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new Sandbox(binding("browser-sandbox"), join(root, "session"), undefined, { browser: chromium! });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const authorize = async () => {};
  const run = (command: string) => sandbox.execute({ kind: "bash", command }, false, authorize, { allowTestShell: true });
  await sandbox.writeFile("site/index.html", `<!doctype html><title>Sandboxed app</title><h2>Greet</h2>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hi ' + document.getElementById('name').value">
<input id="name"><button type="submit">Greet</button></form><p id="out"></p>`, authorize);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const request = browserRequest({ serve: { program: "python3", args: ["-m", "http.server", String(port), "--bind", "127.0.0.1"], port, directory: "site" }, url: `http://127.0.0.1:${port}/`,
    actions: [{ action: "type", selector: "#name", text: "Ada" }, { action: "click", selector: "text=Greet" }, { action: "evaluate", expression: "document.getElementById('out').textContent" }] });
  const output = await run(browserShellCommand(request, sandbox.browser!, { seconds: 30, nodeBin: sandbox.nodeBin }));
  const report = parseBrowserReport(output.trim());
  assert.ok(report && !report.error, output.slice(0, 4000));
  assert.equal(report.title, "Sandboxed app");
  assert.equal(report.actions?.[2]?.value, "Hi Ada");
  const screenshot = await sandbox.readContent(report.screenshot!, authorize);
  assert.ok("image" in screenshot && screenshot.mimeType === "image/png");
  await assert.rejects(run(`touch ${SANDBOX_BROWSER_DRIVER}`));
  if (sandbox.browser!.chromium.startsWith(`${SANDBOX_BROWSER_DIRECTORY}/`)) {
    await assert.rejects(run(`touch ${SANDBOX_BROWSER_DIRECTORY}/written`));
    assert.match(await run(`ls ${SANDBOX_BROWSER_DIRECTORY}`), /icudtl\.dat|\.pak/);
    await assert.rejects(run(`ls ${chromium!.directory}`), "the host's own path to it isn't there");
  }
});

test("a stopped browser call leaves nothing running: the sandbox ends Chromium and the served app with the command", { skip: linuxSandboxMissing() ?? ((!chromium && "no Chromium on this host (PIKIBUN_TEST_BROWSER names one)") || undefined) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-stop-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new Sandbox(binding("browser-stop"), join(root, "session"), undefined, { browser: chromium! });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const authorize = async () => {};
  await sandbox.writeFile("site/index.html", "<!doctype html><title>Long</title>", authorize);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const request = browserRequest({ serve: { program: "python3", args: ["-m", "http.server", String(port), "--bind", "127.0.0.1"], port, directory: "site" },
    url: `http://127.0.0.1:${port}/`, actions: [{ action: "wait", ms: 60_000 }] });
  const ours = async () => {
    const found: string[] = [];
    for (const pid of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/.test(pid)) continue;
      const command = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").join(" ");
      if ([`http.server ${port}`, `127.0.0.1:${port}`, `${sandbox.home}/`].some(marker => command.includes(marker))) found.push(`${pid}: ${command.slice(0, 200)}`);
    }
    return found;
  };
  const controller = new AbortController();
  const running = sandbox.execute({ kind: "program", tool: "browser", command: browserShellCommand(request, sandbox.browser!, { seconds: 120 }) }, false, authorize,
    { allowTestShell: true, signal: controller.signal });
  for (let attempt = 0; attempt < 200 && !(await ours()).some(line => line.includes(`http.server ${port}`)); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok((await ours()).length, "the call started");
  controller.abort();
  await assert.rejects(running, /Command stopped/);
  let left = await ours();
  for (let attempt = 0; attempt < 50 && left.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    left = await ours();
  }
  assert.deepEqual(left, [], "nothing of the call outlives it");
});
