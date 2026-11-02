import type { Workspace } from "../../../../packages/shared/src/types";
import type { ChildSessionSettings as Settings } from "../../../../packages/shared/src/cross-session";
import { api, segment } from "../api";
import { CardBody, Feedback, ResourceState, Row, Section, StatusBadge, useAction, useResource } from "../ui";

interface ChildSessionSettingsResponse { settings: Settings }

/** Whether an agent that starts a session for a sub-task chooses the model and reasoning level it runs on. */
export function ChildSessionSettings({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/child-sessions`;
  const resource = useResource<ChildSessionSettingsResponse>(path);
  const action = useAction();
  const enabled = resource.data?.settings.childModels;
  function save(next: boolean) {
    if (!admin || action.busy || next === enabled) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { childModels: next } });
      resource.refresh();
    }, next ? "Agents now choose the model and reasoning level of each session they start, to suit its task."
      : "Sessions that agents start now run on their parent session's model and reasoning level.");
  }
  return <Section title="Sub-task sessions" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can change this.</p>}
    <p>A session's agent can start other sessions for sub-tasks with its <code>sessions</code> tool. With this on, it chooses each one's model, among those the person it works for can use here, and the reasoning level its first message runs at: a capable model thinking hard for difficult work, a fast one thinking little for simple work. What it leaves out is the same as its own session's.</p>
    <p>With this off, every session an agent starts runs on its parent session's current model and reasoning level. People still choose models and reasoning in any session's chat themselves.</p>
  </div>}>
    <ResourceState loading={resource.loading} error={resource.error} retry={resource.refresh}>
      {enabled !== undefined && <Row title="Agents choose models for sub-tasks"
        hint={enabled ? "Each session an agent starts runs on the model and reasoning level it chose for its task" : "Sessions agents start run on their parent's model and reasoning level"}
        trailing={admin
          ? <input type="checkbox" className="checkbox" role="switch" aria-label="Let agents choose the model and reasoning level of sessions they start" checked={enabled} disabled={action.busy} onChange={event => save(event.target.checked)} />
          : <StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Off"}</StatusBadge>} />}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
  </Section>;
}
