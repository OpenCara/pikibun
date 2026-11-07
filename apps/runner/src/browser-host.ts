import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostBrowserStatusLimits, type HostBrowserConfig, type HostBrowserStatus } from "../../../packages/shared/src/browser.js";
import { hostBrowser, inspectBrowser, type BrowserToolchain } from "./browser-toolchain.js";

/*
 * The Chromium a connector's sessions get for the browser tool, as its host's owner chose on the host's page
 * (HostConfig.browser): one found on the host, the one at a path they gave, or none. The host's owner installs it, from
 * their distribution's packages (or Google Chrome's, or Playwright's with its dependencies), which bring the system
 * libraries it links: the connector downloads none, since a lone Chromium build doesn't start without them. The
 * connector applies the choice when it connects and each time it reports its extensions (every half minute), so a
 * change of setting or a browser installed meanwhile reaches sessions within a minute, with no restart; it reports how
 * it stands (HostBrowserStatus) for the host's page and its sessions' warnings.
 */

export interface HostBrowserOptions {
  /** Whether its sessions have the Linux sandbox the browser runs in. */
  supported: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** How `auto` looks on the host (hostBrowser); tests stand in their own, whatever this machine has. */
  detect?: () => BrowserToolchain | undefined;
}

export class HostBrowserSource {
  #config: HostBrowserConfig = { source: "auto" };
  #current: BrowserToolchain | undefined;
  #status: HostBrowserStatus;

  constructor(readonly options: HostBrowserOptions) {
    this.#status = { source: "auto", state: options.supported ? "missing" : "unsupported", downloadable: false };
  }

  /** The Chromium sessions get now, if any. */
  current(): BrowserToolchain | undefined { return this.#current; }

  status(): HostBrowserStatus { return this.#status; }

  /** Applies `config`: finds the browser it names. */
  async apply(config: HostBrowserConfig): Promise<HostBrowserStatus> {
    this.#config = config;
    this.evaluate();
    return this.#status;
  }

  /**
   * Within what the control plane takes (hostBrowserStatusLimits), so a long path in an error never gets the report
   * refused: an error is cut short, and an executable path too long to report is left out. `downloadable` is false, for
   * older control planes, which require it.
   */
  private set(status: Omit<HostBrowserStatus, "source" | "downloadable" | "version">, browser?: BrowserToolchain): void {
    this.#current = status.state === "ready" ? browser : undefined;
    const clip = (text: string) => text.length > hostBrowserStatusLimits.text ? `${text.slice(0, hostBrowserStatusLimits.text - 1)}…` : text;
    const executable = browser && status.state === "ready" && browser.executable.length <= hostBrowserStatusLimits.executable ? browser.executable : undefined;
    this.#status = { source: this.#config.source, downloadable: false, state: status.state,
      ...(executable ? { executable } : {}), ...(status.error ? { error: clip(status.error) } : {}) };
  }

  private evaluate(): void {
    const config = this.#config;
    const { platform, home } = this.options;
    const found = { ...(platform ? { platform } : {}), ...(home ? { home } : {}) };
    if (!this.options.supported) return this.set({ state: "unsupported", error: "Sessions on this host have no Linux sandbox, which the browser runs in" });
    if (config.source === "off") return this.set({ state: "off" });
    if (config.source === "path") {
      const inspected = inspectBrowser(config.path ?? "", found);
      return "browser" in inspected ? this.set({ state: "ready" }, inspected.browser) : this.set({ state: "missing", error: inspected.error });
    }
    const browser = this.options.detect ? this.options.detect() : hostBrowser({ env: this.options.env ?? process.env, ...found, home: home ?? homedir() });
    return browser ? this.set({ state: "ready" }, browser)
      : this.set({ state: "missing", error: "No Chromium found on this host: install your distribution's chromium (sudo apt install chromium, sudo dnf install chromium) or Google Chrome, which bring the libraries it needs, or give the path of one" });
  }
}

/**
 * Removes the headless shells older connectors downloaded into their state (`<state>/browser`), which nothing runs any
 * more: about 240 MB each, with no updates to come. Best effort: one that can't go yet goes at a later start.
 */
export async function removeBrowserDownloads(directory: string): Promise<void> {
  await rm(join(directory, "browser"), { recursive: true, force: true }).catch(() => {});
}
