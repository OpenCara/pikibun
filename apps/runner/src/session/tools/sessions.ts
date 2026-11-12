import { setTimeout as sleep } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { crossSessionLimits, sessionsToolActions, sessionsWriteActions, type SessionsToolRequest, type SessionsToolResult } from "../../../../../packages/shared/src/cross-session.js";
import { accessModes, thinkingLevels } from "../../../../../packages/shared/src/types.js";
import { RunnerError } from "../../protocol.js";
import { text, type ToolContext } from "./context.js";

const WAIT_POLL_MS = 3000;
const SESSIONS_TOOL_DESCRIPTION = "Work with this workspace's other Pikibun sessions, as the person whose message you are working on, with exactly their permissions in each session. "
  + "action list: the sessions they can see (id, title, status, activity, their permissions, parent), the models create can use, with the thinking levels each offers, and whether this workspace lets create choose them (childModels). "
  + "read {session, limit?, message_id?}: a session's latest shared-conversation entries (a failed model turn with why, as far as the host tells); with message_id, also the outcome of a message this session sent it (status, done, reply). "
  + "ask {session, message, notify?}: a read-only side question to that session's agent. "
  + "send {session, message, access?, notify?}: a message to that session's agent, as if typed in its chat (access read: inspect only; left out, it acts as that session's tools allow); refused while it is busy. "
  + "wait {session, message_id, timeout_seconds?}: block until a message this session sent finishes (default 300 seconds), then return its outcome and reply. "
  + "create {message?, title?, model?, thinking?, visibility?, access?, notify?}: start a new session for a sub-task, as the same person, and send it message. Where childModels allows, pick the model (one list returns) and thinking level (for its opening message, which its conversation keeps) to suit the sub-task: a capable model with more thinking for hard work, a fast one with less for simple work; what you leave out, and everything where childModels is off, is this session's current model and thinking level. "
  + "stop {session}: stop that session's current work. archive {session}: archive a session they own or, as the workspace's owner or an admin, any of its sessions. "
  + "With notify, Pikibun sends this session the outcome as a new message once the other session finishes. Delivered messages start with a line naming this session and the sender; "
  + "chains of messages stop after 3 hops and never loop back to a session they came from. "
  + "Involve other sessions only when the user asked for it or clearly expects it.";

export function sessionsTool(context: ToolContext): ToolRegistration {
  const { binding, calls, config } = context;
  return defineTool({ name: "sessions", description: SESSIONS_TOOL_DESCRIPTION,
    executionMode: "sequential", parameters: obj({
    action: StringEnum(sessionsToolActions), session: opt(str()), message: opt(str()),
    access: opt(StringEnum(accessModes)), notify: opt(bool()), title: opt(str()), model: opt(str()),
    thinking: opt(StringEnum(thinkingLevels)), visibility: opt(StringEnum(["private", "workspace"] as const)), message_id: opt(str()),
    limit: opt(int({ minimum: 1, maximum: crossSessionLimits.readEntries })),
    timeout_seconds: opt(int({ minimum: 1, maximum: crossSessionLimits.waitSeconds })),
  }, { open: true }), execute: async (args, api, call) => {
    await context.requireSessionTool("sessions");
    const attribution = await calls.actor(api, true);
    const fields = Object.fromEntries(Object.entries({ targetSessionId: args.session, message: args.message, access: args.access, notify: args.notify, title: args.title,
      modelId: args.model, thinkingLevel: args.thinking, visibility: args.visibility, messageId: args.message_id, limit: args.limit }).filter(([, value]) => value !== undefined)) as
      Omit<SessionsToolRequest, "sessionId" | "actorId" | "admissionId" | "callId" | "action">;
    if (Object.values(fields).some(value => typeof value === "string" && value.includes("\0"))) throw new RunnerError(400, "Sessions tool fields must not contain NUL characters");
    const wait = args.action === "wait";
    if (wait && (fields.targetSessionId === undefined || fields.messageId === undefined)) throw new RunnerError(400, "wait takes session and message_id, as ask, send or create returned them");
    if (!wait && args.timeout_seconds !== undefined) throw new RunnerError(400, "Only wait takes timeout_seconds");
    const state = await context.metadata();
    const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
    if (!run.admissionId) throw new RunnerError(403, "The sessions tool needs a write message");
    const request = { action: wait ? "read" as const : args.action as Exclude<typeof args.action, "wait">, ...(wait ? { targetSessionId: fields.targetSessionId, messageId: fields.messageId, limit: 1 } : fields) };
    await calls.check(api, "sessions", { write: sessionsWriteActions.includes(args.action) });
    await context.authorize(run.initiatedBy, "write");
    const base = { sessionId: binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId) };
    const broker = async (): Promise<SessionsToolResult> => {
      const result = config.crossSessions ? await config.crossSessions({ ...base, ...request }) : await context.operations.internalBroker("sessions", { ...base, ...request }) as SessionsToolResult;
      if (!("consent" in result)) return result;
      throw new RunnerError(403, `${result.reason} The session's owner can let content pass between sessions whose readers differ under the session's Details. Nothing was sent or read.`);
    };
    if (!wait) return text({ ...attribution, ...await broker() });
    const deadline = Date.now() + (args.timeout_seconds ?? crossSessionLimits.defaultWaitSeconds) * 1000;
    for (;;) {
      const result = await broker();
      const done = "outcome" in result && result.outcome?.done === true;
      if (done || Date.now() + WAIT_POLL_MS > deadline) {
        const { entries: _entries, ...shown } = result as Extract<SessionsToolResult, { entries: unknown }>;
        return text({ ...attribution, ...shown, ...(done ? {} : { timedOut: true }) });
      }
      await sleep(WAIT_POLL_MS, undefined, { signal: call.abortSignal });
    }
  } });
}
