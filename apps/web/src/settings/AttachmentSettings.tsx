import type { Workspace } from "../../../../packages/shared/src/types";
import { fileUploadLimits, formatBytes } from "../../../../packages/shared/src/file-uploads";
import { api, segment } from "../api";
import { CardBody, Feedback, ResourceState, Row, Section, StatusBadge, useAction, useResource } from "../ui";

interface AttachmentSettingsResponse { settings: { maxFileBytes: number } }

const MB = 1024 * 1024;
/** The sizes offered, in MB; a saved size not among them (set through the API) is shown too. */
const choices = [1, 2, 5, 10, 20, 25, 50].map(value => value * MB).filter(value => value >= fileUploadLimits.minBytes && value <= fileUploadLimits.maxBytes);

/** The largest file a message in the workspace may carry into its session's worktree. */
export function AttachmentSettings({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/attachments`;
  const resource = useResource<AttachmentSettingsResponse>(path);
  const action = useAction();
  const limit = resource.data?.settings.maxFileBytes;
  const options = limit === undefined || choices.includes(limit) ? choices : [...choices, limit].sort((a, b) => a - b);
  function save(next: number) {
    if (!admin || action.busy || next === limit) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { maxFileBytes: next } });
      resource.refresh();
    }, `Files up to ${formatBytes(next)} can now be attached to messages here.`);
  }
  return <Section title="Attachments" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can change this.</p>}
    <p>Files attached to a message, other than the images the model looks at, are uploaded into the session's worktree, under <code>attachments/</code>, before the message is sent, and the message tells the agent where they are. This is the largest file one message may carry; it is {formatBytes(fileUploadLimits.defaultBytes)} until changed, and at most {formatBytes(fileUploadLimits.maxBytes)}.</p>
    <p>In the Pikibun desktop app, a file attached to a session that runs on that same computer goes straight to its host there; elsewhere it goes through this server to the session's host.</p>
  </div>}>
    <ResourceState loading={resource.loading} error={resource.error} retry={resource.refresh}>
      {limit !== undefined && <Row title="Largest attached file" hint="Each file attached to a message, uploaded into the session's worktree"
        trailing={admin
          ? <select className="select compact" aria-label="Largest attached file" value={limit} disabled={action.busy} onChange={event => save(Number(event.target.value))}>
            {options.map(value => <option key={value} value={value}>{formatBytes(value)}</option>)}
          </select>
          : <StatusBadge tone="neutral">{formatBytes(limit)}</StatusBadge>} />}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
  </Section>;
}
