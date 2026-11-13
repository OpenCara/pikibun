import { extensionLimits, isPikiExtensionSource, parseExtensionSourceSpec, parseWorkspaceExtensionsAnswer, type ExtensionRequest, type ExtensionRequestResult,
  type HostExtensionsReport, type WorkspaceExtensionsAnswer } from "../../../../packages/shared/src/host-extensions.js";
import { connectorRelease, connectorRunsPin, inManagedScope, MANAGED_EXTENSION_SCOPE, managedPinKey, type ManagedExtensionPin } from "../../../../packages/shared/src/managed-extensions.js";
import { pikiExtension } from "../../../../packages/shared/src/piki-extensions.js";
import { connectorPikiExtensions, type PikiExtension } from "./piki/index.js";
import { loadInstalled, loadManaged, type LoadedSource } from "./load.js";
import { sameManaged, type ExtensionSource, type ExtensionStore } from "./store.js";

const WORKSPACE_TTL_MS = 30_000;
const WORKSPACE_STALE_MS = 5 * 60_000;
export const MANAGED_RETRY_MS = 10 * 60_000;

const none: WorkspaceExtensionsAnswer = Object.freeze({ extensions: [], automaticTools: false });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, extensionLimits.text);

export interface HostExtensionsOptions {
  remoteInstalls: boolean;
  now?: () => number;
  pikiExtensions?: readonly PikiExtension[];
  managed?: boolean;
  connectorVersion?: string;
  log?: (line: string) => void;
}

export class HostExtensions {
  #loaded: LoadedSource[] = [];
  #workspaces = new Map<string, { value: WorkspaceExtensionsAnswer; at: number; refresh?: Promise<WorkspaceExtensionsAnswer> }>();
  #lastKnown = new Map<string, WorkspaceExtensionsAnswer>();
  #managed: LoadedSource[] = [];
  #failed = new Map<string, { at: number; reason: string }>();
  #logged = new Set<string>();
  #pruned = false;

  constructor(readonly store: ExtensionStore, readonly options: HostExtensionsOptions) {}

  get loaded(): readonly LoadedSource[] { return this.#loaded; }

  get managesExtensions(): boolean {
    return this.options.managed === true && this.options.remoteInstalls && connectorRelease(this.options.connectorVersion);
  }

  async load(): Promise<void> { this.#loaded = await loadInstalled(this.store, this.options.pikiExtensions, this.#managed); }

  reportWithoutPikiExtensions(): HostExtensionsReport {
    const report = this.report();
    return { ...report, installed: report.installed.filter(item => !isPikiExtensionSource(item.source)) };
  }

  async refreshIfChanged(): Promise<void> {
    const installed = (await this.store.list().catch(() => [])).map(item => item.source);
    const loaded = this.#loaded.filter(item => !item.factories && !item.managed && !isPikiExtensionSource(item.summary.source)).map(item => item.installed.source);
    if (installed.length !== loaded.length || installed.some((source, index) => source !== loaded[index])) await this.load();
  }

  report(): HostExtensionsReport {
    return { installed: this.#loaded.map(item => item.summary), remoteInstalls: this.options.remoteInstalls };
  }

  async applyManaged(pins: readonly ManagedExtensionPin[] | undefined): Promise<boolean> {
    if (!this.managesExtensions) return false;
    const now = this.options.now ?? Date.now;
    const bundled = this.options.pikiExtensions ?? connectorPikiExtensions;
    const refused = new Map<string, string>();
    const usable: ManagedExtensionPin[] = [];
    for (const pin of pins ?? []) {
      const copy = bundled.find(item => item.info.source === pin.source);
      if (copy ? !copy.managed : pikiExtension(pin.source) !== undefined) {
        this.log(`${pin.source}: the pin for ${pin.package}@${pin.version} is ignored: this connector runs its own ${pin.source}`);
        continue;
      }
      const reason = !inManagedScope(pin.package) ? `${pin.package} is not a ${MANAGED_EXTENSION_SCOPE} package`
        : !connectorRunsPin(pin, this.options.connectorVersion) ? `${pin.package}@${pin.version} needs connector ${pin.minimumConnector} or later: update it (npx pikibun@latest connect)`
        : undefined;
      if (reason) {
        refused.set(pin.source, reason);
        this.log(`${pin.source}: ${reason}`);
      } else usable.push(pin);
    }
    if (!this.#pruned) {
      this.#pruned = true;
      try {
        const removed = await this.store.pruneManaged(usable);
        for (const item of removed) this.log(`${item.source}: removed ${item.package}@${item.version}, which is no longer pinned`);
      } catch (error) { this.log(`managed extensions couldn't be pruned: ${message(error)}`); }
    }
    const managed: LoadedSource[] = [];
    for (const pin of usable) {
      const current = this.#managed.find(item => item.managed && sameManaged(item.managed, pin));
      if (current) { managed.push(current); continue; }
      const key = managedPinKey(pin);
      const failed = this.#failed.get(key);
      if (failed && now() - failed.at < MANAGED_RETRY_MS) { refused.set(pin.source, failed.reason); continue; }
      try {
        const installed = await this.store.addManaged(pin);
        const loaded = await loadManaged(this.store, installed);
        const failure = loaded.summary.error ?? loaded.summary.modules.find(module => module.error)?.error;
        if (failure !== undefined) {
          await this.store.removeManaged(installed).catch(() => {});
          throw new Error(`${pin.package}@${pin.version} didn't load: ${failure}`);
        }
        this.#failed.delete(key);
        managed.push(loaded);
      } catch (error) {
        const reason = message(error);
        this.#failed.set(key, { at: now(), reason });
        refused.set(pin.source, reason);
        this.log(`${pin.source}: ${pin.package}@${pin.version} isn't used, until it is tried again in ${MANAGED_RETRY_MS / 60_000} minutes: ${reason}`);
      }
    }
    for (const [source, reason] of refused) {
      if (bundled.some(item => item.info.source === source)) continue;
      managed.push({ installed: { source }, root: "", files: [], summary: { source, dev: false, modules: [], error: reason } });
    }
    const signature = (items: readonly LoadedSource[]) => JSON.stringify(items.map(item => [item.summary.source, item.managed?.directory, item.summary.error]));
    if (signature(managed) === signature(this.#managed)) return false;
    this.#managed = managed;
    await this.load();
    return true;
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

  private log(line: string): void {
    if (this.#logged.has(line)) return;
    this.#logged.add(line);
    if (this.#logged.size > 1000) this.#logged.clear();
    (this.options.log ?? (text => { process.stderr.write(`Managed extensions: ${text.replace(/[\x00-\x1f\x7f]/g, " ")}\n`); }))(line);
  }
}
