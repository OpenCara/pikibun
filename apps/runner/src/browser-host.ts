import { homedir } from "node:os";
import { join } from "node:path";
import { hostBrowserStatusLimits, type HostBrowserConfig, type HostBrowserStatus } from "../../../packages/shared/src/browser.js";
import { downloadedHeadlessShells, downloadHeadlessShell, latestHeadlessShell, pruneHeadlessShells } from "./browser-download.js";
import { hostBrowser, inspectBrowser, type BrowserToolchain } from "./browser-toolchain.js";

const RETRY_MS = 10 * 60_000;
const UPDATE_MS = 24 * 3600_000;

export interface HostBrowserOptions {
  root: string;
  supported: boolean;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  now?: () => number;
  signal?: AbortSignal;
  detect?: () => BrowserToolchain | undefined;
}

export class HostBrowserSource {
  #config: HostBrowserConfig = { source: "auto" };
  #current: BrowserToolchain | undefined;
  #status: HostBrowserStatus;
  #download: Promise<void> | undefined;
  #task: Promise<void> | undefined;
  #failure: { error: string; at: number } | undefined;
  #checked = -Infinity;
  readonly #abort = new AbortController();

  constructor(readonly options: HostBrowserOptions) {
    this.#status = { source: "auto", state: options.supported ? "missing" : "unsupported", downloadable: this.downloadable };
  }

  get downloadable(): boolean { return this.options.supported && (this.options.platform ?? process.platform) === "linux" && (this.options.arch ?? process.arch) === "x64"; }

  current(): BrowserToolchain | undefined { return this.#current; }

  status(): HostBrowserStatus { return this.#status; }

  async apply(config: HostBrowserConfig): Promise<HostBrowserStatus> {
    if (config.source !== this.#config.source || config.path !== this.#config.path) this.#failure = undefined;
    this.#config = config;
    await this.evaluate();
    return this.#status;
  }

  close(): void { this.#abort.abort(); }

  private set(status: Omit<HostBrowserStatus, "source" | "downloadable">, browser?: BrowserToolchain): void {
    this.#current = status.state === "ready" ? browser : undefined;
    const clip = (text: string) => text.length > hostBrowserStatusLimits.text ? `${text.slice(0, hostBrowserStatusLimits.text - 1)}…` : text;
    const executable = browser && status.state === "ready" && browser.executable.length <= hostBrowserStatusLimits.executable ? browser.executable : undefined;
    this.#status = { source: this.#config.source, downloadable: this.downloadable, state: status.state,
      ...(executable ? { executable } : {}), ...(status.version ? { version: clip(status.version) } : {}), ...(status.error ? { error: clip(status.error) } : {}) };
  }

  private async evaluate(): Promise<void> {
    const config = this.#config;
    const { platform, home } = this.options;
    const found = { ...(platform ? { platform } : {}), ...(home ? { home } : {}) };
    if (!this.options.supported) return this.set({ state: "unsupported", error: "Sessions on this host have no Linux sandbox, which the browser runs in" });
    if (config.source === "off") return this.set({ state: "off" });
    if (config.source === "path") {
      const inspected = inspectBrowser(config.path ?? "", found);
      return "browser" in inspected ? this.set({ state: "ready" }, inspected.browser) : this.set({ state: "missing", error: inspected.error });
    }
    const downloads = await downloadedHeadlessShells(this.options.root);
    if (config.source === "auto") {
      const browser = (this.options.detect ? this.options.detect() : hostBrowser({ env: this.options.env ?? process.env, ...found, home: home ?? homedir() }))
        ?? downloads[0]?.browser;
      return browser ? this.set({ state: "ready", ...(browser === downloads[0]?.browser ? { version: downloads[0].version } : {}) }, browser)
        : this.set({ state: "missing", error: "No Chromium found on this host: install your distribution's chromium or Google Chrome, give the path of one, or download one here" });
    }
    if (!this.downloadable) {
      return this.set({ state: "missing", error: "Chrome for Testing builds its headless shell for Linux on x86-64 only: install your distribution's chromium and find it on the host" });
    }
    const now = (this.options.now ?? Date.now)();
    const newest = downloads[0];
    if (newest) {
      this.set({ state: "ready", version: newest.version }, newest.browser);
      if (!this.#download && now - this.#checked >= UPDATE_MS) this.startDownload(newest.version);
      return;
    }
    const retried = this.#failure ? { error: this.#failure.error } : {};
    if (this.#download) return this.set({ state: "downloading", ...retried });
    if (this.#failure && now - this.#failure.at < RETRY_MS) return this.set({ state: "failed", error: this.#failure.error });
    this.startDownload();
    this.set({ state: "downloading", ...retried });
  }

  private startDownload(have?: string): void {
    const now = this.options.now ?? Date.now;
    this.#checked = now();
    const signal = this.options.signal ? AbortSignal.any([this.#abort.signal, this.options.signal]) : this.#abort.signal;
    const options = { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal };
    const task = (async () => {
      try {
        await pruneHeadlessShells(this.options.root, have ? [have] : []);
        const release = await latestHeadlessShell(options);
        if (release.version !== have) await downloadHeadlessShell(this.options.root, release, options);
        this.#failure = undefined;
      } catch (error) {
        if (!have) this.#failure = { error: (error instanceof Error ? error.message : String(error)).slice(0, 500), at: now() };
      } finally {
        this.#download = undefined;
      }
      if (this.#config.source === "download") await this.evaluate().catch(() => {});
    })();
    this.#download = task;
    this.#task = task;
  }

  settled(): Promise<void> { return this.#task ?? Promise.resolve(); }
}

export function browserDownloads(directory: string): string { return join(directory, "browser"); }
