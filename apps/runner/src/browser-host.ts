import { homedir } from "node:os";
import { join } from "node:path";
import { hostBrowserStatusLimits, type HostBrowserConfig, type HostBrowserStatus } from "../../../packages/shared/src/browser.js";
import { downloadedHeadlessShells, downloadHeadlessShell, latestHeadlessShell, pruneHeadlessShells } from "./browser-download.js";
import { hostBrowser, inspectBrowser, type BrowserToolchain } from "./browser-toolchain.js";

/*
 * The Chromium a connector's sessions get for the browser tool, as its host's owner chose on the host's page
 * (HostConfig.browser): one found on the host, the one at a path they gave, one the connector downloaded, or none. The
 * connector applies the choice when it connects and each time it reports its extensions (every half minute), so a
 * change of setting, a browser installed meanwhile or a finished download reaches sessions within a minute, with no
 * restart; it reports how it stands (HostBrowserStatus) for the host's page and its sessions' warnings.
 */

/** A failed download is tried again after this long, or when the host's owner chooses again. */
const RETRY_MS = 10 * 60_000;
/** How often a downloaded headless shell is checked against Chrome for Testing's Stable version. */
const UPDATE_MS = 24 * 3600_000;

export interface HostBrowserOptions {
  /** Where the connector keeps the headless shells it downloads: its own state, never a session's. */
  root: string;
  /** Whether its sessions have the Linux sandbox the browser runs in. */
  supported: boolean;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  now?: () => number;
  /** Stops a download under way, as the connector stops. */
  signal?: AbortSignal;
  /** How `auto` looks on the host (hostBrowser); tests stand in their own, whatever this machine has. */
  detect?: () => BrowserToolchain | undefined;
}

export class HostBrowserSource {
  #config: HostBrowserConfig = { source: "auto" };
  #current: BrowserToolchain | undefined;
  #status: HostBrowserStatus;
  #download: Promise<void> | undefined;
  /** The last download, until its outcome is applied too. */
  #task: Promise<void> | undefined;
  #failure: { error: string; at: number } | undefined;
  #checked = -Infinity;
  readonly #abort = new AbortController();

  constructor(readonly options: HostBrowserOptions) {
    this.#status = { source: "auto", state: options.supported ? "missing" : "unsupported", downloadable: this.downloadable };
  }

  /** Chrome for Testing builds its headless shell for Linux on x86-64 only. */
  get downloadable(): boolean { return this.options.supported && (this.options.platform ?? process.platform) === "linux" && (this.options.arch ?? process.arch) === "x64"; }

  /** The Chromium sessions get now, if any. */
  current(): BrowserToolchain | undefined { return this.#current; }

  status(): HostBrowserStatus { return this.#status; }

  /** Applies `config`: finds the browser it names, and starts a download it needs, in the background. */
  async apply(config: HostBrowserConfig): Promise<HostBrowserStatus> {
    // Choosing download again, or another source, tries a failed download again at once.
    if (config.source !== this.#config.source || config.path !== this.#config.path) this.#failure = undefined;
    this.#config = config;
    await this.evaluate();
    return this.#status;
  }

  /** Stops a download under way, as the connector stops. */
  close(): void { this.#abort.abort(); }

  /**
   * Within what the control plane takes (hostBrowserStatusLimits), so a long path in an error never gets the report
   * refused: an error is cut short, and an executable path too long to report is left out.
   */
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
    // download
    if (!this.downloadable) {
      return this.set({ state: "missing", error: "Chrome for Testing builds its headless shell for Linux on x86-64 only: install your distribution's chromium and find it on the host" });
    }
    const now = (this.options.now ?? Date.now)();
    const newest = downloads[0];
    if (newest) {
      this.set({ state: "ready", version: newest.version }, newest.browser);
      // Kept up to date: a newer Stable replaces it once downloaded whole.
      if (!this.#download && now - this.#checked >= UPDATE_MS) this.startDownload(newest.version);
      return;
    }
    // A download tried again says why the last try failed until it is done.
    const retried = this.#failure ? { error: this.#failure.error } : {};
    if (this.#download) return this.set({ state: "downloading", ...retried });
    if (this.#failure && now - this.#failure.at < RETRY_MS) return this.set({ state: "failed", error: this.#failure.error });
    this.startDownload();
    this.set({ state: "downloading", ...retried });
  }

  /** Downloads Chrome for Testing's Stable headless shell, unless `have` is that version already. */
  private startDownload(have?: string): void {
    const now = this.options.now ?? Date.now;
    this.#checked = now();
    const signal = this.options.signal ? AbortSignal.any([this.#abort.signal, this.options.signal]) : this.#abort.signal;
    const options = { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal };
    const task = (async () => {
      try {
        // Only what no command can still be running goes: the one in use stays, and so does the one it replaced at the
        // last check, until this one, a day later (a command runs an hour at most). Older ones, and what a stopped
        // download left, go now. A new one is published first, then sessions switch to it (below), never the reverse.
        await pruneHeadlessShells(this.options.root, have ? [have] : []);
        const release = await latestHeadlessShell(options);
        if (release.version !== have) await downloadHeadlessShell(this.options.root, release, options);
        this.#failure = undefined;
      } catch (error) {
        // A failed update leaves the one there in use; a failed first download is tried again later.
        if (!have) this.#failure = { error: (error instanceof Error ? error.message : String(error)).slice(0, 500), at: now() };
      } finally {
        this.#download = undefined;
      }
      if (this.#config.source === "download") await this.evaluate().catch(() => {});
    })();
    this.#download = task;
    this.#task = task;
  }

  /** The last download, and its outcome applied, for tests. */
  settled(): Promise<void> { return this.#task ?? Promise.resolve(); }
}

/** Where a connector whose state is in `directory` keeps the headless shells it downloads. */
export function browserDownloads(directory: string): string { return join(directory, "browser"); }
