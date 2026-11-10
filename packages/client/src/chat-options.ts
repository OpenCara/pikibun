import type { ConnectorInfo, LocalModelSummary } from "../../shared/src/connector";
import type {} from "../../shared/src/host-operations";
import { mayAutoApprove } from "../../shared/src/policy";
import { thinkingLevels, type AccessMode, type ChatOptions, type SessionRecord, type SessionView, type ThinkingLevel, type WorkspaceRole } from "../../shared/src/types";

export interface ChatSelection {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  access: AccessMode;
}

export const levelLabels: Record<ThinkingLevel, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

export const accessLabels: Record<AccessMode, { label: string; hint: string }> = {
  read: { label: "Read only", hint: "Inspect files; edits, commands and commits ask the session owner first" },
  approval: { label: "Ask before acting", hint: "Edits are automatic; commands, commits, GitHub comments and merges need approval" },
  auto: { label: "Auto-approve", hint: "Commands, commits, pushes, GitHub comments, issues and merges run immediately as the owner, without asking" },
};

export const memberAutoApproveHint = "Commands in the sandbox run immediately as the session owner, without asking; pushes, GitHub comments, merges and host commands still ask";

export function accessHint(mode: AccessMode, owner: boolean): string {
  return mode === "auto" && !owner ? memberAutoApproveHint : accessLabels[mode].hint;
}

export function offersMemberAutoApprove(session: Pick<SessionRecord, "ownerId">, host: Pick<ConnectorInfo, "capabilities"> | undefined, userId: string,
  role: WorkspaceRole | undefined, canWrite: boolean, unsandboxed: boolean): boolean {
  return session.ownerId !== userId && canWrite && !unsandboxed && mayAutoApprove(userId, session.ownerId, role) && host?.capabilities.memberAutoApprove === true;
}

export function memberAutoApproveWarning(host: Pick<ConnectorInfo, "name">): string {
  return `Commands the agent runs in the sandbox for your messages (bash, git, node, python, cargo and the browser) will run immediately on ${host.name}, `
    + "as the session's owner and with their access to the workspace's repositories, without asking them. Pushes, GitHub comments, issues and merges, "
    + "host commands, commands without resource limits, and tools the session doesn't allow yet still need approval.";
}

export function autoApproveMerges(host: Pick<ConnectorInfo, "capabilities"> | undefined): boolean {
  return host?.capabilities.automaticGitHub === true;
}

export function autoApproveWarning(host: Pick<ConnectorInfo, "name" | "capabilities" | "hostCommandAccess">, unsandboxed: boolean): string {
  const github = autoApproveMerges(host)
    ? " GitHub comments and new issues are posted, and pull requests merged, as you without asking too: the agent can merge any pull request of this workspace's github.com repositories that GitHub lets you merge, into its base branch. Branch protection and required checks on GitHub still apply."
    : " GitHub comments and merges still need approval.";
  return (unsandboxed
    ? `Commands, commits and pushes the agent writes will run immediately on ${host.name}, an UNSANDBOXED host: commands run directly on the owner's machine with their full user permissions and network access, and no resource limits. Tools outside the agent won't ask either.`
    : "Commands, commits and pushes the agent writes will run immediately as you, without asking, as will tools outside the agent and commands on a host without resource limits.")
    + github + hostCommandsWarning(host);
}

function hostCommandsWarning(host: Pick<ConnectorInfo, "name" | "capabilities" | "hostCommandAccess">): string {
  if (!host.capabilities.hostCommands) return "";
  if (host.hostCommandAccess === "auto") {
    return ` Its owner granted you automatic host commands, so host commands, such as its extensions' tools, also run OUTSIDE the sandbox on ${host.name} without asking, with access to the owner's host files, credentials and network.`;
  }
  if (host.hostCommandAccess === "owner" || !host.capabilities.hostGrants) {
    return " On your own host, host commands, such as its extensions' tools, also run OUTSIDE the sandbox without asking, with access to your host files, credentials and network. On someone else's host they still need their approval.";
  }
  return " On your own host, or one whose owner granted you automatic host commands, host commands, such as its extensions' tools, also run OUTSIDE the sandbox without asking, with access to that host's files, credentials and network. Elsewhere they still need approval.";
}

export const CONNECTOR_UPDATE_HINT = "Update the host's connector (npx pikibun@latest connect) to choose model, reasoning and access";

export const modelKey = (model: { provider: string; modelId: string }) => `${model.provider}\n${model.modelId}`;

export function findModel(host: ConnectorInfo | undefined, model: ChatSelection["model"]): LocalModelSummary | undefined {
  return model && host?.models.find(item => item.provider === model.provider && item.modelId === model.modelId);
}

export function offeredLevels(model: LocalModelSummary | undefined): ThinkingLevel[] {
  const levels = model?.thinkingLevels ?? [];
  return levels.some(level => level !== "off") ? levels : [];
}

export function clampLevel(levels: ThinkingLevel[] | undefined, level: ThinkingLevel | undefined): ThinkingLevel | undefined {
  if (!level || !levels?.length || levels.includes(level)) return level;
  const rank = thinkingLevels.indexOf(level);
  const lower = levels.filter(item => thinkingLevels.indexOf(item) <= rank).sort((a, b) => thinkingLevels.indexOf(b) - thinkingLevels.indexOf(a))[0];
  return lower ?? (levels.includes("off") ? "off" : levels[0]);
}

export function effectiveLevel(model: LocalModelSummary | undefined, level: ThinkingLevel | undefined): ThinkingLevel | undefined {
  const levels = model?.thinkingLevels;
  if (!model || !levels?.length) return undefined;
  if (level && levels.includes(level)) return level;
  if (model.thinkingLevel && levels.includes(model.thinkingLevel)) return model.thinkingLevel;
  return clampLevel(levels, level);
}

export function selectModel(selection: ChatSelection, next: LocalModelSummary): ChatSelection {
  return { ...selection, model: { provider: next.provider, modelId: next.modelId }, thinkingLevel: next.thinkingLevel ?? clampLevel(next.thinkingLevels, selection.thinkingLevel) };
}

export interface ChatPreference {
  connectorId: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

export function chatPreference(
  host: ConnectorInfo | undefined,
  selection: ChatSelection,
  current?: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel },
): ChatPreference | undefined {
  const model = host?.capabilities.chatOptions ? findModel(host, selection.model ?? current) : undefined;
  if (!host || !model) return undefined;
  const thinkingLevel = effectiveLevel(model, selection.thinkingLevel ?? (selection.model ? undefined : current?.thinkingLevel));
  return { connectorId: host.id, provider: model.provider, modelId: model.modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

export function parseChatPreference(raw: string | null | undefined): ChatPreference | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ChatPreference> | null;
    if (!value || typeof value.connectorId !== "string" || typeof value.provider !== "string" || typeof value.modelId !== "string") return undefined;
    const thinkingLevel = (thinkingLevels as readonly string[]).includes(value.thinkingLevel as string) ? value.thinkingLevel : undefined;
    return { connectorId: value.connectorId, provider: value.provider, modelId: value.modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
  } catch {
    return undefined;
  }
}

export function preferredSelection(
  host: ConnectorInfo | undefined,
  preference: ChatPreference | undefined,
  fallback: { provider: string; modelId: string } | undefined,
  usable: (model: { provider: string; modelId: string }) => boolean = () => true,
): ChatSelection {
  const remembered = preference && findModel(host, preference);
  const model = remembered && usable(remembered) ? remembered : findModel(host, fallback);
  if (!model) return { access: "auto" };
  const thinkingLevel = model.thinkingLevels?.length ? effectiveLevel(model, preference?.thinkingLevel) : model.thinkingLevel;
  return { model: { provider: model.provider, modelId: model.modelId }, thinkingLevel, access: "auto" };
}

export interface AccessContext {
  /** The session's commands run in the host's sandbox (not an unsandboxed host, nor a session run directly on it). */
  sandboxed?: boolean;
  /** The viewer, who doesn't own the session, may auto-approve their own messages there (offersMemberAutoApprove). */
  memberAutoApprove?: boolean;
}

/**
 * The access a session's chat box starts on. A sandboxed session starts on Auto-approve for anyone who may use it there, its
 * owner or a member offered it, whoever started the session (a person, another member or an agent) and whatever its last
 * message used, except a Read-only one, which stays Read-only. Elsewhere it starts on Auto-approve for the owner before the
 * first message, then keeps the last message's access.
 */
export function defaultAccess(view: Pick<SessionView, "access" | "entries">, owner: boolean, context: AccessContext = {}): AccessMode {
  const mayAuto = owner || context.memberAutoApprove === true;
  if (context.sandboxed && mayAuto && view.access !== "read") return "auto";
  const fresh = !view.entries?.some(entry => entry.role === "user");
  const access = view.access ?? (owner && fresh ? "auto" : "approval");
  return access === "auto" && !mayAuto ? "approval" : access;
}

export function initialSelection(view: SessionView, owner: boolean, context: AccessContext = {}): ChatSelection {
  return {
    model: view.agent && { provider: view.agent.provider, modelId: view.agent.modelId },
    thinkingLevel: view.agent?.thinkingLevel,
    access: defaultAccess(view, owner, context),
  };
}

export function accessUnavailable(host: ConnectorInfo | undefined, selection: ChatSelection, mode: "submit" | "ask"): string | undefined {
  if (mode !== "submit" || host || selection.access === "approval") return undefined;
  return `Still checking this session's host, so "${accessLabels[selection.access].label}" can't be applied yet. Try again in a moment.`;
}

export function modelUnavailable(host: ConnectorInfo | undefined, selection: ChatSelection): string | undefined {
  if (!host?.capabilities.chatOptions) return undefined;
  if (!host.models.length) return `${host.name} offers no models right now.`;
  if (selection.model && !findModel(host, selection.model)) return `${host.name} no longer offers ${selection.model.modelId}. Choose another model.`;
  return undefined;
}

export function chatOptionsBody(host: ConnectorInfo | undefined, selection: ChatSelection, mode: "submit" | "ask", owner = true): ChatOptions | undefined {
  if (!host?.capabilities.chatOptions) return undefined;
  const model = findModel(host, selection.model);
  const options: ChatOptions = {};
  if (model) options.model = { provider: model.provider, modelId: model.modelId };
  const thinkingLevel = effectiveLevel(model, selection.thinkingLevel);
  if (thinkingLevel) options.thinkingLevel = thinkingLevel;
  if (mode === "submit") options.access = selection.access;
  if (mode === "submit" && selection.access === "auto" && owner && autoApproveMerges(host)) options.autoMerge = true;
  return options;
}

export const AUTO_APPROVE_CONFIRMED_KEY = "pikibun.autoApproveConfirmed";

export function mustConfirmAutoApprove(options: ChatOptions | undefined, confirmed: boolean): boolean {
  return options?.autoMerge === true && !confirmed;
}
