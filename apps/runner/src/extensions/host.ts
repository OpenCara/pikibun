import { extensionLimits, isPikiExtensionSource, parseExtensionSourceSpec, parseWorkspaceExtensionsAnswer, type ExtensionRequest, type ExtensionRequestResult,
  type HostExtensionsReport, type WorkspaceExtensionsAnswer } from "../../../../packages/shared/src/host-extensions.js";
import type { PikiExtension } from "./piki/index.js";
import { loadInstalled, type LoadedSource } from "./load.js";
import type { ExtensionSource, ExtensionStore } from "./store.js";

const WORKSPACE_TTL_MS = 30_000;
const WORKSPACE_STALE_MS = 5 * 60_000;

const none: WorkspaceExtensionsAnswer = Object.freeze({ extensions: [], automaticTools: false });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, extensionLimits.text);

export class HostExtensions {
  #loaded: LoadedSource[] = [];
  #workspaces = new Map<string, { value: WorkspaceExtensionsAnswer; at: number; refresh?: Promise<WorkspaceExtensionsAnswer> }>();
  #lastKnown = new Map<string, WorkspaceExtensionsAnswer>();

  constructor(readonly store: ExtensionStore, readonly options: { remoteInstalls: boolean; now?: () => number; pikiExtensions?: readonly PikiExtension[] }) {}

  get loaded(): readonly LoadedSource[] { return this.#loaded; }

  async load(): Promise<void> { this.#loaded = await loadInstalled(this.store, this.options.pikiExtensions); }

  reportWithoutPikiExtensions(): HostExtensionsReport {
    const report = this.report();
    return { ...report, installed: report.installed.filter(item => !isPikiExtensionSource(item.source)) };
  }

  async refreshIfChanged(): Promise<void> {
    const installed = (await this.store.list().catch(() => [])).map(item => item.source);
    const loaded = this.#loaded.filter(item => !item.factories).map(item => item.installed.source);
    if (installed.length !== loaded.length || installed.some((source, index) => source !== loaded[index])) await this.load();
  }

  report(): HostExtensionsReport {
    return { installed: this.#loaded.map(item => item.summary), remoteInstalls: this.options.remoteInstalls };
  }

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

  lastKnown(workspaceId: string): WorkspaceExtensionsAnswer | undefined { return this.#lastKnown.get(workspaceId); }
}
