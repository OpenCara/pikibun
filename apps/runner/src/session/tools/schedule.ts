import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { accessModes, scheduleRunIns, scheduleToolActions, type ScheduleToolRequest, type ScheduleToolResult } from "../../../../../packages/shared/src/types.js";
import { RunnerError } from "../../protocol.js";
import { text, type ToolContext } from "./context.js";

export function scheduleTool(context: ToolContext): ToolRegistration {
  const { binding, calls, config } = context;
  return defineTool({ name: "schedule", description: "Manage this session's scheduled prompts: messages Pikibun sends this session's agent on a cron schedule, as the session owner, so the session wakes up and works on its own (a nightly check, a weekly report). Use it when the user asks to do something every hour, day or week, or at a later time. action list takes nothing; create takes message (what the agent is told each time) and cron (five fields: minute hour day-of-month month day-of-week, such as '0 9 * * 1-5'; runs at least 5 minutes apart), and optionally name, time_zone (IANA, such as Europe/Berlin; UTC otherwise, so ask the user for theirs when the time of day matters), access (auto, the default: each run acts with the session's tools; read: each run only inspects), run_in (session, the default: each run prompts this session's agent, and is skipped while it is busy; child: each run starts a new session under this one, on its model and host, with the message as its opening message, so this session is never prompted and its own work goes on), one_shot (for child runs: true, the default, archives each child once its run is done, unless someone sent it a message of their own; false keeps it open) and enabled; update takes id and only the fields to change; delete takes id. Only the session owner's messages can use it. A run due while the agent is busy is skipped, unless it runs in a child session. The owner sees and edits them in the session panel's Schedules tab.", parameters: obj({
    action: StringEnum(scheduleToolActions), id: opt(str()), message: opt(str()), cron: opt(str()),
    time_zone: opt(str()), name: opt(str()), access: opt(StringEnum(accessModes)), run_in: opt(StringEnum(scheduleRunIns)), one_shot: opt(bool()), enabled: opt(bool()),
  }, { open: true }), execute: async (args, api, _call) => {
    await context.requireSessionTool("schedule");
    const attribution = await calls.actor(api, true);
    const fields = Object.fromEntries(Object.entries({ scheduleId: args.id, name: args.name, cron: args.cron, timeZone: args.time_zone, content: args.message,
      access: args.access, runIn: args.run_in, oneShot: args.one_shot, enabled: args.enabled }).filter(([, value]) => value !== undefined)) as Omit<ScheduleToolRequest, "sessionId" | "actorId" | "admissionId" | "callId" | "action">;
    if (Object.values(fields).some(value => typeof value === "string" && value.includes("\0"))) throw new RunnerError(400, "Schedule fields must not contain NUL characters");
    const state = await context.metadata();
    const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
    if (run.initiatedBy !== binding.owner.id) throw new RunnerError(403, "Only the session owner's messages schedule prompts. Ask the owner to send this request, or to add it in the Schedules tab.");
    if (!run.admissionId) throw new RunnerError(403, "Scheduling needs a write message");
    await calls.check(api, "schedule", { write: args.action !== "list" });
    await context.authorize(run.initiatedBy, "write");
    const request: ScheduleToolRequest = { sessionId: binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId),
      action: args.action, ...fields };
    const result = config.schedules ? await config.schedules(request) : await context.operations.internalBroker("schedules", request) as ScheduleToolResult;
    return text({ ...attribution, ...result });
  } });
}
