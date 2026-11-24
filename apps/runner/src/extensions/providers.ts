import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { HostConfig } from "../../../../packages/shared/src/host-config.js";
import { extensionLimits } from "../../../../packages/shared/src/host-extensions.js";
import { loadSource, type LoadedSource } from "./load.js";

export const PROVIDER_LOAD_TIMEOUT_MS = 60_000;

export interface ProviderSource {
  source: string;
  files: string[];
}

export interface ProviderRegistrations {
  configured: { name: string; config: Parameters<ModelRuntime["registerProvider"]>[1] }[];
  native: Provider[];
}

export interface ProvidedModels {
  source: string;
  providers: string[];
  error?: string;
}

export type LoadProviders = (files: readonly string[]) => Promise<ProviderRegistrations>;

const JITI_ENVIRONMENT = { JITI_FS_CACHE: "false", JITI_REBUILD_FS_CACHE: "true", JITI_ESM_EVAL_TEMP_FILE: "false" } as const;

let loading: Promise<unknown> = Promise.resolve();

export function loadProviderRegistrations(files: readonly string[], timeoutMs = PROVIDER_LOAD_TIMEOUT_MS): Promise<ProviderRegistrations> {
  const next = loading.then(() => loadOnce(files, timeoutMs));
  loading = next.catch(() => {});
  return next;
}

async function loadOnce(files: readonly string[], timeoutMs: number): Promise<ProviderRegistrations> {
  const cwd = await mkdtemp(join(tmpdir(), "pikibun-providers-"));
  const before = Object.fromEntries(Object.keys(JITI_ENVIRONMENT).map(name => [name, process.env[name]]));
  Object.assign(process.env, JITI_ENVIRONMENT);
  let timer: NodeJS.Timeout | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`It didn't load within ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
      timer.unref();
    });
    const load = loadSource({ files: [...files] }, cwd);
    void load.catch(() => {});
    const result = await Promise.race([load, late]);
    const failure = result.errors[0];
    if (failure) throw new Error(failure.error);
    if (result.extensions.length !== files.length) throw new Error("One of its modules didn't load");
    return {
      configured: result.runtime.pendingProviderRegistrations.map(({ name, config }) => ({ name, config })),
      native: result.runtime.pendingNativeProviderRegistrations.map(({ provider }) => provider),
    };
  } finally {
    clearTimeout(timer);
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

export function providerSources(config: Pick<HostConfig, "modelExtensions">, loaded: readonly LoadedSource[]): { sources: ProviderSource[]; missing: ProvidedModels[] } {
  const sources: ProviderSource[] = [];
  const missing: ProvidedModels[] = [];
  for (const source of config.modelExtensions) {
    if (!source.startsWith("npm:") && !source.startsWith("git:")) {
      missing.push({ source, providers: [], error: "Only an extension installed from npm or Git provides models" });
      continue;
    }
    const installed = loaded.find(item => item.installed.source === source && !item.factories && !item.managed && !item.summary.dev && item.installed.directory !== undefined);
    if (!installed) missing.push({ source, providers: [], error: "It isn't installed on this host at that version" });
    else if (installed.summary.error || !installed.files.length) missing.push({ source, providers: [], error: (installed.summary.error ?? "It has no extension modules").slice(0, extensionLimits.text) });
    else sources.push({ source, files: [...installed.files] });
  }
  return { sources, missing };
}
