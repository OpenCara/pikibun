import { signal, View } from "nsh";
import type { Schedule, WorkspaceScheduleListing } from "../../../../packages/shared/src/types";
import { segment, type Workspace } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { Button, confirm, EmptyState, Feedback, IconButton, Note, ResourceState, Section } from "../ui";
import { ScheduleCard, ScheduleForm } from "../components/Schedules";
import type { SectionProps } from "./parts";

export function WorkspaceSchedules(props: { workspace: Workspace; go: SectionProps["go"] }) {
  const data = useAppData();
  const base = () => `/api/workspaces/${segment(props.workspace.id)}/schedules`;
  const listing = createResource<WorkspaceScheduleListing>(base);
  const action = createAction();
  const editing = signal<Schedule | "new" | null>(null);
  const canCreate = () => Boolean(listing.data()?.canCreate);
  const path = (schedule: Schedule) => `${base()}/${segment(schedule.id)}`;
  const after = () => { listing.refresh(); data.refreshSessions(); };
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
    }, `Started a new session for ${schedule.name}`);
  }
  async function remove(schedule: Schedule) {
    if (!await confirm({ title: "Delete schedule?", message: `${schedule.name} starts no more sessions. The sessions it already started stay.`, confirmLabel: "Delete", destructive: true })) return;
    await action.run(async () => {
      await session().api(path(schedule), { method: "DELETE" });
      after();
    }, `Deleted ${schedule.name}`);
  }
  async function save(body: Record<string, unknown>, existing: Schedule | null) {
    if (existing) await session().api(path(existing), { method: "PATCH", body });
    else await session().api(base(), { method: "POST", body });
  }
  const schedules = () => listing.data()?.schedules ?? [];
  return (
    <If when={!editing()}
      else={<ScheduleForm kind="workspace" schedule={editing() === "new" ? null : editing() as Schedule} userId={session().user.id} models={listing.data()?.models}
        canSave={editing() === "new" ? canCreate() : Boolean((editing() as Schedule).canManage)} save={save}
        onDone={saved => { editing.set(null); if (saved) after(); }} />}>
      <Section title={`Schedules${schedules().length ? ` ${schedules().length}` : ""}`} testID="workspace-schedules" info={<View style={{ gap: 8 }}>
        <Note>A schedule starts a new session on a schedule, as its owner, with its message as the session's first: a nightly test run, a weekly dependency report, issue triage every morning. Each run is a fresh session, so runs never wait for one another.</Note>
        <Note>Members who may start sessions make schedules and manage their own. The workspace's owners and admins manage every schedule here; changing someone else's makes it theirs, so it runs as them from then on. Pausing or resuming it doesn't.</Note>
        <Note>A schedule whose owner may no longer start sessions here pauses at its next run. To wake an existing session instead, use that session's Schedules tab.</Note>
      </View>} action={<View style={{ flexDirection: "row", gap: 4 }}>
        <IconButton icon="refresh" label="Refresh schedules" size={28} disabled={listing.loading()} onPress={listing.refresh} />
        <If when={canCreate()}><Button small variant="outline" icon="plus" label="New schedule" testID="workspace-schedule-new" onPress={() => editing.set("new")} /></If>
      </View>}>
        <ResourceState inline loading={listing.loading() && !listing.data()} error={listing.error()} retry={listing.refresh}>
          <If when={schedules().length}
            else={<EmptyState title="No schedules">{canCreate() ? "Start a session with a message every hour, day or week." : "Nobody has scheduled a session here yet."}</EmptyState>}>
            <View style={{ gap: 12 }}>
              <Each of={schedules()} key={schedule => schedule.id}>
                {schedule => (
                  <ScheduleCard schedule={schedule()} models={listing.data()?.models} manage={Boolean(schedule().canManage)} busy={action.busy()} showOwner
                    onToggle={() => toggle(schedule())} onRunNow={() => runNow(schedule())} onEdit={() => editing.set(schedule())} onDelete={() => void remove(schedule())}
                    onOpenSession={sessionId => props.go({ name: "session", sessionId })} />
                )}
              </Each>
            </View>
          </If>
        </ResourceState>
        <Feedback error={action.error()} notice={action.notice()} />
      </Section>
    </If>
  );
}
