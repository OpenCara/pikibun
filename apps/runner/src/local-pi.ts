import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ClientIdentity } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { CompactionSettings } from "@earendil-works/pi-durable";
import { getAgentDir, ModelRegistry, ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import type { LocalModelSummary } from "../../../packages/shared/src/connector.js";
import { connectorLimits } from "../../../packages/shared/src/connector.js";
import { thinkingLevels, type ModelDefinition, type ThinkingLevel } from "../../../packages/shared/src/types.js";
import { runnerModels } from "./provider.js";
import type { LoadProviders, ProvidedModels, ProviderSource } from "./extensions/providers.js";

export interface ResolvedLocalModel {
  models: Models;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

export interface LocalModels {
  manifest(): Promise<LocalModelSummary[]>;
  resolve(model: ModelDefinition): Promise<ResolvedLocalModel>;
  readonly compaction?: CompactionSettings;
  readonly identity?: ClientIdentity;
  readonly modelRegistry?: ModelRegistry;
  provide?(sources: readonly ProviderSource[]): Promise<ProvidedModels[]>;
}

export function modelSummary(value: LocalModelSummary): LocalModelSummary {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.provider)
    || typeof value.modelId !== "string" || !value.modelId || value.modelId.length > 256 || /[\s\x00-\x1f\x7f]/.test(value.modelId)
    || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 || /[\x00-\x1f\x7f]/.test(value.name)
    || (value.thinkingLevels !== undefined && (!Array.isArray(value.thinkingLevels) || !value.thinkingLevels.length
      || value.thinkingLevels.some(level => !thinkingLevels.includes(level)) || new Set(value.thinkingLevels).size !== value.thinkingLevels.length))
    || (value.thinkingLevel !== undefined && (!thinkingLevels.includes(value.thinkingLevel) || (value.thinkingLevels && !value.thinkingLevels.includes(value.thinkingLevel))))) {
    throw new Error("Invalid local model metadata");
  }
  return { provider: value.provider, modelId: value.modelId, name: value.name, ...(value.thinkingLevels ? { thinkingLevels: [...value.thinkingLevels] } : {}),
    ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}) };
}

export type LocalPiRuntime = Models;

export interface LocalPiOptions {
  agentDir?: string;
  models?: readonly { provider: string; modelId: string }[];
  enabledModels?: readonly string[];
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingLevels?: ReadonlyMap<string, ThinkingLevel>;
  compaction?: CompactionSettings;
  attribution?: false;
  loadProviders?: LoadProviders;
  runtimeFactory?: (options: { authPath?: string; modelsPath?: string; refreshOnCreate: false; allowModelNetwork: false }) => Promise<LocalPiRuntime>;
}

export interface PiSettings {
  enabledModels?: string[];
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingLevels?: Map<string, ThinkingLevel>;
  compaction?: CompactionSettings;
  attribution?: false;
}

const PI_DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
const MANIFEST_TEXT = Object.freeze({ provider: 80, modelId: 200, name: 120 });

const isThinkingLevel = (value: unknown): value is ThinkingLevel => typeof value === "string" && thinkingLevels.includes(value as ThinkingLevel);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function compactionTokens(value: Record<string, unknown>, path: string): { reserveTokens?: number; keepRecentTokens?: number } {
  const tokens: { reserveTokens?: number; keepRecentTokens?: number } = {};
  for (const key of ["reserveTokens", "keepRecentTokens"] as const) {
    const count = value[key];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error(`Pi settings.json ${path}.${key} must be a non-negative integer`);
    tokens[key] = count as number;
  }
  return tokens;
}

function compactionSettings(value: unknown): CompactionSettings {
  if (!isRecord(value)) throw new Error("Pi settings.json compaction must be an object");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Pi settings.json compaction.enabled must be true or false");
  const overrides = value.modelOverrides;
  if (overrides !== undefined && (!isRecord(overrides) || !Object.values(overrides).every(isRecord))) {
    throw new Error("Pi settings.json compaction.modelOverrides must map provider/model to token settings");
  }
  return {
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...compactionTokens(value, "compaction"),
    ...(overrides ? { modelOverrides: Object.fromEntries(Object.entries(overrides as Record<string, Record<string, unknown>>)
      .map(([model, tokens]) => [model, compactionTokens(tokens, `compaction.modelOverrides["${model}"]`)])) } : {}),
  };
}

const telemetryFlag = (value: string) => value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";

export async function readPiSettings(agentDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<PiSettings> {
  const path = join(agentDir === undefined ? getAgentDir() : resolve(agentDir), "settings.json");
  let text: string | undefined;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const value = (text === undefined ? {} : JSON.parse(text)) as { enabledModels?: unknown; defaultThinkingLevel?: unknown; modelThinkingLevels?: unknown; compaction?: unknown; enableInstallTelemetry?: unknown };
  const settings: PiSettings = {};
  const enabled = value.enabledModels;
  if (enabled !== undefined) {
    if (!Array.isArray(enabled) || enabled.some(pattern => typeof pattern !== "string" || !pattern.trim()) || enabled.length > 200) {
      throw new Error("Pi settings.json enabledModels must be a list of model patterns");
    }
    if (enabled.length) settings.enabledModels = enabled;
  }
  if (value.defaultThinkingLevel !== undefined) {
    if (!isThinkingLevel(value.defaultThinkingLevel)) throw new Error(`Pi settings.json defaultThinkingLevel must be one of ${thinkingLevels.join(", ")}`);
    settings.defaultThinkingLevel = value.defaultThinkingLevel;
  }
  const perModel = value.modelThinkingLevels;
  if (perModel !== undefined) {
    if (!perModel || typeof perModel !== "object" || Array.isArray(perModel) || !Object.values(perModel).every(isThinkingLevel)) {
      throw new Error("Pi settings.json modelThinkingLevels must map provider/model to a reasoning level");
    }
    settings.modelThinkingLevels = new Map(Object.entries(perModel as Record<string, ThinkingLevel>));
  }
  if (value.compaction !== undefined) settings.compaction = compactionSettings(value.compaction);
  if (value.enableInstallTelemetry !== undefined && typeof value.enableInstallTelemetry !== "boolean") {
    throw new Error("Pi settings.json enableInstallTelemetry must be true or false");
  }
  const telemetry = env.PI_TELEMETRY;
  if (!(telemetry !== undefined ? telemetryFlag(telemetry) : value.enableInstallTelemetry !== false)) settings.attribution = false;
  return settings;
}

export async function createPiRuntime(config: Parameters<NonNullable<LocalPiOptions["runtimeFactory"]>>[0]): Promise<LocalPiRuntime> {
  const runtime = await ModelRuntime.create(config);
  try { await runtime.refresh({ allowNetwork: false, signal: AbortSignal.timeout(15_000) }); }
  catch (error) { console.warn(`Pi's saved model catalogs could not be restored: ${error instanceof Error ? error.message : String(error)}`); }
  return runtime;
}

export async function loadLocalPiModels(options: LocalPiOptions = {}): Promise<LocalModels> {
  const runtimeFactory: NonNullable<LocalPiOptions["runtimeFactory"]> = options.runtimeFactory ?? createPiRuntime;
  const agentDir = options.agentDir === undefined ? undefined : resolve(options.agentDir);
  const runtime = await runtimeFactory({
    ...(agentDir === undefined ? {} : { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const warned = new Set<string>();
  const selected = options.models && new Set(options.models.map(model => JSON.stringify([model.provider, model.modelId])));
  const selectedProviders = options.models && [...new Set(options.models.map(model => model.provider))];
  const manifest = async (): Promise<LocalModelSummary[]> => {
    const signal = AbortSignal.timeout(15_000);
    const enabled = !selected && options.enabledModels?.length ? [...options.enabledModels] : undefined;
    const resolution = !selectedProviders && enabled ? await resolveModelScopeWithDiagnostics(enabled, runtime as never, { signal }) : undefined;
    for (const diagnostic of resolution?.diagnostics ?? []) {
      if (warned.has(diagnostic.message)) continue;
      warned.add(diagnostic.message);
      console.warn(`Pi settings.json enabledModels: ${diagnostic.message}`);
    }
    const scoped = resolution?.scopedModels;
    const available = selectedProviders
      ? (await Promise.all(selectedProviders.map(provider => runtime.getAvailable(provider, { signal })))).flat()
      : scoped ? scoped.map(item => item.model)
      : await runtime.getAvailable(undefined, { signal });
    const patternLevels = new Map(scoped?.flatMap(item => item.thinkingLevel ? [[JSON.stringify([item.model.provider, item.model.id]), item.thinkingLevel] as const] : []));
    const seen = new Set<string>();
    const result: LocalModelSummary[] = [];
    for (const model of available) {
      const key = JSON.stringify([model.provider, model.id]);
      if (seen.has(key) || (selected && !selected.has(key))) continue;
      seen.add(key);
      const level = patternLevels.get(key) ?? options.modelThinkingLevels?.get(`${model.provider}/${model.id}`) ?? options.defaultThinkingLevel ?? PI_DEFAULT_THINKING_LEVEL;
      result.push(modelSummary({ provider: model.provider, modelId: model.id, name: model.name,
        thinkingLevels: getSupportedThinkingLevels(model), thinkingLevel: clampThinkingLevel(model, level) }));
    }
    if (selected && [...selected].some(key => !seen.has(key))) throw new Error("A selected local Pi model is unavailable or lacks configured authentication");
    if (result.length > connectorLimits.models) throw new Error("Local Pi catalog exceeds 200 models; narrow enabledModels in Pi's settings or pass --model");
    return result.sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
  };
  await manifest();
  const applied = new Map<string, { key: string; providers: string[] }>();
  const failed = new Map<string, { key: string; error: string }>();
  let asked = "[]";
  const fault = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 500);
  const registrar = () => {
    const value = runtime as Partial<Pick<ModelRuntime, "registerProvider" | "registerNativeProvider" | "unregisterProvider" | "refresh">>;
    if (typeof value.registerProvider !== "function" || typeof value.registerNativeProvider !== "function" || typeof value.unregisterProvider !== "function") {
      throw new Error("This host's models take no extension's providers");
    }
    return value as Pick<ModelRuntime, "registerProvider" | "registerNativeProvider" | "unregisterProvider"> & Partial<Pick<ModelRuntime, "refresh">>;
  };
  const settle = async (target: ReturnType<typeof registrar>) => {
    try { await target.refresh?.({ allowNetwork: false, signal: AbortSignal.timeout(15_000) }); } catch { }
  };
  const withdraw = async (target: ReturnType<typeof registrar>, providers: readonly string[]) => {
    for (const provider of providers) { try { target.unregisterProvider(provider); } catch { } }
    if (providers.length) await settle(target);
  };
  const apply = async (wanted: readonly ProviderSource[]): Promise<ProvidedModels[]> => {
    const keys = new Map(wanted.map(item => [item.source, JSON.stringify(item.files)]));
    const list = JSON.stringify([...keys]);
    if (list !== asked) failed.clear();
    asked = list;
    const stale = [...applied].filter(([source, entry]) => keys.get(source) !== entry.key);
    if (!stale.length && wanted.every(item => applied.has(item.source) || failed.has(item.source))) {
      return wanted.map(item => ({ source: item.source, providers: applied.get(item.source)?.providers ?? [], ...(failed.has(item.source) ? { error: failed.get(item.source)!.error } : {}) }));
    }
    if (selected) return wanted.map(item => ({ source: item.source, providers: [], error: "This connector was started with --model, so it offers exactly those models" }));
    let target: ReturnType<typeof registrar>;
    try { target = registrar(); }
    catch (error) { return wanted.map(item => ({ source: item.source, providers: [], error: fault(error) })); }
    for (const [source, entry] of stale) {
      applied.delete(source);
      await withdraw(target, entry.providers);
    }
    for (const item of wanted) {
      const key = keys.get(item.source)!;
      if (applied.has(item.source) || failed.has(item.source)) continue;
      const providers: string[] = [];
      try {
        const load = options.loadProviders ?? (await import("./extensions/providers.js")).loadProviderRegistrations;
        const registrations = await load(item.files);
        const names = [...registrations.configured.map(entry => entry.name), ...registrations.native.map(entry => entry.id)];
        if (!names.length) throw new Error("It registers no provider as it loads");
        const taken = names.find(name => [...applied.values()].some(entry => entry.providers.includes(name)));
        if (taken) throw new Error(`Another extension already provides ${taken}`);
        for (const { name, config } of registrations.configured) {
          target.registerProvider(name, config);
          if (!providers.includes(name)) providers.push(name);
        }
        for (const provider of registrations.native) {
          target.registerNativeProvider(provider);
          if (!providers.includes(provider.id)) providers.push(provider.id);
        }
        await settle(target);
        const offered = (await manifest()).find(model => providers.includes(model.provider)
          && (model.provider.length > MANIFEST_TEXT.provider || model.modelId.length > MANIFEST_TEXT.modelId || model.name.length > MANIFEST_TEXT.name));
        if (offered) throw new Error(`Its model ${offered.provider}/${offered.modelId} has a provider, id or name longer than Pikibun takes`);
        applied.set(item.source, { key, providers });
      } catch (error) {
        await withdraw(target, providers);
        failed.set(item.source, { key, error: fault(error) });
      }
    }
    return wanted.map(item => ({ source: item.source, providers: applied.get(item.source)?.providers ?? [], ...(failed.has(item.source) ? { error: failed.get(item.source)!.error } : {}) }));
  };
  let providing: Promise<unknown> = Promise.resolve();
  const provide = (wanted: readonly ProviderSource[]): Promise<ProvidedModels[]> => {
    const next = providing.then(() => apply(wanted));
    providing = next.catch(() => {});
    return next;
  };
  let modelRegistry: ModelRegistry | undefined;
  try { modelRegistry = new ModelRegistry(runtime as ModelRuntime); } catch { }
  return {
    manifest,
    provide,
    ...(modelRegistry ? { modelRegistry } : {}),
    ...(options.compaction ? { compaction: options.compaction } : {}),
    ...(options.attribution === false ? { identity: { attribution: null } } : {}),
    async resolve(model) {
      const available = await manifest();
      const summary = available.find(item => item.provider === model.provider && item.modelId === model.modelId);
      if (!summary || !runtime.getModel(model.provider, model.modelId)) throw new Error("Requested local Pi model is unavailable");
      return { models: runtime, provider: model.provider, modelId: model.modelId, ...(summary.thinkingLevel ? { thinkingLevel: summary.thinkingLevel } : {}) };
    },
  };
}

export function createFauxLocalModels(modelId = "fixture"): LocalModels {
  const summary = modelSummary({ provider: "faux", modelId, name: "Deterministic test provider (not an LLM)", thinkingLevels: ["off"] });
  return {
    async manifest() { return [{ ...summary }]; },
    async resolve(model) {
      if (model.provider !== "faux" || model.modelId !== modelId) throw new Error("Requested fixture model is unavailable");
      return { models: runnerModels(model, true), provider: "faux", modelId };
    },
  };
}
