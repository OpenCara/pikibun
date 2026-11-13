import { exists, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { platform, signal, untracked } from "nsh";
import { Application } from "nsh/desktop";
import nshProcess from "process";
import { APP_VERSION } from "../app-version";
import { loginShell } from "./pikibun-command";
import { computerHosts } from "./this-computer";
import { thisServer } from "./this-server";
import {
  curlArguments, GNOME_PROXY_PROBE, gnomeProxy, PROXY_VARIABLES, SHELL_PROXY_PROBE, shellProxy, shownProxy, WINDOWS_INTERNET_SETTINGS, windowsProxy,
} from "./update-proxy";
import { LINUX_INSTALL, MAC_INSTALL, utf16le, windowsUpdateTask } from "./update-scripts";
import { lastLines as lastOf } from "./windows-cmd";
import { compareVersions, isPrerelease, isVersion } from "./version";
import { UPDATE_SIGNATURE_SUFFIX, UPDATE_SIGNING_KEY, verifyUpdateSignature } from "../../../../packages/shared/src/update-signature";

export { compareVersions, isVersion } from "./version";

const REPOSITORY = "https://github.com/OpenCara/pikibun";
export const RELEASES_API = "https://api.github.com/repos/OpenCara/pikibun/releases?per_page=30";
const USER_AGENT = "Pikibun-App";
const TAG = /^app-v(.+)$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const UPDATES_FOLDER = "updates";
const PENDING = "pending.json";
const INSTALL_LOG = "install.log";
const WINDOWS_TASK = "Pikibun update";
const PART_BYTES = 4 * 1024 * 1024;
const READ_LIMIT = 64 * 1024 * 1024;
const PROBE_MS = 15_000;
const CURL_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 250;
const PROGRESS_EVERY_MS = 100;
const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface ReleaseAsset { name: string; url: string; size: number; sha256: string; signatureUrl: string }

export interface AvailableUpdate {
  version: string;
  tag: string;
  page: string;
  asset: ReleaseAsset | null;
}

export function assetSuffix(os: string, arch: string): string | null {
  if (os === "windows" && arch === "x86_64") return "windows-x64-setup.exe";
  if (os === "macos" && arch === "aarch64") return "macos-arm64.dmg";
  if (os === "linux" && arch === "x86_64") return "linux-x86_64.tar.gz";
  return null;
}

function releaseAsset(assets: unknown, tag: string, version: string, os: string, arch: string): ReleaseAsset | null {
  const suffix = assetSuffix(os, arch);
  if (!suffix || !Array.isArray(assets)) return null;
  const name = `Pikibun-${version}-${suffix}`;
  const signature = `${name}${UPDATE_SIGNATURE_SUFFIX}`;
  const uploaded = (wanted: string) => assets.find((asset: unknown): asset is Record<string, unknown> => !!asset && typeof asset === "object"
    && (asset as Record<string, unknown>).name === wanted && ((asset as Record<string, unknown>).state === undefined || (asset as Record<string, unknown>).state === "uploaded"));
  const entry = uploaded(name);
  if (!entry || !uploaded(signature)) return null;
  const size = typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : 0;
  const sha256 = typeof entry.digest === "string" ? DIGEST.exec(entry.digest)?.[1] : undefined;
  if (!sha256) return null;
  return { name, url: `${REPOSITORY}/releases/download/${tag}/${name}`, size, sha256, signatureUrl: `${REPOSITORY}/releases/download/${tag}/${signature}` };
}

export function newerRelease(releases: unknown, current: string, os: string, arch: string): AvailableUpdate | undefined {
  if (!Array.isArray(releases) || !isVersion(current)) return undefined;
  const prereleases = isPrerelease(current);
  let best: { version: string; assets: unknown } | undefined;
  for (const release of releases) {
    if (!release || typeof release !== "object") continue;
    const { tag_name: tag, draft, prerelease, assets } = release as Record<string, unknown>;
    const version = typeof tag === "string" ? TAG.exec(tag)?.[1] : undefined;
    if (!version || !isVersion(version) || draft !== false) continue;
    if ((prerelease !== false || isPrerelease(version)) && !prereleases) continue;
    if (!best || compareVersions(version, best.version) === 1) best = { version, assets };
  }
  if (!best || compareVersions(best.version, current) !== 1) return undefined;
  const tag = `app-v${best.version}`;
  return { version: best.version, tag, page: `${REPOSITORY}/releases/tag/${tag}`, asset: releaseAsset(best.assets, tag, best.version, os, arch) };
}

export interface CleanUp { installed?: string; failed?: string }

export interface UpdateRunner {
  download(asset: ReleaseAsset, progress: (loaded: number, total: number) => void): Promise<string>;
  install(file: string, update: AvailableUpdate): Promise<void>;
  restart(): Promise<void>;
  cleanUp(current: string): Promise<CleanUp>;
}

function separator(): string { return platform.os === "windows" ? "\\" : "/"; }

export function updatesFolder(os: string, dataDir: string | null | undefined): string | null {
  if (!dataDir) return null;
  return `${dataDir.replace(/[\\/]+$/, "")}${os === "windows" ? "\\" : "/"}${UPDATES_FOLDER}`;
}

function folder(): string {
  const dir = updatesFolder(platform.os, nshProcess.dataDir);
  if (!dir) throw new Error("This app has no data folder to download the update into.");
  return dir;
}

const inFolder = (dir: string, name: string) => `${dir}${separator()}${name}`;

async function emptyFolder(dir: string, keep: readonly string[] = []): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  for (const name of names) {
    if (keep.includes(name)) continue;
    try { await unlink(inFolder(dir, name)); } catch { }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const lastLines = (text: string) => lastOf(text.split(/\r?\n/));

async function joinParts(dir: string, parts: readonly string[], name: string): Promise<void> {
  const output = platform.os === "windows"
    ? await nshProcess.run("cmd", ["/d", "/c", "copy", "/b", "/y", parts.join("+"), name], { cwd: dir, timeoutMs: 120_000 })
    : await nshProcess.run("sh", ["-c", "out=$1; shift; cat -- \"$@\" > \"$out\"", "pikibun-update", name, ...parts], { cwd: dir, timeoutMs: 120_000 });
  if (output.code !== 0) throw new Error(`The download couldn't be saved: ${lastLines(`${output.stderr}\n${output.stdout}`) || `exit code ${output.code ?? "unknown"}`}`);
  for (const part of parts) { try { await unlink(inFolder(dir, part)); } catch { } }
}

async function probe(command: string, args: string[]): Promise<string> {
  try { return (await nshProcess.run(command, args, { timeoutMs: PROBE_MS })).stdout; } catch { return ""; }
}

const ownProxyVariable = () => PROXY_VARIABLES.some(name => Boolean(nshProcess.env[name]?.trim()));

export async function updateProxy(): Promise<string | null> {
  const shell = () => probe(loginShell(platform.os, nshProcess.env.SHELL), ["-ilc", SHELL_PROXY_PROBE]);
  switch (platform.os) {
    case "windows": return ownProxyVariable() ? null : windowsProxy(await probe("cmd", ["/d", "/c", "reg", "query", WINDOWS_INTERNET_SETTINGS]));
    case "macos": return shellProxy(await shell());
    case "linux": return ownProxyVariable() ? null : shellProxy(await shell()) ?? gnomeProxy(await probe("sh", ["-c", GNOME_PROXY_PROBE]));
    default: return null;
  }
}

export class ProxyDownloadFailed extends Error {}

export async function preferProxy(proxy: string | null, through: (proxy: string) => Promise<string | null>, direct: () => Promise<string>): Promise<string> {
  if (!proxy) return direct();
  let missed: ProxyDownloadFailed | undefined;
  try {
    const file = await through(proxy);
    if (file) return file;
  } catch (error) {
    if (!(error instanceof ProxyDownloadFailed)) throw error;
    missed = error;
  }
  try {
    return await direct();
  } catch (error) {
    if (!missed) throw error;
    throw new Error(`${missed.message} Downloading it directly failed too: ${messageOf(error)}`);
  }
}

async function download(asset: ReleaseAsset, progress: (loaded: number, total: number) => void): Promise<string> {
  const dir = folder();
  const proxy = await updateProxy().catch(() => null);
  const file = await preferProxy(proxy, found => downloadThrough(found, dir, asset, progress), () => downloadInto(dir, asset, progress));
  const signature = await preferProxy(proxy, found => signatureThrough(found, dir, asset), () => signatureDirect(asset));
  try { await requireUpdateSignature(asset, signature); }
  catch (error) { try { await unlink(file); } catch { } throw error; }
  return file;
}

const SIGNATURE_LIMIT = 1024;
export const UNSIGNED = "This download isn't signed with Pikibun's release key, so it wasn't installed. Install the update from its release page, "
  + "or report it at https://github.com/OpenCara/pikibun/issues.";

export async function requireUpdateSignature(asset: Pick<ReleaseAsset, "name" | "sha256">, signature: string, publicKey = UPDATE_SIGNING_KEY): Promise<void> {
  if (signature.length > SIGNATURE_LIMIT || !await verifyUpdateSignature(asset.name, asset.sha256, signature, publicKey)) throw new Error(UNSIGNED);
}

async function signatureDirect(asset: ReleaseAsset): Promise<string> {
  const response = await fetch(asset.signatureUrl, { headers: { Accept: "application/octet-stream", "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`The update's signature couldn't be downloaded: GitHub answered ${response.status}.`);
  const text = await response.text();
  if (text.length > SIGNATURE_LIMIT) throw new Error(UNSIGNED);
  return text;
}

async function signatureThrough(proxy: string, dir: string, asset: ReleaseAsset): Promise<string | null> {
  const name = `${asset.name}${UPDATE_SIGNATURE_SUFFIX}`;
  const args = curlArguments(asset.signatureUrl, proxy, name);
  const [command, words] = platform.os === "windows"
    ? ["cmd", ["/d", "/c", "curl.exe", ...args]]
    : ["sh", ["-c", "exec curl \"$@\"", "pikibun-update", ...args]];
  let output: { code?: number | null; stdout: string; stderr: string };
  try { output = await nshProcess.run(command, words, { cwd: dir, timeoutMs: PROBE_MS * 4 }); }
  catch (error) { throw new ProxyDownloadFailed(`The update's signature didn't download through the proxy at ${shownProxy(proxy)}: ${messageOf(error)}.`); }
  if (output.code === 127 || output.code === 9009) return null;
  if (output.code !== 0) {
    throw new ProxyDownloadFailed(`The update's signature didn't download through the proxy at ${shownProxy(proxy)}: ${lastLines(`${output.stderr}\n${output.stdout}`) || `curl's exit code ${output.code ?? "unknown"}`}.`);
  }
  const path = inFolder(dir, name);
  if ((await stat(path)).size > SIGNATURE_LIMIT) throw new Error(UNSIGNED);
  const text = await readFile(path, "utf8");
  try { await unlink(path); } catch { }
  return text;
}

const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function downloadThrough(proxy: string, dir: string, asset: ReleaseAsset, progress: (loaded: number, total: number) => void): Promise<string | null> {
  await mkdir(dir, { recursive: true });
  await emptyFolder(dir);
  const partial = `${asset.name}.part`;
  const file = inFolder(dir, partial);
  const args = curlArguments(asset.url, proxy, partial);
  const [command, words] = platform.os === "windows"
    ? ["cmd", ["/d", "/c", "curl.exe", ...args]]
    : ["sh", ["-c", "exec curl \"$@\"", "pikibun-update", ...args]];
  progress(0, asset.size);
  let running = true;
  const watching = (async () => {
    while (running) {
      await later(POLL_MS);
      if (!running) break;
      try { const { size } = await stat(file); progress(asset.size ? Math.min(size, asset.size) : size, asset.size); } catch { }
    }
  })();
  let output: { code?: number | null; stdout: string; stderr: string };
  try {
    output = await nshProcess.run(command, words, { cwd: dir, timeoutMs: CURL_MS });
  } catch (error) {
    throw new ProxyDownloadFailed(`The download through the proxy at ${shownProxy(proxy)} didn't run: ${messageOf(error)}.`);
  } finally {
    running = false;
    await watching;
  }
  if (output.code === 127 || output.code === 9009) return null;
  if (output.code !== 0) {
    throw new ProxyDownloadFailed(`The download through the proxy at ${shownProxy(proxy)} failed: ${lastLines(`${output.stderr}\n${output.stdout}`) || `curl's exit code ${output.code ?? "unknown"}`}.`);
  }
  const { size } = await stat(file);
  progress(size, asset.size || size);
  if (asset.size && size !== asset.size) throw new Error(`The download stopped early (${size} of ${asset.size} bytes). Try again.`);
  if (!size) throw new Error("The download was empty.");
  if (size > READ_LIMIT) throw new Error("The download is too large for Pikibun to check: install it from its release page.");
  const bytes = await readFile(file);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    try { await unlink(file); } catch { }
    throw new Error("The download doesn't match the checksum GitHub published for it. Try again.");
  }
  const saved = inFolder(dir, asset.name);
  await rename(file, saved);
  return saved;
}

export async function downloadInto(dir: string, asset: ReleaseAsset, progress: (loaded: number, total: number) => void): Promise<string> {
  await mkdir(dir, { recursive: true });
  await emptyFolder(dir);
  const response = await fetch(asset.url, { headers: { Accept: "application/octet-stream", "User-Agent": USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`The download failed: GitHub answered ${response.status}.`);
  const total = asset.size || Number(response.headers.get("content-length") ?? 0) || 0;
  const hash = crypto.createHash("sha256");
  const reader = response.body.getReader();
  const parts: string[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let loaded = 0;
  let reported = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    const bytes = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pending) { bytes.set(chunk, offset); offset += chunk.length; }
    pending = [];
    pendingBytes = 0;
    for (let start = 0; start < bytes.length; start += PART_BYTES) {
      const name = `part-${String(parts.length).padStart(4, "0")}`;
      await writeFile(inFolder(dir, name), bytes.subarray(start, Math.min(bytes.length, start + PART_BYTES)));
      parts.push(name);
    }
  };
  progress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    hash.update(value);
    pending.push(value);
    pendingBytes += value.length;
    loaded += value.length;
    if (total && loaded > total) throw new Error("The download is larger than GitHub said it is.");
    if (pendingBytes >= PART_BYTES) await flush();
    if (Date.now() - reported >= PROGRESS_EVERY_MS) { reported = Date.now(); progress(loaded, total); }
  }
  await flush();
  progress(loaded, total);
  if (asset.size && loaded !== asset.size) throw new Error(`The download stopped early (${loaded} of ${asset.size} bytes). Try again.`);
  if (hash.digest("hex") !== asset.sha256) throw new Error("The download doesn't match the checksum GitHub published for it. Try again.");
  if (!parts.length) throw new Error("The download was empty.");
  await joinParts(dir, parts, asset.name);
  const file = inFolder(dir, asset.name);
  if ((await stat(file)).size !== loaded) throw new Error("The download couldn't be saved whole.");
  return file;
}

async function writePending(dir: string, version: string): Promise<void> {
  await writeFile(inFolder(dir, PENDING), JSON.stringify({ version, at: new Date().toISOString() }));
}

async function forgetPending(dir: string): Promise<void> {
  try { await unlink(inFolder(dir, PENDING)); } catch { }
}

function windowsUser(): string | undefined {
  const env = nshProcess.env;
  const name = env.USERNAME?.trim();
  if (!name) return undefined;
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${name}` : name;
}

async function installWindows(file: string, update: AvailableUpdate): Promise<void> {
  const dir = folder();
  const xml = inFolder(dir, "update-task.xml");
  await writeFile(xml, utf16le(windowsUpdateTask(file, inFolder(dir, INSTALL_LOG), windowsUser())));
  const created = await nshProcess.run("schtasks", ["/Create", "/TN", WINDOWS_TASK, "/XML", xml, "/F"], { cwd: dir, timeoutMs: 60_000 });
  if (created.code !== 0) throw new Error(`Windows' Task Scheduler didn't take the update: ${lastLines(`${created.stderr}\n${created.stdout}`) || `exit code ${created.code ?? "unknown"}`}`);
  await writePending(dir, update.version);
  const started = await nshProcess.run("schtasks", ["/Run", "/TN", WINDOWS_TASK], { cwd: dir, timeoutMs: 60_000 })
    .catch((error: unknown) => ({ code: null, stdout: "", stderr: messageOf(error) }));
  if (started.code !== 0) {
    await forgetPending(dir);
    await nshProcess.run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { cwd: dir, timeoutMs: 60_000 }).catch(() => undefined);
    throw new Error(`The installer didn't start: ${lastLines(`${started.stderr}\n${started.stdout}`) || `exit code ${started.code ?? "unknown"}`}`);
  }
}

async function installUnix(file: string, update: AvailableUpdate): Promise<void> {
  const dir = folder();
  await writePending(dir, update.version);
  const script = platform.os === "macos" ? MAC_INSTALL : LINUX_INSTALL;
  const output = await nshProcess.run("sh", ["-c", script, "pikibun-update", file], { cwd: dir, timeoutMs: 5 * 60_000 })
    .catch((error: unknown) => ({ code: null, stdout: "", stderr: `The update didn't install: ${messageOf(error)}` }));
  if (output.code !== 0) {
    await forgetPending(dir);
    throw new Error(lastLines(output.stderr) || `The update didn't install (exit code ${output.code ?? "unknown"}).`);
  }
}

async function restart(): Promise<void> {
  await Promise.race([Promise.all([computerHosts().shutdown(), thisServer().shutdown()]), new Promise<void>(resolve => setTimeout(resolve, 12_000))]).catch(() => undefined);
  try { nshProcess.exit(0); return; } catch { }
  Application.quit();
}

async function cleanUp(current: string): Promise<CleanUp> {
  const dir = updatesFolder(platform.os, nshProcess.dataDir);
  if (!dir || !(await exists(dir).catch(() => false))) return {};
  let version: string | undefined;
  try {
    const pending = JSON.parse(await readFile(inFolder(dir, PENDING), "utf8")) as { version?: unknown };
    if (typeof pending.version === "string" && isVersion(pending.version)) version = pending.version;
  } catch { }
  if (version && platform.os === "windows") {
    await nshProcess.run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { cwd: dir, timeoutMs: 60_000 }).catch(() => undefined);
  }
  const installed = version !== undefined && compareVersions(current, version) !== -1;
  await emptyFolder(dir, version && !installed ? [INSTALL_LOG] : []);
  if (!version) return {};
  return installed ? { installed: version } : { failed: version };
}

export const nativeRunner: UpdateRunner = {
  download,
  install: (file, update) => (platform.os === "windows" ? installWindows(file, update) : installUnix(file, update)),
  restart,
  cleanUp,
};

export type UpdatePhase =
  | { name: "idle" }
  | { name: "downloading"; loaded: number; total: number }
  | { name: "installing" }
  | { name: "restarting" }
  | { name: "failed"; error: string };

export interface UpdaterOptions {
  current: string;
  os: string;
  arch: string;
  runner: UpdateRunner;
}

const desktopOs = (os: string) => os === "macos" || os === "windows" || os === "linux";

export class AppUpdater {
  readonly available = signal<AvailableUpdate | null>(null);
  readonly phase = signal<UpdatePhase>({ name: "idle" });
  readonly checking = signal(false);
  readonly checked = signal(false);
  readonly checkError = signal("");
  readonly notice = signal("");
  private timers: ReturnType<typeof setTimeout>[] = [];
  private started = false;
  private cleaned: Promise<void> = Promise.resolve();

  constructor(readonly options: UpdaterOptions) {}

  get current(): string { return this.options.current; }
  get offered(): boolean { return desktopOs(this.options.os) && isVersion(this.options.current); }
  get busy(): boolean {
    const name = untracked(this.phase).name;
    return name === "downloading" || name === "installing" || name === "restarting";
  }

  async check(): Promise<boolean> {
    if (!this.offered || untracked(this.checking)) return false;
    this.checking.set(true);
    try {
      const response = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT } });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "GitHub limits how often it is asked: try again later." : `GitHub answered ${response.status}.`);
      const releases: unknown = await response.json();
      if (!Array.isArray(releases)) throw new Error("GitHub's answer had no releases.");
      const next = newerRelease(releases, this.options.current, this.options.os, this.options.arch) ?? null;
      if (!this.busy && (next?.version !== untracked(this.available)?.version || next?.asset?.url !== untracked(this.available)?.asset?.url)) this.available.set(next);
      this.checkError.set("");
      this.checked.set(true);
      return true;
    } catch (error) {
      this.checkError.set(`Couldn't check for updates: ${messageOf(error)}`);
      return false;
    } finally {
      this.checking.set(false);
    }
  }

  start(delay = FIRST_CHECK_MS, interval = CHECK_EVERY_MS): void {
    if (this.started || !this.offered) return;
    this.started = true;
    this.cleaned = this.options.runner.cleanUp(this.options.current).then(result => {
      if (result.installed) this.notice.set(`Pikibun was updated to ${result.installed}.`);
      else if (result.failed && untracked(this.phase).name === "idle") {
        this.phase.set({ name: "failed", error: `The update to ${result.failed} didn't install${this.options.os === "windows" ? `: its installer's log is ${INSTALL_LOG} in Pikibun's updates folder` : ""}. Try again, or install it from its release page.` });
      }
    }, () => undefined);
    const schedule = (wait: number) => {
      this.timers.push(setTimeout(() => {
        void this.check();
        schedule(interval);
      }, wait));
    };
    schedule(delay);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.started = false;
  }

  async install(): Promise<boolean> {
    const update = untracked(this.available);
    if (!update?.asset || this.busy) return false;
    const asset = update.asset;
    const runner = this.options.runner;
    this.notice.set("");
    try {
      this.phase.set({ name: "downloading", loaded: 0, total: asset.size });
      await this.cleaned;
      const file = await runner.download(asset, (loaded, total) => this.phase.set({ name: "downloading", loaded, total }));
      this.phase.set({ name: "installing" });
      await runner.install(file, update);
      this.phase.set({ name: "restarting" });
      await runner.restart();
      return true;
    } catch (error) {
      this.phase.set({ name: "failed", error: messageOf(error) });
      return false;
    }
  }
}

const defaults = (): UpdaterOptions => ({ current: APP_VERSION, os: platform.os, arch: nshProcess.arch, runner: nativeRunner });
let configured: Partial<UpdaterOptions> = {};
let shared: AppUpdater | undefined;

export function configureAppUpdate(options: Partial<UpdaterOptions>): AppUpdater {
  shared?.stop();
  configured = options;
  shared = undefined;
  return appUpdate();
}

export function appUpdate(): AppUpdater {
  shared ??= new AppUpdater({ ...defaults(), ...configured });
  return shared;
}

export function startUpdateChecks(): void {
  const updater = appUpdate();
  if (updater.offered) updater.start();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
