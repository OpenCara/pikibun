import type { AccessMode, EntryView, Permission, SessionActivity, SessionRecord, SessionView, ThinkingLevel } from "./types.js";

export const sessionsToolActions = ["list", "read", "ask", "send", "wait", "create", "stop", "archive"] as const;
export type SessionsToolAction = (typeof sessionsToolActions)[number];
export type SessionsBrokerAction = Exclude<SessionsToolAction, "wait">;
export const sessionsBrokerActions: readonly SessionsBrokerAction[] = ["list", "read", "ask", "send", "create", "stop", "archive"];
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
  visibility: "private" | "workspace";
  permissions: Permission[];
  parentSessionId?: string;
  self?: true;
  createdAt: string;
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
  visibility?: "private" | "workspace";
  messageId?: string;
  limit?: number;
}

export type SessionsToolResult =
  | { sessions: CrossSessionSummary[]; models: { id: string; name: string; provider: string; modelId: string; thinkingLevels?: ThinkingLevel[] }[]; childModels: boolean }
  | { session: CrossSessionSummary; busy: boolean; entries: Pick<EntryView, "id" | "role" | "kind" | "actorId" | "text" | "error">[];
    pendingApprovals: { id: string; kind: string; tool?: string; requestedBy: string }[]; message?: CrossSessionMessage; outcome?: CrossSessionOutcome }
  | { message: CrossSessionMessage }
  | { session: CrossSessionSummary; model?: { id: string; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }; message?: CrossSessionMessage }
  | { stopped: number }
  | { archived: string }
  | { consent: "audience"; target: string; reason: string };

export function sessionsToolTarget(request: { action: SessionsToolAction; targetSessionId?: string; message?: string; access?: AccessMode; notify?: boolean;
  title?: string; modelId?: string; thinkingLevel?: string; visibility?: string; messageId?: string }): string {
  const parts: string[] = [request.action];
  if (request.targetSessionId) parts.push(`session ${request.targetSessionId}`);
  if (request.messageId) parts.push(`message ${request.messageId}`);
  if (request.title !== undefined) parts.push(`title ${JSON.stringify(request.title)}`);
  if (request.modelId) parts.push(`model ${request.modelId}`);
  if (request.thinkingLevel) parts.push(`thinking ${request.thinkingLevel}`);
  if (request.visibility) parts.push(`visibility ${request.visibility}`);
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

const doneStatuses = new Set(["settled", "interrupted", "stopped", "images lost", "refused"]);

export function messageOutcome(view: Pick<SessionView, "entries" | "queue" | "approvals">, message: Pick<CrossSessionMessage, "id" | "submissionId" | "conversationId">): CrossSessionOutcome {
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
  const pendingCard = view.approvals.some(approval => approval.status === "pending");
  const done = doneStatuses.has(status)
    || (status === "unknown" && answers.length > 0 && after.at(-1) === answers.at(-1) && !pendingCard);
  const last = answers.at(-1)?.text;
  const waiting = !done && pendingCard;
  return { status, done, ...(waiting ? { waiting: true as const } : {}), ...(failed ? { failed: true as const } : {}),
    ...(last !== undefined ? { reply: cut(last, crossSessionLimits.replyChars) } : {}) };
}

export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… ${value.length - max} more characters`;
}
