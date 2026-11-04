import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserRequest, browserShellCommand, browserTarget } from "../apps/runner/src/browser-command.js";
import { browserAt, downloadedBrowsers, hostBrowser, sandboxBrowserMount, SANDBOX_BROWSER_DIRECTORY } from "../apps/runner/src/browser-toolchain.js";
import { BROWSER_DRIVER } from "../apps/runner/src/sandbox-python.generated.js";
import { validateOperation } from "../apps/runner/src/protocol.js";
import { BROWSER_KEPT, BROWSER_OUTPUT, parseBrowserReport } from "../packages/shared/src/browser.js";

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

test("the browser tool takes a page, actions and a server to serve, and refuses what it can't run before any card", () => {
  assert.deepEqual(browserRequest({ url: "http://localhost:5173/", actions: [{ action: "click", selector: "text=Sign in" },
    { action: "type", selector: "#email", text: "a@example.com", submit: true }, { action: "wait", ms: 500 }, { action: "screenshot", full_page: true }],
  serve: { command: "pnpm dev --port 5173", port: 5173, directory: "./app/" }, viewport: { width: 390, height: 844 } }), {
    url: "http://localhost:5173/",
    actions: [{ action: "click", selector: "text=Sign in" }, { action: "type", selector: "#email", text: "a@example.com", submit: true },
      { action: "wait", ms: 500 }, { action: "screenshot", full_page: true }],
    viewport: { width: 390, height: 844 },
    serve: { command: "pnpm dev --port 5173", port: 5173, directory: "app" },
  });
  // Nothing at all looks again at the page the last call left.
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
    [{ serve: { command: "pnpm dev", port: 5173, directory: "../elsewhere" } }, /within the session's worktree/],
    [{ serve: { command: "pnpm dev" } }, /serve.port/],
    [{ serve: { command: " ", port: 80 } }, /serve.command/],
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
    "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/bin' '/opt/pikibun/browser/pikibun-browser' '--chrome' '/opt/pikibun/chromium/chrome' '--time-limit' '600' "
    + "'{\"url\":\"https://example.com/it'\\''s\",\"actions\":[{\"action\":\"click\",\"selector\":\"text=More\"}]}' </dev/null 2>&1");
  // A serve command finds the connector's own Node.js first, as the node tool does.
  assert.match(browserShellCommand({ serve: { command: "pnpm dev", port: 3000 } }, browser, { seconds: 30, nodeBin: "/opt/pikibun/node/bin" }),
    /^PATH='\/opt\/pikibun\/node\/bin':"\$\{PATH:-\/usr\/bin:\/bin\}":'\/usr\/local\/bin' '\/opt\/pikibun\/browser\/pikibun-browser' '--chrome' '\/opt\/pikibun\/chromium\/chrome' '--time-limit' '30' /);
  // A host workspace's driver may be under a path with spaces.
  assert.match(browserShellCommand({}, { driver: "/Users/Jo Doe/pikibun/browser/pikibun-browser", chromium: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, { seconds: 30 }),
    / '\/Users\/Jo Doe\/pikibun\/browser\/pikibun-browser' '--chrome' '\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome' /);
  assert.doesNotThrow(() => validateOperation({ kind: "bash", command: browserShellCommand(request, browser, { seconds: 30 }) }));
  assert.throws(() => browserShellCommand(browserRequest({ actions: Array.from({ length: 3 }, () => ({ action: "evaluate", expression: "x".repeat(3000) })) }), browser, { seconds: 30 }),
    /over 8192 characters/);
  assert.equal(browserTarget(request), "https://example.com/it's → click");
  assert.equal(browserTarget(browserRequest({ serve: { command: "pnpm dev", port: 3000 } })), "(the last page) → serve: pnpm dev");
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
  // Through a link, as /usr/bin/google-chrome-stable is.
  await mkdir(join(root, "bin"));
  await symlink(chrome, join(root, "bin", "google-chrome"));
  assert.equal(browserAt(join(root, "bin", "google-chrome"), { platform: "linux", home })?.executable, chrome);
  // A wrapper script (Debian's /usr/bin/chromium), a binary without Chromium's files, the home itself: none.
  const script = join(root, "opt", "google", "chrome", "wrapper");
  await writeFile(script, "#!/bin/sh\nexec chrome \"$@\"\n", { mode: 0o755 });
  assert.equal(browserAt(script, { platform: "linux", home }), undefined);
  assert.equal(browserAt(await install(join(root, "lone"), "chrome", ""), { platform: "linux", home }), undefined);
  assert.equal(browserAt(await install(home, "chrome"), { platform: "linux", home }), undefined, "never the home, which would be mounted whole");
  assert.equal(browserAt(join(root, "missing"), { platform: "linux", home }), undefined);
  await writeFile(join(root, "opt", "google", "chrome", "plain"), ELF, { mode: 0o644 });
  assert.equal(browserAt(join(root, "opt", "google", "chrome", "plain"), { platform: "linux", home }), undefined, "not executable");

  // Downloads in the user's cache, newest first; PIKIBUN_BROWSER is that one or none.
  const cache = join(home, ".cache");
  const older = await install(join(cache, "ms-playwright", "chromium_headless_shell-1140", "chrome-linux"), "headless_shell", "headless_lib_data.pak");
  const newer = await install(join(cache, "ms-playwright", "chromium_headless_shell-1169", "chrome-headless-shell-linux64"), "chrome-headless-shell", "headless_lib_data.pak");
  const puppeteer = await install(join(cache, "puppeteer", "chrome", "linux-131.0.6778.85", "chrome-linux64"), "chrome");
  const found = downloadedBrowsers(cache);
  assert.ok(found.indexOf(newer) < found.indexOf(older) && found.includes(puppeteer));
  // A system install comes first where the host has one; the downloads otherwise.
  assert.ok(hostBrowser({ env: {}, platform: "linux", home }));
  assert.equal(hostBrowser({ env: { PIKIBUN_BROWSER: older }, platform: "linux", home })?.executable, older);
  assert.equal(hostBrowser({ env: { PIKIBUN_BROWSER: script }, platform: "linux", home }), undefined, "never another browser than the one named");
  assert.equal(hostBrowser({ env: {}, platform: "win32", home }), undefined);
});

test("the Linux sandbox gives commands the Chromium installation alone, read-only, unless they see it in /usr", () => {
  assert.deepEqual(sandboxBrowserMount({ executable: "/usr/lib/chromium/chromium", directory: "/usr/lib/chromium" }), { executable: "/usr/lib/chromium/chromium" });
  assert.deepEqual(sandboxBrowserMount({ executable: "/opt/google/chrome/chrome", directory: "/opt/google/chrome" }),
    { mount: { source: "/opt/google/chrome", target: SANDBOX_BROWSER_DIRECTORY }, executable: `${SANDBOX_BROWSER_DIRECTORY}/chrome` });
  assert.equal(sandboxBrowserMount(undefined), undefined);
});

/** A Chromium to run the driver with: PIKIBUN_TEST_BROWSER, or the host's own. */
const chromium = process.env.PIKIBUN_TEST_BROWSER ? browserAt(process.env.PIKIBUN_TEST_BROWSER) : hostBrowser();
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout?.trim() ?? "";

test("the driver opens a served page, runs the actions, and leaves a screenshot and a report it prunes", { skip: (!chromium && "no Chromium on this host (PIKIBUN_TEST_BROWSER names one)") || (!python && "python3 is not installed") }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-driver-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  const home = join(root, "home");
  await mkdir(join(worktree, "site"), { recursive: true });
  await mkdir(join(home, ".tmp"), { recursive: true });
  // A heading with the button's text: text= takes the button, which the agent can act on.
  await writeFile(join(worktree, "site", "index.html"), `<!doctype html><title>Test app</title><h2>Greet</h2>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hi ' + document.getElementById('name').value; console.log('submitted')">
<label>Name <input id="name" placeholder="Your name"></label><select id="color"><option value="r">Red</option><option value="g">Green</option></select>
<button type="submit">Greet</button></form><p id="out"></p><a href="/second.html">Second page</a>
<script>console.error('loaded with an error'); fetch('/missing.json')</script>`);
  await writeFile(join(worktree, "site", "second.html"), "<!doctype html><title>Second</title><p>Arrived</p>");
  // Older calls' files, beyond what it keeps: the oldest go once this call's are written.
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
    serve: { command: `${python} -m http.server ${port} --bind 127.0.0.1`, port, directory: "site" }, url: `http://127.0.0.1:${port}/`,
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
  assert.equal(report.title, "Second");
  assert.equal(report.url, `http://127.0.0.1:${port}/second.html`);
  assert.equal(report.status, 200);
  assert.match(report.text ?? "", /Arrived/);
  assert.deepEqual(report.actions?.map(item => [item.action, item.ok]), [["type", true], ["select", true], ["click", true], ["evaluate", true], ["screenshot", true], ["click", true], ["click", false]]);
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
  // The report file holds the call's request too, for the Browser tab.
  assert.deepEqual(parseBrowserReport(await readFile(join(worktree, report.report!), "utf8"))?.request, request);

  // Without a url, the next call opens the page this one left; a refused host's page says why.
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
