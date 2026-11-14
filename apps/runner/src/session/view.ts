import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import type { CompactionSettings, Conversation, EntryRecord, Harness } from "@earendil-works/pi-durable";
import type { BrowserUnavailableReason } from "../../../../packages/shared/src/browser.js";
import { extensionPackageKey, missingRequiredExtensions, sessionExtensions, type WorkspaceExtensionsAnswer } from "../../../../packages/shared/src/host-extensions.js";
import type { HostConfig, RequiredExtension } from "../../../../packages/shared/src/host-config.js";
import { sessionToolsOff } from "../../../../packages/shared/src/piki-extensions.js";
import type { TunnelUnavailableReason } from "../../../../packages/shared/src/tunnel.js";
import type { RepositoryPreparationView, RunnerBinding, SessionView, SudoPromptView } from "../../../../packages/shared/src/types.js";
import { sessionActivity, type ActivityEntry } from "../activity.js";
import { compactionThreshold } from "../compaction.js";
import { settleToolNames } from "../extensions/adapter.js";
import type { SessionBuiltins } from "../extensions/builtin.js";
import type { LoadedSource } from "../extensions/load.js";
import { contextTokens } from "../model-failure.js";
import { autoView, endView, entryView, refusedView } from "./entries.js";
import { holdsQueue, tellsActivity, type Branch, type Metadata, type Run } from "./state.js";

function modelFailed(entry: EntryRecord): boolean {
  return (entry.model ?? []).some(message => message.role === "assistant" && message.stopReason === "error");
}

export function activityEntry(entry: EntryRecord | undefined): ActivityEntry | undefined {
  return entry && { id: Number(entry.id), failed: modelFailed(entry) };
}

export interface ViewSource {
  binding: RunnerBinding;
  tunnel(): SessionView["tunnel"] | undefined;
  sudo?(): SudoPromptView | undefined;
  metadata(): Promise<Metadata>;
  conversation(id: number): ReturnType<Harness["conversation"]>;
  agent(): ReturnType<Conversation["agent"]>;
  context(messages: readonly Message[], model: { provider: string; modelId: string } | undefined): SessionView["context"];
  repositories(): RepositoryPreparationView | undefined;
  extensions(): Promise<Pick<SessionView, "extensions">>;
}

export async function sessionView(source: ViewSource): Promise<SessionView> {
  const tunnel = source.tunnel();
  const sudo = source.sudo?.();
  const initial = await source.metadata();
  const snapshots: { branch: Branch; entries: readonly EntryRecord[]; messages: readonly Message[] }[] = [];
  for (const branch of initial.branches.filter(item => !item.superseded)) {
    const conversation = await source.conversation(branch.id);
    if (!conversation) continue;
    const active = await conversation.context(context);
    snapshots.push({ branch, entries: active.entries, messages: active.messages });
  }
  const state = await source.metadata();
  const entries: SessionView["entries"] = [];
  for (const snapshot of snapshots) {
    let previous: Run | undefined;
    const refused = Object.values(state.runs).filter(run => run.refused && run.conversationId === snapshot.branch.id)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const refusedAt = (after: (run: Run) => boolean) => {
      for (const run of refused.filter(after)) entries.push(refusedView(run, snapshot.branch.id));
    };
    refusedAt(run => !snapshot.entries.some(entry => entry.id <= run.startEntry));
    for (const entry of snapshot.entries) {
      const run = Object.values(state.runs).filter(candidate => (candidate.started || candidate.submissionId !== undefined || candidate.status === "admitting") && candidate.conversationId === entry.conversationId && candidate.startEntry < entry.id).sort((a, b) => b.startEntry - a.startEntry)[0];
      const joins = run !== undefined && previous !== undefined && run.steered !== undefined && run.steered === (previous.steered ?? previous.key);
      const ending = run !== previous && previous && !joins && endView(previous, snapshot.branch.id);
      if (ending) entries.push(ending);
      const starts = run !== undefined && run !== previous && !joins;
      previous = run;
      entries.push(entryView(entry, snapshot.branch.id, run?.initiatedBy));
      if (starts && run.auto) entries.push(autoView(run, snapshot.branch.id));
      const next = snapshot.entries[snapshot.entries.indexOf(entry) + 1];
      refusedAt(run => run.startEntry >= entry.id && (!next || run.startEntry < next.id));
    }
    const ending = previous && endView(previous, snapshot.branch.id);
    if (ending) entries.push(ending);
  }
  const agent = await source.agent();
  const shared = snapshots.find(snapshot => snapshot.branch.mode === "write");
  const usage = shared && source.context(shared.messages, agent.model);
  const latestWrite = Object.values(state.runs).filter(run => run.mode === "write" && !run.withdrawn).sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
  const access = latestWrite && (latestWrite.options?.access === "read" ? "read" : "auto");
  const repositories = source.repositories();
  const { id, displayName, gitName, gitEmail, githubLogin } = source.binding.owner;
  return { sessionId: source.binding.session.id, owner: { id, displayName, gitName, gitEmail, githubLogin }, entries,
    approvals: [],
    conversations: state.branches.filter(branch => !branch.superseded).map(({ id, mode, actorId }) => ({ id: String(id), mode, ...(actorId ? { actorId } : {}) })),
    busy: Object.values(state.runs).some(holdsQueue)
      || Object.values(state.approvals).some(approval => approval.status === "executing") || repositories?.status === "preparing",
    queue: Object.values(state.runs).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map(run => ({ submissionId: run.key, actorId: run.initiatedBy, mode: run.mode, status: run.stopped ? (run.stopped.pending ? "stopping" : "stopped") : run.withdrawn ? "withdrawn" : run.inputsLost ? "images lost" : run.refused ? "refused" : run.status })),
    stoppable: true,
    withdrawable: true,
    rewindable: true,
    memberForks: true,
    ...(agent.model ? { agent: { provider: agent.model.provider, modelId: agent.model.modelId, thinkingLevel: agent.thinkingLevel } } : {}),
    ...(usage ? { context: usage } : {}),
    ...(access ? { access } : {}),
    ...(repositories ? { repositories } : {}),
    activity: repositories ? (repositories.status === "preparing" ? "working" : "failed")
      : sudo ? "waiting"
      : sessionActivity(Object.values(state.runs).filter(tellsActivity), Object.values(state.approvals),
        activityEntry(shared?.entries.at(-1))),
    ...await source.extensions(),
    ...(tunnel ? { tunnel } : {}),
    ...(sudo ? { sudo } : {}),
  };
}

export interface ContextViewModels {
  fallback: { provider: string; modelId: string } | undefined;
  models: Models | undefined;
  compaction(): CompactionSettings | undefined;
}

export function contextView(messages: readonly Message[], model: { provider: string; modelId: string } | undefined, source: ContextViewModels): SessionView["context"] {
  const tokens = contextTokens(messages);
  if (!Number.isFinite(tokens) || tokens < 0) return undefined;
  const current = model ?? source.fallback;
  let window: number | undefined;
  try {
    const found = current && source.models?.getModel(current.provider, current.modelId)?.contextWindow;
    window = Number.isSafeInteger(found) && found! > 0 ? found : undefined;
  }
  catch { window = undefined; }
  const compactsAt = current ? compactionThreshold(source.compaction(), current, window) : undefined;
  return { tokens, ...(window !== undefined ? { window } : {}), ...(compactsAt !== undefined ? { compactsAt } : {}) };
}

export interface ExtensionViewSource {
  binding: RunnerBinding;
  config: { workspace(workspaceId: string): Promise<WorkspaceExtensionsAnswer>; installed(): readonly LoadedSource[] } | undefined;
  builtins(): SessionBuiltins | undefined;
  hostConfig(): Promise<HostConfig>;
  requiredExtensions(): Promise<RequiredExtension[] | undefined>;
  toolNames(): string[];
  definedToolsOff(off: Set<string>, extensions: Parameters<typeof sessionToolsOff>[0]): Set<string>;
  browserUnavailable(): BrowserUnavailableReason | undefined;
  tunnelUnavailable(): TunnelUnavailableReason | undefined;
  missingPrograms(off: ReadonlySet<string>): { tool: string; source: string; programs: string[] }[];
}

export async function extensionView(source: ExtensionViewSource): Promise<Pick<SessionView, "extensions">> {
  const { binding, config } = source;
  const enabled = source.builtins() ? (await source.hostConfig().catch(() => undefined))?.builtinExtensions ?? [] : [];
  if (!config) {
    const builtin = source.builtins()?.select(enabled, new Set()).map(item => item.name) ?? [];
    return builtin.length ? { extensions: { running: [], missing: [], builtin } } : {};
  }
  try {
    const answer = await config.workspace(binding.session.workspaceId);
    const installed = config.installed().map(item => item.summary);
    const required = await source.requiredExtensions() ?? [];
    const chosen = sessionExtensions(answer.extensions, installed, { ownerId: binding.owner.id, connectorOwnerId: binding.session.connectorOwnerId }, required);
    const missingRequired = missingRequiredExtensions(required, installed);
    const settled = settleToolNames(chosen.map(item => ({ source: item.source,
      tools: installed.find(candidate => candidate.source === item.source)?.modules.flatMap(module => module.tools.map(tool => tool.name)) ?? [] })),
      source.toolNames());
    const running = chosen.map((item, index) => ({ source: item.source, dev: item.dev, tools: settled[index]!.kept, ...(item.required ? { required: true as const } : {}) }));
    const requiredPackages = new Set(required.map(item => extensionPackageKey(item.source)));
    const missing = answer.extensions.filter(item => item.enabled && !requiredPackages.has(extensionPackageKey(item.source))
      && !chosen.some(candidate => candidate.source === item.source)).map(item => item.source);
    const builtin = source.builtins()?.select(enabled, new Set(running.flatMap(item => item.tools))).map(item => item.name) ?? [];
    const off = source.definedToolsOff(sessionToolsOff(answer.extensions), answer.extensions);
    const browserReason = off.has("browser") ? undefined : source.browserUnavailable();
    const tunnelReason = off.has("tunnel") ? undefined : source.tunnelUnavailable();
    const unavailable = [...(browserReason ? [{ source: "piki:browser", tools: ["browser"], reason: browserReason }] : []),
      ...(tunnelReason ? [{ source: "piki:tunnel", tools: ["tunnel"], reason: tunnelReason }] : []),
      ...source.missingPrograms(off).map(item => ({ source: item.source, tools: [item.tool], reason: "programs", programs: item.programs }))];
    return running.length || missing.length || builtin.length || missingRequired.length || unavailable.length
      ? { extensions: { running, missing, ...(builtin.length ? { builtin } : {}), ...(missingRequired.length ? { missingRequired } : {}),
        ...(unavailable.length ? { unavailable } : {}) } } : {};
  } catch { return {}; }
}
