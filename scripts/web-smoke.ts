/**
 * Runs the web client (apps/nsh built for the web, as the server ships it) in a real headless Chrome against a test-mode
 * server on this machine: signed out, signed in with the browser's own session cookie, Settings and Back, Back between
 * typed addresses, a settings page opened from its address, and signing out. Fails on any page error, any
 * Content-Security-Policy violation and any console error but the expected 401 of a signed-out page and the 404 of the
 * made-up sessions whose addresses it types. Native Shell's headless engine can't catch these: it is not a browser, and
 * it has APIs the web runtime lacks. Uses the Chrome or Chromium CHROME_BIN names, or the first on PATH, over the
 * DevTools protocol (Node's own WebSocket; no browser library). `pnpm test:client-web` tests NSH; `pnpm test:web`
 * tests the restored production React client with its stricter policy.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { loadConfig } from "../apps/server/src/config.ts";
import { startServer } from "../apps/server/src/serve.ts";
import { buildWeb } from "./nsh.mjs";

const TIMEOUT_MS = 20_000;
const react = process.argv.includes("--react");

function findChrome(): string {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  throw new Error("No Chrome or Chromium found: install one, or set CHROME_BIN.");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise(done => server.close(done));
  return port;
}

/** A page of a headless Chrome, over the DevTools protocol. */
class Page {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  /** What went wrong on the page: errors, refused resources, console errors. */
  readonly problems: string[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter?.resolve(message.result);
        return;
      }
      const { method, params } = message;
      if (method === "Runtime.exceptionThrown") {
        this.problems.push(`page error: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        this.problems.push(`console error: ${params.args.map((arg: any) => arg.value ?? arg.description).join(" ")}`);
      } else if (method === "Log.entryAdded" && params.entry.level === "error") {
        const { text, url } = params.entry;
        // A signed-out page asks /api/me and is told 401: that is how it learns it is signed out.
        const signedOut = /status of 401/.test(text) && /\/api\/me$/.test(url ?? "");
        // The sessions the address test types don't exist: the page asks for them and is told 404, and says so.
        const madeUp = /status of 404/.test(text) && /\/api\/sessions\/smoke-(first|second)(\/|$)/.test(url ?? "");
        if (!signedOut && !madeUp) this.problems.push(`${params.entry.source}: ${text} ${url ?? ""}`.trim());
      }
    });
  }

  static async open(socketUrl: string): Promise<Page> {
    const socket = new WebSocket(socketUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
    const page = new Page(socket);
    await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map(method => page.send(method)));
    return page;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value as T;
  }

  text(): Promise<string> {
    return this.evaluate<string>("document.body.innerText");
  }

  async goto(url: string) {
    await this.send("Page.navigate", { url });
  }

  async waitForText(wanted: string) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await this.text().catch(() => "")).includes(wanted)) return;
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error(`"${wanted}" never showed. The page says:\n${await this.text().catch(() => "")}\n${this.problems.join("\n")}`);
  }

  /**
   * Clicks, as a person would, the last element on screen labelled `label`, or saying it besides an icon (a dialog's
   * button comes after the page's). Pages the navigation keeps beside the visible one don't count: the browser's own hit
   * test must land on the element, so a page still sliding in is waited for.
   */
  async click(label: string) {
    const deadline = Date.now() + TIMEOUT_MS;
    let point = await this.onScreen(label);
    while (!point && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 200));
      point = await this.onScreen(label);
    }
    if (!point) throw new Error(`Nothing on screen to click says "${label}". The page says:\n${await this.text()}\n${this.problems.join("\n")}`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
  }

  private onScreen(label: string) {
    return this.evaluate<{ x: number; y: number } | null>(`(() => {
      const label = ${JSON.stringify(label)};
      const says = element => element.getAttribute("aria-label") === label
        || element.textContent.replace(/[^\\p{L}\\p{N}?' ]/gu, "").trim() === label;
      const points = [...document.querySelectorAll("#app *, #root *")].filter(says).map(element => {
        const rect = element.getBoundingClientRect();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const hit = rect.width > 0 && document.elementFromPoint(point.x, point.y);
        return hit && (element.contains(hit) || hit.contains(element)) ? point : null;
      }).filter(Boolean);
      return points.at(-1) ?? null;
    })()`);
  }

  close() {
    this.socket.close();
  }
}

async function launchChrome(profile: string): Promise<{ chrome: ChildProcess; page: Page }> {
  const chrome = spawn(findChrome(), [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--window-size=1280,800", ...(process.env.CI ? ["--no-sandbox"] : []), "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const browserSocket = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${output}`)), TIMEOUT_MS);
    chrome.once("error", reject);
    chrome.once("exit", code => reject(new Error(`Chrome exited with ${code}:\n${output}`)));
    chrome.stderr!.on("data", chunk => {
      output += chunk;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (found) { clearTimeout(timer); resolve(found[1]!); }
    });
  });
  const targets = await (await fetch(`http://${new URL(browserSocket).host}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const target = targets.find(item => item.type === "page");
  if (!target) throw new Error("Chrome opened no page.");
  return { chrome, page: await Page.open(target.webSocketDebuggerUrl) };
}

const work = await mkdtemp(join(tmpdir(), "pikibun-web-smoke-"));
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString("base64url");
const cleanups: (() => unknown)[] = [];
let failed = false;
try {
  console.log("Building the client for the web…");
  if (react) {
    const { build } = await import("vite");
    await build({ configFile: resolve("apps/web/vite.config.ts"), build: { outDir: join(work, "web") } });
  } else await buildWeb(join(work, "web"));
  const config = await loadConfig({
    APP_ORIGIN: origin, HOST: "127.0.0.1", PORT: String(port), DATABASE_URL: `sqlite://${join(work, "pikibun.sqlite")}`,
    SESSION_SECRET: randomBytes(32).toString("base64url"), VAULT_KEY: randomBytes(32).toString("base64url"),
    TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: secret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
    STATIC_DIR: join(work, "web"), STATIC_CLIENT: react ? "web" : "nsh",
    GITHUB_CLIENT_ID: "web-smoke-client", GITHUB_CLIENT_SECRET: "web-smoke-secret",
  });
  const server = await startServer(config);
  cleanups.push(() => server.close());

  const { chrome, page } = await launchChrome(join(work, "chrome"));
  // Chrome writes its profile until it has exited, so it must be gone before the profile is removed.
  cleanups.unshift(async () => {
    page.close();
    if (chrome.exitCode !== null || chrome.signalCode !== null) return;
    const exited = new Promise(done => chrome.once("exit", done));
    chrome.kill();
    await Promise.race([exited, new Promise(done => setTimeout(done, 5000))]);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  });

  await page.goto(`${origin}/`);
  await page.waitForText("Continue with GitHub");
  console.log("✓ signed out, the page offers sign-in");

  // A browser sign-in: the server's session cookie, as GitHub's callback would set it.
  const login = await fetch(`${origin}/api/auth/test`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "web-smoke", displayName: "Ada Lovelace" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!login.ok || !cookie) throw new Error(`test sign-in failed: ${login.status} ${await login.text()}`);
  const [name, ...value] = cookie.split("=");
  await page.send("Network.setCookie", { name, value: value.join("="), url: origin });
  if (react) {
    const { csrfToken } = await (await fetch(`${origin}/api/auth/csrf`, { headers: { Cookie: cookie } })).json() as { csrfToken: string };
    const workspace = await fetch(`${origin}/api/workspaces`, { method: "POST", headers: {
      Cookie: cookie, Origin: origin, "X-CSRF-Token": csrfToken, "Content-Type": "application/json",
    }, body: JSON.stringify({ name: "Browser smoke" }) });
    if (!workspace.ok) throw new Error(`creating the smoke workspace failed (${workspace.status})`);
  }

  await page.goto(`${origin}/`);
  await page.waitForText(react ? "What should we work on?" : "No sessions yet");
  console.log("✓ signed in with the browser's session, the session list shows");

  if (!react) {
    // Settings opened in the app and left with Back: the address follows each page, and Back stays back. The address was
    // once set on the entry of the page underneath before Native Shell pushed its own, so Back reopened Settings.
    const waitForAddress = async (wanted: string) => {
      const deadline = Date.now() + TIMEOUT_MS;
      let hash = "";
      while (Date.now() < deadline) {
        hash = await page.evaluate<string>("location.hash");
        if (hash === wanted) return;
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error(`The address is ${hash}, not ${wanted}.`);
    };
    await page.click("Settings");
    await page.click("Appearance");
    await page.waitForText("System follows");
    await waitForAddress("#/settings/appearance");
    // As a person would, once Settings has slid in: Native Shell lets a press go while its button still moves under it.
    await new Promise(done => setTimeout(done, 600));
    await page.click("Back");
    await waitForAddress("#/");
    await new Promise(done => setTimeout(done, 1000));
    if ((await page.text()).includes("System follows") || await page.evaluate<string>("location.hash") !== "#/") {
      throw new Error("Back from Settings came back to Settings.");
    }
    console.log("✓ settings opened in the app follow the address, and Back leaves them");

    // Two sessions' addresses typed one after the other, then the browser's Back: it goes to the first. Wide windows show
    // a session beside the list, without a page of its own, and Back between two once did nothing. (A session the server
    // doesn't have opens all the same, saying so.)
    await page.evaluate("location.hash = '#/s/smoke-first'");
    await waitForAddress("#/s/smoke-first");
    await page.evaluate("location.hash = '#/s/smoke-second'");
    await waitForAddress("#/s/smoke-second");
    await page.evaluate("history.back()");
    await waitForAddress("#/s/smoke-first");
    await new Promise(done => setTimeout(done, 1000));
    if (await page.evaluate<string>("location.hash") !== "#/s/smoke-first") throw new Error("Back from a typed session address didn't stay on the one before.");
    console.log("✓ Back goes to the session address typed before");
  }

  // An address the page is opened at goes where it points.
  await page.goto(`${origin}/#/settings/profile`);
  await page.waitForText("Ada Lovelace");
  console.log("✓ a settings address opens that section");
  if (react) {
    await page.waitForText("Sign out");
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out')?.scrollIntoView({ block: 'center' })`);
  }

  await page.click("Sign out");
  if (!react) {
    await page.waitForText("Sign out?");
    await page.click("Sign out");
  }
  await page.waitForText("Continue with GitHub");
  const after = await page.evaluate<number>("fetch('/api/me').then(response => response.status)");
  if (after !== 401) throw new Error(`the browser is still signed in after signing out (${after})`);
  console.log("✓ signing out ended the browser's session on the server");

  if (page.problems.length) throw new Error(`The page reported problems:\n${page.problems.join("\n")}`);
  console.log("✓ no page errors, policy violations or console errors");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  for (const cleanup of cleanups) await cleanup();
  // Leftovers in the temporary directory fail nothing.
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.warn(`Could not remove ${work}: ${error}`));
}
process.exit(failed ? 1 : 0);
