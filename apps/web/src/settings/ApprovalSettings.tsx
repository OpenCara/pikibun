import type { Workspace } from "../../../../packages/shared/src/types";
import { api, segment } from "../api";
import { CardBody, Feedback, ResourceState, Row, Section, StatusBadge, useAction, useResource } from "../ui";

interface ApprovalSettingsResponse { settings: { requesterAutoApprove: boolean } }

/** Whether session owners here may auto-approve the requests of other members who write to their sessions. */
export function ApprovalSettings({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/approvals`;
  const resource = useResource<ApprovalSettingsResponse>(path);
  const action = useAction();
  const enabled = resource.data?.settings.requesterAutoApprove;
  function save(next: boolean) {
    if (!admin || action.busy || next === enabled) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { requesterAutoApprove: next } });
      resource.refresh();
    }, next ? "Session owners can now choose Always approve on other members' approval cards."
      : "Other members' requests ask again everywhere. Session owners' choices are kept for when this is turned back on.");
  }
  return <Section title="Approvals" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can change this.</p>}
    <p>Approved operations run as the session's owner, with their Git and GitHub access. With this on, a session's owner can choose <strong>Always approve</strong> on an approval card from another member, and that member's later commands, pushes, and GitHub comments and issues in that session run without asking.</p>
    <p>Each owner decides for their own sessions and members, and can stop it in the session panel, under Details › People. Merges, host commands, commands without the host's resource limits, and anything the session doesn't allow yet still ask.</p>
    <p>Turning this off makes those requests ask again in every session; owners' choices are kept and apply again if it's turned back on.</p>
  </div>}>
    <ResourceState loading={resource.loading} error={resource.error} retry={resource.refresh}>
      {enabled !== undefined && <Row title="Auto-approve other members' requests"
        hint={enabled ? "Session owners can choose to always approve another member's requests" : "Only each session's owner can run things without asking, in their own messages"}
        trailing={admin
          ? <input type="checkbox" className="checkbox" role="switch" aria-label="Let session owners auto-approve other members' requests" checked={enabled} disabled={action.busy} onChange={event => save(event.target.checked)} />
          : <StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Off"}</StatusBadge>} />}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
  </Section>;
}
