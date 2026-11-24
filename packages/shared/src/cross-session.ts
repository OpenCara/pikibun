import type { AccessMode, EntryView, Permission, SessionActivity, SessionRecord, SessionView, ThinkingLevel } from "./types.js";
import { placementTarget, type GpuVendor, type PlacementRequirements } from "./hardware.js";

export const sessionsToolActions = ["list", "read", "search", "ask", "send", "wait", "create", "stop", "archive"] as const;
export type SessionsToolAction = (typeof sessionsToolActions)[number];
export type SessionsBrokerAction = Exclude<SessionsToolAction, "wait">;
export const sessionsBrokerActions: readonly SessionsBrokerAction[] = ["list", "read", "search", "ask", "send", "create", "stop", "archive"];
export const sessionsWriteActions: readonly SessionsToolAction[] = ["send", "create", "stop", "archive"];

export const crossSessionLimits = {
  maxHops: 3,
  perMessage: 10,
  children: 20,
  readEntries: 50,
  defaultEntries: 20,
  entryChars: 2000,
  replyChars: 16000,
  notifyHours: 24,
  waitSeconds: 1800,
  defaultWaitSeconds: 300,
  queryChars: 200,
  searchedSessions: 30,
  searchParallel: 4,
  searchSeconds: 10,
  matchesPerSession: 5,
  defaultMatches: 20,
  snippetChars: 400,
} as const;

export interface ChildSessionSettings {
  childModels: boolean;
}

export interface CrossSessionSummary {
  id: string;
  title: string;
  ownerId: string;
  status: SessionRecord["status"];
  activity?: SessionActivity;
  permissions: Permission[];
  parentSessionId?: string;
  self?: true;
  createdAt: string;
}

export interface PlacementHostSummary {
  id: string;
  name: string;
  owner: string;
  yours?: true;
  online: boolean;
  agentMayStart: boolean;
  sandbox: "sandbox" | "unsandboxed" | "unverified";
  gpu: boolean;
  activeSessions: number;
  load: number;
  hardware?: {
    platform: string; arch: string; wsl?: true; cpus: number; cpuModel?: string; memoryGb: number; freeMemoryGb?: number; freeDiskGb?: number; load1?: number;
    gpus: { vendor: GpuVendor; name?: string; memoryGb?: number }[]; reportedAt: string;
  };
}

export interface PlacementResult {
  host: { id: string; name: string };
  conditions: string;
  load: number;
  activeSessions: number;
  qualified: number;
  considered: number;
}

export interface CrossSessionMessage {
  id: string;
  kind: "ask" | "send" | "create" | "notify";
  originSessionId: string;
  targetSessionId: string;
  actorId: string;
  submissionId: string;
  conversationId: string;
  hops: number;
  access?: AccessMode;
  notify?: "pending" | "delivered" | "failed" | "expired";
  notifyError?: string;
  replyTo?: string;
  createdAt: string;
}

export interface SessionConnections {
  parent?: CrossSessionSummary;
  children: CrossSessionSummary[];
  messages: (CrossSessionMessage & { otherTitle: string })[];
}

export interface CrossSessionOutcome {
  status: string;
  done: boolean;
  waiting?: true;
  failed?: true;
  reply?: string;
}

export interface SessionsToolRequest {
  sessionId: string;
  actorId: string;
  admissionId: string;
  callId: string;
  action: SessionsBrokerAction;
  targetSessionId?: string;
  message?: string;
  access?: AccessMode;
  notify?: boolean;
  title?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  placement?: PlacementRequirements;
  hostEnvironment?: boolean;
  messageId?: string;
  limit?: number;
  query?: string;
}

export interface SessionSearchMatch {
  entryId: string;
  role: EntryView["role"];
  text: string;
}

export interface SessionSearchResult {
  session: CrossSessionSummary;
  titleMatch?: true;
  matches: SessionSearchMatch[];
}

export interface SessionSearchSkipped {
  id: string;
  title: string;
  reason: "audience" | "unavailable";
}

export type SessionsToolResult =
  | { query: string; searched: number; results: SessionSearchResult[]; skipped?: SessionSearchSkipped[]; more?: number }
  | { sessions: CrossSessionSummary[]; models: { id: string; name: string; provider: string; modelId: string; thinkingLevels?: ThinkingLevel[]; host?: string }[];
    hosts?: PlacementHostSummary[]; childModels: boolean }
  | { session: CrossSessionSummary; busy: boolean; entries: Pick<EntryView, "id" | "role" | "kind" | "actorId" | "text" | "error">[];
    message?: CrossSessionMessage; outcome?: CrossSessionOutcome }
  | { message: CrossSessionMessage }
  | { session: CrossSessionSummary; model?: { id: string; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }; placement?: PlacementResult;
    hostEnvironment?: true; message?: CrossSessionMessage }
  | { stopped: number }
  | { archived: string }
  | { consent: "audience"; target: string; reason: string };

export function sessionsToolTarget(request: { action: SessionsToolAction; targetSessionId?: string; message?: string; access?: AccessMode; notify?: boolean;
  title?: string; modelId?: string; thinkingLevel?: string; placement?: PlacementRequirements; hostEnvironment?: boolean; messageId?: string; query?: string }): string {
  const parts: string[] = [request.action];
  if (request.targetSessionId) parts.push(`session ${request.targetSessionId}`);
  if (request.messageId) parts.push(`message ${request.messageId}`);
  if (request.query !== undefined) parts.push(`query ${JSON.stringify(oneLine(request.query))}`);
  if (request.title !== undefined) parts.push(`title ${JSON.stringify(request.title)}`);
  if (request.modelId) parts.push(`model ${request.modelId}`);
  if (request.thinkingLevel) parts.push(`thinking ${request.thinkingLevel}`);
  if (request.placement) parts.push(`placement ${placementTarget(request.placement)}`);
  if (request.hostEnvironment) parts.push("directly on the host, without the sandbox");
  if (request.access) parts.push(`access ${request.access}`);
  if (request.notify) parts.push("notify");
  const head = parts.join(" · ");
  if (request.message !== undefined) return `${head} · message:\n${cut(request.message, 7000 - head.length)}`;
  return head;
}

export function audienceTarget(target: { id: string; title: string }): string {
  return `exchange content with session ${target.id} ("${oneLine(target.title)}"), which not all the same people can read`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[[\]]/g, "").slice(0, 120);
}

export function crossSessionHeader(message: { id: string; kind: CrossSessionMessage["kind"]; hops: number },
  origin: { id: string; title: string }, actor: { id: string; login?: string | null }, replyTo?: { id: string }): string {
  const by = actor.login ? `@${actor.login}` : actor.id;
  if (message.kind === "notify") {
    return `[Pikibun notification xs:${message.id} · session "${oneLine(origin.title)}" (${origin.id}) finished message xs:${replyTo?.id ?? "?"} · for ${by} · hop ${message.hops}]`;
  }
  const what = message.kind === "ask" ? "side ask" : message.kind === "create" ? "opening message" : "message";
  return `[Pikibun cross-session ${what} xs:${message.id} · from session "${oneLine(origin.title)}" (${origin.id}) · sent by ${by} through its agent · hop ${message.hops}]`;
}

const doneStatuses = new Set(["settled", "interrupted", "stopped", "images lost", "refused", "command"]);

export function messageOutcome(view: Pick<SessionView, "entries" | "queue">, message: Pick<CrossSessionMessage, "id" | "submissionId" | "conversationId">): CrossSessionOutcome {
  const queued = view.queue?.find(item => item.submissionId === message.submissionId);
  const status = queued?.status ?? "unknown";
  const entries = view.entries.filter(entry => entry.conversationId === message.conversationId);
  const marker = `xs:${message.id} `;
  const start = entries.findIndex(entry => entry.role === "user" && entry.text.includes(marker));
  const after: EntryView[] = [];
  if (start >= 0) {
    for (const entry of entries.slice(start + 1)) {
      if (entry.role === "user") break;
      after.push(entry);
    }
  }
  const answers = after.filter(entry => entry.role === "assistant" && !entry.error && entry.text.trim());
  const failed = after.some(entry => entry.error !== undefined);
  const done = doneStatuses.has(status)
    || (status === "unknown" && answers.length > 0 && after.at(-1) === answers.at(-1));
  const last = answers.at(-1)?.text;
  return { status, done, ...(failed ? { failed: true as const } : {}),
    ...(last !== undefined ? { reply: cut(last, crossSessionLimits.replyChars) } : {}) };
}

export function searchTerms(query: string): string[] {
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map(match => match[1]!.trim().toLowerCase()).filter(Boolean);
  const rest = query.replace(/"[^"]*"/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set([...quoted, ...rest])].slice(0, 16);
}

export function matchesTerms(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return false;
  const lower = text.toLowerCase();
  return terms.every(term => lower.includes(term));
}

export function searchSnippet(text: string, terms: readonly string[], max: number = crossSessionLimits.snippetChars): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0), flat.length);
  const start = Math.max(0, Math.min(at - Math.floor(max / 4), flat.length - max));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + max)}${start + max < flat.length ? "…" : ""}`;
}

export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… ${value.length - max} more characters`;
}
