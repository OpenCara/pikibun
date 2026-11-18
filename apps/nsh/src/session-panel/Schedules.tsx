import { effect, signal, untracked, View } from "nsh";
import type { Schedule, ScheduleModelChoice } from "../../../../packages/shared/src/types";
import { segment } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { Button, confirm, EmptyState, Feedback, IconButton, Note, ResourceState, Section } from "../ui";
import { ScheduleCard, ScheduleForm } from "../components/Schedules";
import { TabPage, type PanelTabProps } from "./parts";

type ScheduleListing = { schedules: Schedule[]; canManage: boolean; canCreate?: boolean; models?: ScheduleModelChoice[]; childModels?: boolean };

export function Schedules(props: PanelTabProps) {
  const data = useAppData();
  const base = () => `/api/sessions/${segment(props.sessionId)}/schedules`;
  const listing = createResource<ScheduleListing>(base);
  const action = createAction();
  const editing = signal<Schedule | "new" | null>(null);
  const frozen = () => Boolean(props.session()?.frozen);
  const canCreate = () => Boolean(listing.data()?.canCreate ?? listing.data()?.canManage) && !frozen();
  const manages = (schedule: Schedule) => Boolean(schedule.canManage ?? listing.data()?.canManage) && !frozen();
  const after = () => { listing.refresh(); data.refreshSessions(); props.refresh(); };
  let seen = "";
  effect(() => {
    const watched = `${props.session()?.nextScheduledAt ?? ""}|${props.session()?.activity ?? ""}`;
    untracked(() => { if (seen && seen !== watched) listing.refresh(); seen = watched; });
  });
  const path = (schedule: Schedule) => `${base()}/${segment(schedule.id)}`;
  function toggle(schedule: Schedule) {
    void action.run(async () => {
      await session().api(path(schedule), { method: "PATCH", body: { enabled: !schedule.enabled } });
      after();
    }, schedule.enabled ? `Paused ${schedule.name}` : `Resumed ${schedule.name}`);
  }
  function runNow(schedule: Schedule) {
    void action.run(async () => {
      await session().api(`${path(schedule)}/run`, { method: "POST" });
      after();
    }, schedule.runIn === "child" ? `Started a new session for ${schedule.name}` : `Sent ${schedule.name} to the agent`);
  }
  async function remove(schedule: Schedule) {
    if (!await confirm({ title: "Delete schedule?", message: `${schedule.name} stops waking the agent. Messages it already sent stay in the conversation.`, confirmLabel: "Delete", destructive: true })) return;
    await action.run(async () => {
      await session().api(path(schedule), { method: "DELETE" });
      after();
    }, `Deleted ${schedule.name}`);
  }
  async function save(body: Record<string, unknown>, existing: Schedule | null) {
    if (existing) await session().api(path(existing), { method: "PATCH", body });
    else await session().api(base(), { method: "POST", body });
  }
  const wakes = () => (listing.data()?.schedules ?? []).filter(schedule => schedule.runIn === "session");
  const madeHere = () => (listing.data()?.schedules ?? []).filter(schedule => schedule.runIn === "child");
  const workspaceSchedules = () => {
    const workspaceId = props.session()?.workspaceId;
    if (workspaceId) props.go({ name: "settings", section: "workspaces", id: workspaceId });
  };
  const card = (schedule: () => Schedule) => (
    <ScheduleCard schedule={schedule()} models={listing.data()?.models} manage={manages(schedule())} busy={action.busy()} showOwner={schedule().ownerId !== props.session()?.ownerId}
      onToggle={() => toggle(schedule())} onRunNow={() => runNow(schedule())} onDelete={() => void remove(schedule())}
      onEdit={() => { if (schedule().runIn === "child") workspaceSchedules(); else editing.set(schedule()); }}
      onOpenSession={sessionId => props.go({ name: "session", sessionId })} />
  );
  return (
    <TabPage testID="panel-schedules">
      <If when={!editing()}
        else={<ScheduleForm kind="session" schedule={editing() === "new" ? null : editing() as Schedule} userId={session().user.id}
          canSave={editing() === "new" ? canCreate() : manages(editing() as Schedule)} save={save}
          onDone={saved => { editing.set(null); if (saved) after(); }} />}>
        <Section bare title={`Scheduled prompts${wakes().length ? ` ${wakes().length}` : ""}`} info={<View style={{ gap: 8 }}>
          <Note>A scheduled prompt sends the agent a message on a schedule, as the session owner, so the session wakes up and works on its own: a nightly check, a weekly report.</Note>
          <Note>A run that comes while the agent is working is skipped, not queued. Runs missed while the host or server was offline aren't caught up. The session's host must be online.</Note>
          <Note>To start a new session on a schedule instead, without waking this one, use the workspace's Schedules, under Settings → Workspaces.</Note>
          <Note>The session owner makes its schedules; they and the workspace's owners and admins change them. Changing someone else's makes it yours: it then runs as you. Everyone who can view the session sees them.</Note>
        </View>} action={<View style={{ flexDirection: "row", gap: 4 }}>
          <IconButton icon="refresh" label="Refresh schedules" size={28} disabled={listing.loading()} onPress={listing.refresh} />
          <If when={canCreate()}><Button small variant="outline" icon="plus" label="New" testID="schedule-new" onPress={() => editing.set("new")} /></If>
        </View>}>
          <ResourceState inline loading={listing.loading() && !listing.data()} error={listing.error()} retry={listing.refresh}>
            <If when={wakes().length}
              else={<EmptyState title="No scheduled prompts">{canCreate() ? "Wake the agent with a message every hour, day or week." : "The session owner hasn't scheduled any prompts."}</EmptyState>}>
              <View style={{ gap: 12 }}>
                <Each of={wakes()} key={schedule => schedule.id}>{card}</Each>
              </View>
            </If>
          </ResourceState>
          <Feedback error={action.error()} notice={action.notice()} />
        </Section>
        <If when={madeHere().length}>
          <Section bare title={`Made here, run in new sessions ${madeHere().length}`} testID="schedules-made-here" info={<View style={{ gap: 8 }}>
            <Note>These schedules were made in this session, and belong to the workspace: each run starts a new session under this one, and they keep running once this session is archived.</Note>
            <Note>Edit them in the workspace's Schedules, where you choose their model.</Note>
          </View>} action={<Button small variant="outline" icon="chevron-right" label="Workspace schedules" testID="schedules-workspace" onPress={workspaceSchedules} />}>
            <View style={{ gap: 12 }}>
              <Each of={madeHere()} key={schedule => schedule.id}>{card}</Each>
            </View>
          </Section>
        </If>
      </If>
    </TabPage>
  );
}
