import { computed, signal, untracked, View } from "nsh";
import { thinkingLevels, type AccessMode, type Schedule, type ScheduleModelChoice, type ThinkingLevel } from "../../../../packages/shared/src/types";
import { CronError, isTimeZone, MIN_CRON_INTERVAL_MINUTES, nextCronTime, parseCron } from "../../../../packages/shared/src/cron";
import { levelLabels, offeredLevels } from "../shared";
import { timestamp } from "../lib/format";
import { createAction } from "../lib/resource";
import { Icon } from "../icons";
import { palette } from "../theme";
import { Checkbox, Field, Select, TextField } from "../form";
import { Badge, Button, CardBody, Feedback, IconButton, Note, Row, Section, Small } from "../ui";
import { Card } from "../settings/accounts";

export type ScheduleKind = "session" | "workspace";

const presets: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { label: "First of the month at 09:00", cron: "0 9 1 * *" },
];
const accessLabels: Record<AccessMode, string> = { read: "Read only", approval: "Act", auto: "Act" };
const accessHints: Record<ScheduleKind, Record<AccessMode, string>> = {
  session: {
    read: "The agent can look, but changes nothing",
    approval: "The agent runs the session's tools, as your tool group allows. Nobody may be watching when it runs",
    auto: "The agent runs the session's tools, as your tool group allows. Nobody may be watching when it runs",
  },
  workspace: {
    read: "Each new session's agent can look, but changes nothing",
    approval: "Each new session's agent runs its tools, as your tool group allows. Nobody may be watching when it runs",
    auto: "Each new session's agent runs its tools, as your tool group allows. Nobody may be watching when it runs",
  },
};
const errorLabels: Record<string, string> = {
  session_busy: "Skipped: the agent was busy",
  too_many_sessions: "Skipped: too many of the sessions its owner's schedules started are still open. Archive some",
  too_many_children: "Skipped: too many of the sessions its schedules started are still open. Archive some",
  connector_offline: "The host was offline",
  connector_unavailable: "The host was unavailable",
  connector_relay_error: "The host didn't answer",
  child_models_disabled: "Started a new session on the model of the session it was made from: the workspace no longer lets agents choose one",
  thinking_unsupported: "Started a new session without the schedule's reasoning level: its model no longer runs at it",
  forbidden: "Its owner no longer has write access",
  session_frozen: "The session runs nothing",
};

function errorText(schedule: Schedule): string {
  const error = schedule.lastError!;
  if (error === "owner_unavailable") {
    return schedule.runIn === "child" ? "Paused: its owner may no longer start sessions in this workspace. An owner or admin can take it over"
      : "Paused: its owner may no longer write to this session. The session owner, or a workspace owner or admin, can take it over";
  }
  if (error === "model_unavailable") {
    return schedule.lastSessionId ? "Started a new session on the model of the session it was made from: the schedule's model is no longer available"
      : "Nothing ran: the schedule's model is no longer available. Choose another";
  }
  return errorLabels[error] ?? error;
}

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
function untilText(value: string): string {
  const seconds = Math.max(0, (new Date(value).getTime() - Date.now()) / 1000);
  if (seconds < 60) return "in under a minute";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86400)}d`;
}
function modelText(schedule: Schedule, models: ScheduleModelChoice[] | undefined): string {
  if (schedule.runIn !== "child") return "";
  const model = schedule.modelId ? models ? models.find(item => item.id === schedule.modelId)?.name ?? "an unavailable model" : "a model of its own"
    : "its session's model";
  const level = schedule.thinkingLevel ? `${levelLabels[schedule.thinkingLevel]} reasoning` : "";
  return ` · on ${[model, level].filter(Boolean).join(", ")}`;
}
function preview(cron: string, timeZone: string): { runs: string[] } | { error: string; field: "cron" | "timeZone" } {
  if (!isTimeZone(timeZone)) return { error: "Unknown time zone.", field: "timeZone" };
  try {
    const schedule = parseCron(cron);
    const runs: string[] = [];
    let after = Date.now();
    for (let index = 0; index < 3; index++) {
      const next = nextCronTime(schedule, timeZone, after);
      if (next === null) break;
      runs.push(new Date(next).toISOString());
      after = next;
    }
    return runs.length ? { runs } : { error: "This schedule never comes round.", field: "cron" };
  } catch (error) {
    return { error: error instanceof CronError ? error.message : "Invalid schedule.", field: "cron" };
  }
}

export function scheduleHint(schedule: Schedule, models?: ScheduleModelChoice[], showOwner = false): string {
  const parts = [schedule.cron, schedule.timeZone, accessLabels[schedule.access]];
  if (schedule.runIn === "child") parts.push(schedule.oneShot === false ? "each session kept open" : "each session archived when done");
  return `${parts.join(" · ")}${modelText(schedule, models)}${showOwner ? ` · runs as ${schedule.ownerName ?? "its owner"}` : ""}`;
}

export function ScheduleCard(props: {
  schedule: Schedule; models?: ScheduleModelChoice[]; manage: boolean; busy: boolean; showOwner?: boolean;
  onToggle: () => void; onRunNow: () => void; onEdit: () => void; onDelete: () => void; onOpenSession?: (sessionId: string) => void;
}) {
  const schedule = () => props.schedule;
  return (
    <Card testID={`schedule-${schedule().id}`}>
      <Row leading={<Icon name="clock" size={16} color={palette().muted} />} title={schedule().name} hint={scheduleHint(schedule(), props.models, props.showOwner)}
        trailing={schedule().enabled ? schedule().nextRunAt ? <Badge tone="info">{`Next ${untilText(schedule().nextRunAt!)}`}</Badge> : <Badge tone="warning">Never runs</Badge>
          : <Badge>Paused</Badge>} />
      <CardBody>
        <Small>
          {`${schedule().enabled && schedule().nextRunAt ? `Next run ${timestamp(schedule().nextRunAt!)}. ` : ""}${schedule().lastRunAt
            ? `Last run ${timestamp(schedule().lastRunAt!)}${schedule().lastError ? `: ${errorText(schedule())}`
              : schedule().lastSessionId ? " started a new session" : " sent its message"}.`
            : "Hasn't run yet."}`}
        </Small>
        <If when={props.onOpenSession && schedule().lastSessionId}>
          {started => <View style={{ flexDirection: "row" }}>
            <Button small variant="outline" icon="chevron-right" label="Open last session" testID={`schedule-last-session-${schedule().id}`}
              onPress={() => props.onOpenSession!(started() as string)} />
          </View>}
        </If>
        <If when={props.manage}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button small variant="outline" label={schedule().enabled ? "Pause" : "Resume"} disabled={props.busy} onPress={props.onToggle} />
            <Button small variant="ghost" label="Run now" disabled={props.busy} onPress={props.onRunNow} />
            <Button small variant="ghost" icon="pencil" label="Edit" disabled={props.busy} onPress={props.onEdit} />
            <IconButton icon="trash" label={`Delete ${schedule().name}`} disabled={props.busy} onPress={props.onDelete} />
          </View>
        </If>
      </CardBody>
    </Card>
  );
}

export function ScheduleForm(props: {
  kind: ScheduleKind; schedule: Schedule | null; userId: string; canSave: boolean; models?: ScheduleModelChoice[];
  save: (body: Record<string, unknown>, existing: Schedule | null) => Promise<void>; onDone: (saved: boolean) => void;
}) {
  const existing = untracked(() => props.schedule);
  const form = createAction();
  const name = signal(existing?.name ?? "");
  const cron = signal(existing?.cron ?? "0 9 * * 1-5");
  const timeZone = signal(existing?.timeZone ?? localTimeZone());
  const content = signal(existing?.content ?? "");
  const access = signal<AccessMode>(existing?.access === "read" ? "read" : "auto");
  const oneShot = signal<boolean>(existing?.oneShot ?? true);
  const modelId = signal(existing?.modelId ?? "");
  const thinking = signal<ThinkingLevel | "">(existing?.thinkingLevel ?? "");
  const trusted = signal(false);
  const workspace = props.kind === "workspace";
  const models = () => props.models ?? [];
  const takesOver = Boolean(existing && existing.ownerId !== props.userId);
  const fromSession = Boolean(existing?.originSessionId) && existing?.originOwnerId === (takesOver ? props.userId : existing?.ownerId);
  const losesSessionModel = workspace && Boolean(existing?.originSessionId && !existing.modelId) && !fromSession;
  const chosenModel = () => models().find(item => item.id === modelId());
  const levels = (): ThinkingLevel[] => modelId() ? offeredLevels(chosenModel()) : fromSession ? [...thinkingLevels] : [];
  const trustNeeded = () => workspace && Boolean(chosenModel()?.foreignHost) && (!existing || takesOver || modelId() !== (existing.modelId ?? ""));
  function chooseModel(value: string) {
    modelId.set(value);
    trusted.set(false);
    const level = thinking();
    if (level && !levels().includes(level)) thinking.set("");
  }
  const next = computed(() => preview(cron(), timeZone()));
  const preset = () => presets.find(item => item.cron === cron().trim())?.cron ?? "";
  const modelReady = () => !workspace || Boolean(modelId()) || fromSession;
  const ready = () => props.canSave && content().trim().length > 0 && "runs" in next() && modelReady() && (!trustNeeded() || trusted());
  const changed = (key: "modelId" | "thinkingLevel", value: string, before: string) => value === before ? {} : { [key]: value || null };
  function save() {
    if (!ready() || form.busy()) return;
    void form.run(async () => {
      const body: Record<string, unknown> = { name: name().trim(), cron: cron(), timeZone: timeZone(), content: content(), access: access(),
        ...(workspace ? { oneShot: oneShot(), ...changed("modelId", modelId(), existing?.modelId ?? ""), ...changed("thinkingLevel", thinking(), existing?.thinkingLevel ?? ""),
          ...(trustNeeded() && chosenModel()?.host ? { trustedConnectorId: chosenModel()!.host } : {}) } : {}) };
      if (existing && !body.name) body.name = existing.name;
      await props.save(body, existing);
      props.onDone(true);
    });
  }
  const fieldError = (field: "cron" | "timeZone") => { const value = next(); return "error" in value && value.field === field ? value.error : undefined; };
  return (
    <Section title={existing ? "Edit scheduled prompt" : workspace ? "New schedule" : "New scheduled prompt"} testID="schedule-form">
      <CardBody>
        <If when={takesOver}>
          <Note testID="schedule-takeover">{`This schedule runs as ${existing?.ownerName ?? "someone else"}. Saving a change makes it yours: from then on it runs as you, with your access. Pausing or resuming it doesn't.${
            losesSessionModel ? " It runs on the model of the session it was made from, which isn't yours: choose a model for it." : ""}`}</Note>
        </If>
        <Field label="Message" hint={workspace ? "Opens a new session, as the schedule's owner, each time it runs" : "Sent to the agent as you, as if you typed it in the chat box"}>
          <TextField testID="schedule-content" multiline value={content()} onChange={value => content.set(value)} disabled={form.busy()} autoFocus={!existing}
            placeholder="Pull main, run the tests and summarise any failures" />
        </Field>
        <Field label="Name" hint="Optional; the message's first line otherwise">
          <TextField value={name()} onChange={value => name.set(value)} maxLength={100} disabled={form.busy()} placeholder="Nightly test run" />
        </Field>
        <Field label="Repeat">
          <Select<string> label="Repeat" value={preset()} disabled={form.busy()} onChange={value => { if (value) cron.set(value); }}
            options={[...presets.map(item => ({ value: item.cron, label: item.label })), { value: "", label: "Custom" }]} />
        </Field>
        <Field label="Cron expression" error={fieldError("cron")}
          hint={`Minute, hour, day of month, month, day of week, as in crontab: */30 8-18 * * mon-fri. Runs at least ${MIN_CRON_INTERVAL_MINUTES} minutes apart.`}>
          <TextField monospace value={cron()} onChange={value => cron.set(value)} disabled={form.busy()} />
        </Field>
        <Field label="Time zone" hint="IANA name, such as UTC or Europe/Berlin" error={fieldError("timeZone")}>
          <TextField value={timeZone()} onChange={value => timeZone.set(value)} disabled={form.busy()} autoCapitalize="none" autoCorrect={false} />
        </Field>
        <If when={"runs" in next() ? (next() as { runs: string[] }).runs : null}>
          {runs => <Small>{`Next runs: ${runs().map(timestamp).join(", ")}`}</Small>}
        </If>
        <If when={workspace}>
          <Field label="Model" hint={modelId() ? "Each new session starts on this model, on its host" : fromSession
            ? "Each new session starts on the current model of the session this schedule was made from" : "Choose the model each new session starts on"}>
            <Select<string> label="Model" value={modelId()} disabled={form.busy()} onChange={chooseModel} testID="schedule-model" placeholder="Choose a model"
              options={[...(fromSession ? [{ value: "", label: "Its session's model" }] : []), ...models().map(item => ({ value: item.id, label: item.name, hint: item.provider })),
                ...(modelId() && !chosenModel() ? [{ value: modelId(), label: "Unavailable model" }] : [])]} />
          </Field>
          <If when={trustNeeded()}>
            <Checkbox testID="schedule-trust" checked={trusted()} onChange={value => trusted.set(value)} disabled={form.busy()}
              label="Trust this host with the sessions this schedule starts"
              hint="It belongs to another member: its owner's computer runs these sessions, and can see what they do" />
          </If>
          <If when={levels().length > 0 || thinking()}>
            <Field label="Reasoning" hint={thinking() ? "The level each new session's opening message runs at, which its conversation keeps" : "The level the model's host starts it at"}>
              <Select<ThinkingLevel | ""> label="Reasoning" value={thinking()} disabled={form.busy()} onChange={value => thinking.set(value)} testID="schedule-thinking"
                options={[{ value: "" as const, label: "Default" }, ...levels().map(level => ({ value: level, label: levelLabels[level] })),
                  ...(thinking() && !levels().includes(thinking() as ThinkingLevel) ? [{ value: thinking(), label: levelLabels[thinking() as ThinkingLevel] }] : [])]} />
            </Field>
          </If>
          <Field label="When its run is done" hint={oneShot()
            ? "Each new session is archived once its run is done; you can still open it. One that fails, or that someone sends a message of their own, stays open"
            : "Each new session stays open until someone archives it"}>
            <Select<string> label="When its run is done" value={oneShot() ? "archive" : "keep"} disabled={form.busy()} onChange={value => oneShot.set(value === "archive")}
              testID="schedule-one-shot" options={[{ value: "archive", label: "Archive the session" }, { value: "keep", label: "Keep it open" }]} />
          </Field>
        </If>
        <Field label="Access" hint={accessHints[props.kind][access()]}>
          <Select<AccessMode> label="Access" value={access()} disabled={form.busy()} onChange={value => access.set(value)}
            options={(["auto", "read"] as const).map(mode => ({ value: mode, label: accessLabels[mode] }))} />
        </Field>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button small variant="primary" testID="schedule-save" label={form.busy() ? "Saving…" : existing ? "Save" : "Create schedule"} disabled={!ready() || form.busy()} onPress={save} />
          <Button small variant="ghost" label="Cancel" onPress={() => props.onDone(false)} />
        </View>
        <Feedback error={form.error()} />
      </CardBody>
    </Section>
  );
}
