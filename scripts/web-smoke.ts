import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { loadConfig } from "../apps/server/src/config.ts";
import { startServer } from "../apps/server/src/serve.ts";
import { buildWeb } from "./nsh.mjs";

const TIMEOUT_MS = 20_000;

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

class Page {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, ((params: any) => void)[]>();
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
      for (const listener of this.listeners.get(method) ?? []) listener(params);
      if (method === "Runtime.exceptionThrown") {
        this.problems.push(`page error: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        this.problems.push(`console error: ${params.args.map((arg: any) => arg.value ?? arg.description).join(" ")}`);
      } else if (method === "Log.entryAdded" && params.entry.level === "error") {
        const { text, url } = params.entry;
        const signedOut = /status of 401/.test(text) && /\/api\/me$/.test(url ?? "");
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

  on(method: string, listener: (params: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  async type(label: string, text: string) {
    await this.click(label);
    await this.send("Input.insertText", { text });
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

  async clickUntil(label: string, wanted: string, options: { scroll?: boolean } = {}) {
    for (let attempt = 1; ; attempt++) {
      await this.click(label, options);
      try {
        await this.waitForText(wanted, attempt < 4 ? 3_000 : TIMEOUT_MS);
        return;
      } catch (error) {
        if (attempt >= 4) throw error;
      }
    }
  }

  async waitForText(wanted: string, timeout = TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await this.text().catch(() => "")).includes(wanted)) return;
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error(`"${wanted}" never showed. The page says:\n${await this.text().catch(() => "")}\n${this.problems.join("\n")}`);
  }

  async click(label: string, options: { scroll?: boolean } = {}) {
    const deadline = Date.now() + TIMEOUT_MS;
    let point = await this.onScreen(label);
    while (!point && Date.now() < deadline) {
      if (options.scroll) await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 400 });
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

const work = resolve(await mkdtemp(join(tmpdir(), "pikibun-web-smoke-")));
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString("base64url");
const cleanups: (() => unknown)[] = [];
let failed = false;
try {
  console.log("Building the client for the web…");
  await buildWeb(join(work, "web"));
  const serve = async (serverPort: number, name: string, extra: Record<string, string> = {}) => {
    const started = await startServer(await loadConfig({
      APP_ORIGIN: `http://127.0.0.1:${serverPort}`, HOST: "127.0.0.1", PORT: String(serverPort), DATABASE_URL: `sqlite://${join(work, `${name}.sqlite`)}`,
      SESSION_SECRET: randomBytes(32).toString("base64url"), VAULT_KEY: randomBytes(32).toString("base64url"),
      TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: secret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
      STATIC_DIR: join(work, "web"),
      GITHUB_CLIENT_ID: "web-smoke-client", GITHUB_CLIENT_SECRET: "web-smoke-secret",
      ...extra,
    }));
    cleanups.push(() => started.close());
  };
  await serve(port, "pikibun");

  const { chrome, page } = await launchChrome(join(work, "chrome"));
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

  const login = await fetch(`${origin}/api/auth/test`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "web-smoke", displayName: "Ada Lovelace" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!login.ok || !cookie) throw new Error(`test sign-in failed: ${login.status} ${await login.text()}`);
  const [name, ...value] = cookie.split("=");
  await page.send("Network.setCookie", { name, value: value.join("="), url: origin });

  await page.goto(`${origin}/`);
  await page.waitForText("What should we work on?");
  console.log("✓ signed in with the browser's session, the session list shows");

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
  await page.waitForText("Appearance");
  await new Promise(done => setTimeout(done, 600));
  await page.clickUntil("Appearance", "System follows");
  await waitForAddress("#/settings/appearance");
  await new Promise(done => setTimeout(done, 600));
  await page.click("Back");
  await waitForAddress("#/");
  await new Promise(done => setTimeout(done, 1000));
  if ((await page.text()).includes("System follows") || await page.evaluate<string>("location.hash") !== "#/") {
    throw new Error("Back from Settings came back to Settings.");
  }
  console.log("✓ settings opened in the app follow the address, and Back leaves them");

  await page.evaluate("location.hash = '#/s/smoke-first'");
  await waitForAddress("#/s/smoke-first");
  await page.evaluate("location.hash = '#/s/smoke-second'");
  await waitForAddress("#/s/smoke-second");
  await page.evaluate("history.back()");
  await waitForAddress("#/s/smoke-first");
  await new Promise(done => setTimeout(done, 1000));
  if (await page.evaluate<string>("location.hash") !== "#/s/smoke-first") throw new Error("Back from a typed session address didn't stay on the one before.");
  console.log("✓ Back goes to the session address typed before");

  await page.goto(`${origin}/#/settings/profile`);
  await page.waitForText("Ada Lovelace");
  console.log("✓ a settings address opens that section");
  await page.waitForText("Sign out");
  await page.evaluate(`[...document.querySelectorAll('#app [aria-label="Sign out"]')].at(-1)?.scrollIntoView({ block: 'center' })`);

  await page.clickUntil("Sign out", "Sign out?", { scroll: true });
  await page.click("Sign out");
  await page.waitForText("Continue with GitHub");
  const after = await page.evaluate<number>("fetch('/api/me').then(response => response.status)");
  if (after !== 401) throw new Error(`the browser is still signed in after signing out (${after})`);
  console.log("✓ signing out ended the browser's session on the server");

  const passwordPort = await freePort();
  await serve(passwordPort, "passwords", { PASSWORD_AUTH: "true", SIGNUP: "open" });
  await page.goto(`http://127.0.0.1:${passwordPort}/#/`);
  await page.click("New here? Create an account");
  await page.type("Username", "smoke-tester");
  await page.type("Password", "correct horse battery staple");
  await page.type("Confirm password", "correct horse battery staple");
  await page.click("Create account");
  await page.waitForText("What should we work on?");
  console.log("✓ a new account made with a password, signed in, starts a session in its private workspace");

  const file = join(work, "notes.txt");
  const image = join(work, "pixel.png");
  await writeFile(file, "hello from the smoke test\n");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64"));
  let picking = file;
  await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
  page.on("Page.fileChooserOpened", ({ backendNodeId }) => void page.send("DOM.setFileInputFiles", { files: [picking], backendNodeId }));
  await page.click("Attach files");
  await page.waitForText("notes.txt");
  picking = image;
  await page.click("Attach files");
  const deadline = Date.now() + TIMEOUT_MS;
  while (!await page.evaluate<boolean>(`Boolean(document.querySelector('[aria-label="Remove image 1"]'))`)) {
    if (Date.now() > deadline) throw new Error(`The picked image never showed. The page says:\n${await page.text()}`);
    await new Promise(done => setTimeout(done, 200));
  }
  console.log("✓ a file and an image picked in the browser's own chooser are attached to the first message");

  await page.evaluate("location.hash = '#/settings/notifications'");
  await page.waitForText("This browser shows notifications even when no Pikibun tab is open.");
  const worker = await page.evaluate<{ status: number; type: string; text: string }>(
    "fetch('/sw.js').then(async response => ({ status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() }))");
  if (worker.status !== 200 || !worker.type.includes("javascript") || !worker.text.includes("pikibun-open")) {
    throw new Error(`The service worker isn't served: ${worker.status} ${worker.type}`);
  }
  console.log("✓ notifications on this device can be turned on, and the service worker that shows pushes is served");

  if (page.problems.length) throw new Error(`The page reported problems:\n${page.problems.join("\n")}`);
  console.log("✓ no page errors, policy violations or console errors");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  for (const cleanup of cleanups) await cleanup();
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.warn(`Could not remove ${work}: ${error}`));
}
process.exit(failed ? 1 : 0);
