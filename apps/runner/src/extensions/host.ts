import { extensionLimits, isPikiExtensionSource, parseExtensionSourceSpec, parseWorkspaceExtensionsAnswer, type ExtensionRequest, type ExtensionRequestResult,
  type HostExtensionsReport, type WorkspaceExtensionsAnswer } from "../../../../packages/shared/src/host-extensions.js";
import type { PikiExtension } from "./piki/index.js";
import { loadInstalled, type LoadedSource } from "./load.js";
import type { ExtensionSource, ExtensionStore } from "./store.js";

/*
 * A connector's extensions (docs/design/host-extensions.md): what is installed and loaded, what it reports to the
 * control plane, the installs and removals the host's owner asks for in Pikibun, and each workspace's choice of
 * extensions, asked for at most every 30 seconds.
 */

/** How long a workspace's extensions are used before the control plane is asked again: changes reach messages within it. */
const WORKSPACE_TTL_MS = 30_000;
/** A list the control plane can't refresh stays in use this long; then the workspace's sessions run without extensions. */
const WORKSPACE_STALE_MS = 5 * 60_000;

const none: WorkspaceExtensionsAnswer = Object.freeze({ extensions: [], automaticTools: false });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, extensionLimits.text);

export class HostExtensions {
  #loaded: LoadedSource[] = [];
  #workspaces = new Map<string, { value: WorkspaceExtensionsAnswer; at: number; refresh?: Promise<WorkspaceExtensionsAnswer> }>();
  /** Each workspace's last answer this connector read, whatever its age: what a fail-closed session tool goes by (lastKnown). */
  #lastKnown = new Map<string, WorkspaceExtensionsAnswer>();

  /** `pikiExtensions`: the connector's Pikibun extensions (all of this version's by default). */
  constructor(readonly store: ExtensionStore, readonly options: { remoteInstalls: boolean; now?: () => number; pikiExtensions?: readonly PikiExtension[] }) {}

  /** What the host has: its Pikibun extensions, then those installed, loaded once when the connector starts and again after each change. */
  get loaded(): readonly LoadedSource[] { return this.#loaded; }

  async load(): Promise<void> { this.#loaded = await loadInstalled(this.store, this.options.pikiExtensions); }

  /**
   * The report without its Pikibun extensions, for a control plane that predates them (it refuses a report that names
   * one).
   */
  reportWithoutPikiExtensions(): HostExtensionsReport {
    const report = this.report();
    return { ...report, installed: report.installed.filter(item => !isPikiExtensionSource(item.source)) };
  }

  /** Loads the installed extensions again when `pikibun extensions` changed them since. */
  async refreshIfChanged(): Promise<void> {
    const installed = (await this.store.list().catch(() => [])).map(item => item.source);
    const loaded = this.#loaded.filter(item => !item.factories).map(item => item.installed.source);
    if (installed.length !== loaded.length || installed.some((source, index) => source !== loaded[index])) await this.load();
  }

  report(): HostExtensionsReport {
    return { installed: this.#loaded.map(item => item.summary), remoteInstalls: this.options.remoteInstalls };
  }

  /**
   * Carries out the requests the host's owner made in Pikibun, unless this connector refuses them, then loads what is
   * installed again. A request for what is already so (installed, or not) succeeds.
   */
  async apply(requests: readonly ExtensionRequest[]): Promise<ExtensionRequestResult[]> {
    if (!requests.length) return [];
    if (!this.options.remoteInstalls) {
      return requests.map(request => ({ id: request.id, ok: false, error: "This host's connector runs with --no-remote-installs: install extensions on it with pikibun extensions." }));
    }
    const results: ExtensionRequestResult[] = [];
    for (const request of requests) {
      try {
        if (isPikiExtensionSource(request.source)) throw new Error(`${request.source} is built into the connector: update the connector instead (npx pikibun@latest connect).`);
        if (request.action === "install") await this.store.add(parseExtensionSourceSpec(request.source) as ExtensionSource);
        else if ((await this.store.list()).some(item => item.source === request.source)) await this.store.remove(request.source);
        results.push({ id: request.id, ok: true });
      } catch (error) {
        results.push({ id: request.id, ok: false, error: message(error) });
      }
    }
    await this.load();
    return results;
  }

  /**
   * The extensions workspace `workspaceId` uses, as `fetch` asks the control plane; cached for 30 seconds, and kept for 5
   * minutes when it can't be asked. Without any answer (or from a control plane that predates extensions), none.
   */
  async workspace(workspaceId: string, fetch: () => Promise<unknown>): Promise<WorkspaceExtensionsAnswer> {
    const now = this.options.now ?? Date.now;
    const cached = this.#workspaces.get(workspaceId);
    if (cached && now() - cached.at < WORKSPACE_TTL_MS) return cached.value;
    if (cached?.refresh) return cached.refresh;
    const entry = cached ?? { value: none, at: -Infinity };
    entry.refresh = fetch().then(value => {
      entry.value = parseWorkspaceExtensionsAnswer(value);
      entry.at = now();
      this.#lastKnown.set(workspaceId, entry.value);
      return entry.value;
    }).catch(() => now() - entry.at < WORKSPACE_STALE_MS ? entry.value : none).finally(() => { entry.refresh = undefined; });
    this.#workspaces.set(workspaceId, entry);
    return entry.refresh;
  }

  /**
   * The last answer read for workspace `workspaceId`, however old, or none while this connector never read one. Unlike
   * `workspace`, it doesn't fall back to no extensions once the control plane has been out of reach for a while, so a
   * session tool the workspace turned off whose being off protects something (a shell) stays off then.
   */
  lastKnown(workspaceId: string): WorkspaceExtensionsAnswer | undefined { return this.#lastKnown.get(workspaceId); }
}
