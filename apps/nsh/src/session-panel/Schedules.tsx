import { computed, effect, signal, untracked, View } from "nsh";
import type { AccessMode, ScheduleRunIn, SessionSchedule } from "../../../../packages/shared/src/types";
import { CronError, isTimeZone, MIN_CRON_INTERVAL_MINUTES, nextCronTime, parseCron } from "../../../../packages/shared/src/cron";
import { segment } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { timestamp } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import { Icon } from "../icons";
import { palette } from "../theme";
import { Field, Select, TextField } from "../form";
import { Badge, Button, CardBody, confirm, EmptyState, Feedback, IconButton, Note, ResourceState, Row, Section, Small } from "../ui";
import { Card } from "../settings/accounts";
import { CodeView } from "./Files";
import { TabPage, type PanelTabProps } from "./parts";

type ScheduleListing = { schedules: SessionSchedule[]; canManage: boolean };

const presets: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { label: "First of the month at 09:00", cron: "0 9 1 * *" },
];
const accessLabels: Record<AccessMode, string> = { read: "Read only", approval: "Act", auto: "Act" };
const accessHints: Record<AccessMode, string> = {
  read: "The agent can look, but changes nothing",
  approval: "The agent runs the session's tools, as your tool group allows. Nobody may be watching when it runs",
  auto: "The agent runs the session's tools, as your tool group allows. Nobody may be watching when it runs",
};
const runInLabels: Record<ScheduleRunIn, string> = { session: "This session", child: "A new session each run" };
const runInHints: Record<ScheduleRunIn, string> = {
  session: "Wakes this session's agent; a run that comes while it is busy is skipped",
  child: "Starts a new session under this one for each run, on its model and host, so this session's own work goes on undisturbed",
};
const errorLabels: Record<string, string> = {
  session_busy: "Skipped: the agent was busy",
  too_many_children: "Skipped: too many of the sessions its schedules started are still open. Archive some",
  connector_offline: "The host was offline",
  connector_unavailable: "The host was unavailable",
  connector_relay_error: "The host didn't answer",
  forbidden: "You no longer have write access",
  session_frozen: "The session runs nothing",
};

function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
function untilText(value: string): string {
  const seconds = Math.max(0, (new Date(value).getTime() - Date.now()) / 1000);
  if (seconds < 60) return "in under a minute";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86400)}d`;
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

export function Schedules(props: PanelTabProps) {
  const data = useAppData();
  const base = () => `/api/sessions/${segment(props.sessionId)}/schedules`;
  const listing = createResource<ScheduleListing>(base);
  const action = createAction();
  const editing = signal<SessionSchedule | "new" | null>(null);
  const canManage = () => Boolean(listing.data()?.canManage) && !props.session()?.frozen;
  const after = () => { listing.refresh(); data.refreshSessions(); props.refresh(); };
  let seen = "";
  effect(() => {
    const watched = `${props.session()?.nextScheduledAt ?? ""}|${props.session()?.activity ?? ""}`;
    untracked(() => { if (seen && seen !== watched) listing.refresh(); seen = watched; });
  });
  function toggle(schedule: SessionSchedule) {
    void action.run(async () => {
      await session().api(`${base()}/${segment(schedule.id)}`, { method: "PATCH", body: { enabled: !schedule.enabled } });
      after();
    }, schedule.enabled ? `Paused ${schedule.name}` : `Resumed ${schedule.name}`);
  }
  function runNow(schedule: SessionSchedule) {
    void action.run(async () => {
      await session().api(`${base()}/${segment(schedule.id)}/run`, { method: "POST" });
      after();
    }, schedule.runIn === "child" ? `Started a new session for ${schedule.name}` : `Sent ${schedule.name} to the agent`);
  }
  async function remove(schedule: SessionSchedule) {
    if (!await confirm({ title: "Delete schedule?", message: `${schedule.name} stops waking the agent. Messages it already sent stay in the conversation.`, confirmLabel: "Delete", destructive: true })) return;
    await action.run(async () => {
      await session().api(`${base()}/${segment(schedule.id)}`, { method: "DELETE" });
      after();
    }, `Deleted ${schedule.name}`);
  }
  const schedules = () => listing.data()?.schedules ?? [];
  return (
    <TabPage testID="panel-schedules">
      <If when={!editing()}
        else={<ScheduleForm base={base()} schedule={editing() === "new" ? null : editing() as SessionSchedule} isOwner={canManage()}
          onDone={saved => { editing.set(null); if (saved) after(); }} />}>
        <Section bare title={`Scheduled prompts${schedules().length ? ` ${schedules().length}` : ""}`} info={<View style={{ gap: 8 }}>
          <Note>A scheduled prompt sends the agent a message on a schedule, as the session owner, so the session wakes up and works on its own: a nightly check, a weekly report.</Note>
          <Note>A run that comes while the agent is working is skipped, not queued. Runs missed while the host or server was offline aren't caught up. The session's host must be online.</Note>
          <Note>A schedule can instead run in a new session each time: it starts a session under this one with the message, so this session isn't interrupted, and runs whatever this session is doing.</Note>
          <Note>Only the session owner manages its schedules; everyone who can view the session sees them.</Note>
        </View>} action={<View style={{ flexDirection: "row", gap: 4 }}>
          <IconButton icon="refresh" label="Refresh schedules" size={28} disabled={listing.loading()} onPress={listing.refresh} />
          <If when={canManage()}><Button small variant="outline" icon="plus" label="New" testID="schedule-new" onPress={() => editing.set("new")} /></If>
        </View>}>
          <ResourceState inline loading={listing.loading() && !listing.data()} error={listing.error()} retry={listing.refresh}>
            <If when={schedules().length}
              else={<EmptyState title="No scheduled prompts">{canManage() ? "Wake the agent with a message every hour, day or week." : "The session owner hasn't scheduled any prompts."}</EmptyState>}>
              <View style={{ gap: 12 }}>
                <Each of={schedules()} key={schedule => schedule.id}>
                  {schedule => (
                    <Card testID={`schedule-${schedule().id}`}>
                      <Row leading={<Icon name="clock" size={16} color={palette().muted} />} title={schedule().name}
                        hint={`${schedule().cron} · ${schedule().timeZone} · ${accessLabels[schedule().access]}${schedule().runIn === "child"
                          ? ` · ${runInLabels.child}${schedule().oneShot === false ? ", kept open" : ", archived when done"}` : ""}`}
                        trailing={schedule().enabled ? schedule().nextRunAt ? <Badge tone="info">{`Next ${untilText(schedule().nextRunAt!)}`}</Badge> : <Badge tone="warning">Never runs</Badge>
                          : <Badge>Paused</Badge>} />
                      <CardBody>
                        <CodeView text={schedule().content} />
                        <Small>
                          {`${schedule().enabled && schedule().nextRunAt ? `Next run ${timestamp(schedule().nextRunAt!)}. ` : ""}${schedule().lastRunAt
                            ? `Last run ${timestamp(schedule().lastRunAt!)}${schedule().lastError ? `: ${errorLabels[schedule().lastError!] ?? schedule().lastError}`
                              : schedule().lastSessionId ? " started a new session" : " sent its message"}.`
                            : "Hasn't run yet."}`}
                        </Small>
                        <If when={schedule().lastSessionId}>
                          {started => <View style={{ flexDirection: "row" }}>
                            <Button small variant="outline" icon="chevron-right" label="Open last session" testID={`schedule-last-session-${schedule().id}`}
                              onPress={() => props.go({ name: "session", sessionId: started() })} />
                          </View>}
                        </If>
                        <If when={canManage()}>
                          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                            <Button small variant="outline" label={schedule().enabled ? "Pause" : "Resume"} disabled={action.busy()} onPress={() => toggle(schedule())} />
                            <Button small variant="ghost" label="Run now" disabled={action.busy()} onPress={() => runNow(schedule())} />
                            <Button small variant="ghost" icon="pencil" label="Edit" disabled={action.busy()} onPress={() => editing.set(schedule())} />
                            <IconButton icon="trash" label={`Delete ${schedule().name}`} disabled={action.busy()} onPress={() => void remove(schedule())} />
                          </View>
                        </If>
                      </CardBody>
                    </Card>
                  )}
                </Each>
              </View>
            </If>
          </ResourceState>
          <Feedback error={action.error()} notice={action.notice()} />
        </Section>
      </If>
    </TabPage>
  );
}

function ScheduleForm(props: { base: string; schedule: SessionSchedule | null; isOwner: boolean; onDone: (saved: boolean) => void }) {
  const existing = untracked(() => props.schedule);
  const form = createAction();
  const name = signal(existing?.name ?? "");
  const cron = signal(existing?.cron ?? "0 9 * * 1-5");
  const timeZone = signal(existing?.timeZone ?? localTimeZone());
  const content = signal(existing?.content ?? "");
  const access = signal<AccessMode>(existing?.access === "read" ? "read" : "auto");
  const runIn = signal<ScheduleRunIn>(existing?.runIn ?? "session");
  const oneShot = signal<boolean>(existing?.oneShot ?? true);
  const next = computed(() => preview(cron(), timeZone()));
  const preset = () => presets.find(item => item.cron === cron().trim())?.cron ?? "";
  const ready = () => props.isOwner && content().trim().length > 0 && "runs" in next();
  function save() {
    if (!ready() || form.busy()) return;
    void form.run(async () => {
      const body = { name: name().trim(), cron: cron(), timeZone: timeZone(), content: content(), access: access(),
        ...(runIn() !== "session" || existing?.runIn !== undefined ? { runIn: runIn() } : {}),
        ...(runIn() === "child" && (!oneShot() || existing?.oneShot !== undefined) ? { oneShot: oneShot() } : {}) };
      if (existing) await session().api(`${props.base}/${segment(existing.id)}`, { method: "PATCH", body: { ...body, ...(body.name ? {} : { name: existing.name }) } });
      else await session().api(props.base, { method: "POST", body });
      props.onDone(true);
    });
  }
  const fieldError = (field: "cron" | "timeZone") => { const value = next(); return "error" in value && value.field === field ? value.error : undefined; };
  return (
    <Section title={existing ? "Edit scheduled prompt" : "New scheduled prompt"} testID="schedule-form">
      <CardBody>
        <Field label="Message" hint={runIn() === "child" ? "Opens a new session under this one, as you, each time it runs" : "Sent to the agent as you, as if you typed it in the chat box"}>
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
        <Field label="Runs in" hint={runInHints[runIn()]}>
          <Select<ScheduleRunIn> label="Runs in" value={runIn()} disabled={form.busy()} onChange={value => runIn.set(value)} testID="schedule-run-in"
            options={(["session", "child"] as const).map(mode => ({ value: mode, label: runInLabels[mode] }))} />
        </Field>
        <If when={runIn() === "child"}>
          <Field label="When its run is done" hint={oneShot()
            ? "Each new session is archived once its run is done; you can still open it. One that fails, or that you send a message of your own, stays open"
            : "Each new session stays open until you archive it"}>
            <Select<string> label="When its run is done" value={oneShot() ? "archive" : "keep"} disabled={form.busy()} onChange={value => oneShot.set(value === "archive")}
              testID="schedule-one-shot" options={[{ value: "archive", label: "Archive the session" }, { value: "keep", label: "Keep it open" }]} />
          </Field>
        </If>
        <Field label="Access" hint={accessHints[access()]}>
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
