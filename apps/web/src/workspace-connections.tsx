import { useMemo, useState } from "react";
import { gitProviderNames, type GitProvider, type TokenGitProvider } from "../../../packages/shared/src/repositories";
import { gitProviderLabel } from "./repositories";
import { documentKindNames, type DocumentKind } from "../../../packages/shared/src/sources";
import {
  workspaceConnectionLimit, workspaceDocumentProviders, workspaceGitProviders,
  type SourceReadAs, type WorkspaceConnection, type WorkspaceConnectionList,
} from "../../../packages/shared/src/workspace-connections";
import { api, segment } from "./api";
import { Icon } from "./icons";
import { ConnectGitAccountSheet } from "./settings/GitAccounts";
import { ConnectSheet } from "./sources";
import { Button, CardBody, DropdownMenu, Feedback, ResourceState, Row, Section, StatusBadge, confirmDialog, useAction, useResource, type ActionState } from "./ui";

/** A workspace's connections: every member may see which accounts it reads with; owners and admins manage them. */
export function useWorkspaceConnections(workspaceId: string | null) {
  const resource = useResource<WorkspaceConnectionList>(workspaceId ? `/api/workspaces/${segment(workspaceId)}/connections` : null);
  return { connections: resource.data?.connections ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
}

/** A connection's provider, with its host (and Azure DevOps organization) for Git. */
export function connectionLabel(connection: Pick<WorkspaceConnection, "family" | "provider" | "host" | "organization">): string {
  if (connection.family === "document") return documentKindNames[connection.provider as DocumentKind];
  const label = gitProviderLabel(connection.provider as GitProvider, connection.host);
  return connection.organization ? `${label} · ${connection.organization}` : label;
}

/** The workspace's Git connection a repository would read with: the same provider, host and Azure DevOps organization. */
export function gitConnectionFor(connections: WorkspaceConnection[] | null, repository: { provider: GitProvider; host: string; fullName: string }) {
  const organization = repository.provider === "azure-devops" ? repository.fullName.split("/")[0]!.toLowerCase() : "";
  return connections?.find(item => item.family === "git" && item.provider === repository.provider && item.host === repository.host && item.organization === organization) ?? null;
}
export function documentConnectionFor(connections: WorkspaceConnection[] | null, kind: DocumentKind) {
  return connections?.find(item => item.family === "document" && item.provider === kind) ?? null;
}

export const readAsLabels: Record<SourceReadAs, string> = { members: "Members' own accounts", workspace: "Workspace connection" };

/**
 * Which identity a source reads with, on its row. Owners and admins switch it; Pistead reads the source with the
 * workspace's connection before it lets that one be chosen. Members see only where it isn't their own account.
 */
export function ReadAsControl({ workspaceId, sourceId, title, readAs, connection, admin, action, changed }: {
  workspaceId: string; sourceId: string; title: string; readAs: SourceReadAs; connection: WorkspaceConnection | null; admin: boolean;
  action: ActionState; changed: () => void;
}) {
  if (!admin) return readAs === "workspace" ? <StatusBadge>Workspace connection</StatusBadge> : null;
  function choose(next: SourceReadAs) {
    if (next === readAs || action.busy) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspaceId)}/sources/${segment(sourceId)}/read-as`, { method: "PUT", body: { readAs: next } });
      changed();
    }, next === "workspace" ? `${title} now reads with the workspace connection.` : `${title} now reads with each session owner's own account.`);
  }
  return <label className="inline small" title="Which account sessions read this source with">Reads with
    <select className="select compact" value={readAs} disabled={action.busy} aria-label={`Account ${title} reads with`} onChange={event => choose(event.target.value as SourceReadAs)}>
      <option value="members">Members' accounts</option>
      <option value="workspace" disabled={!connection && readAs !== "workspace"}>{connection ? `Workspace: ${connection.name}` : "Workspace (not connected)"}</option>
    </select>
  </label>;
}

/** Settings → Workspaces → the workspace → Connections. */
export function WorkspaceConnections({ workspaceId, admin, connections, loading, error, refresh, changed }: {
  workspaceId: string; admin: boolean; connections: WorkspaceConnection[] | null; loading: boolean; error: string; refresh: () => void; changed: () => void;
}) {
  const action = useAction();
  const [git, setGit] = useState<TokenGitProvider | null>(null);
  // Replacing a Git connection keeps its host and organization; reconnecting the same key replaces it, even at the cap.
  const [replacing, setReplacing] = useState<WorkspaceConnection | null>(null);
  // Stable while the sheet is open, so typing isn't reset. A Git server's name is its user name; other providers' names
  // are what the provider reported (a Bitbucket login, not the email it connects with), so those are entered again.
  const initial = useMemo(() => replacing
    ? { host: replacing.host, organization: replacing.organization, ...(replacing.provider === "git" ? { username: replacing.name } : {}) } : null, [replacing]);
  const [document, setDocument] = useState<DocumentKind | null>(null);
  const path = `/api/workspaces/${segment(workspaceId)}/connections`;
  const full = (connections?.length ?? 0) >= workspaceConnectionLimit;
  async function remove(connection: WorkspaceConnection) {
    if (action.busy) return;
    const confirmed = await confirmDialog({
      title: "Remove connection",
      message: `Remove the workspace's ${connectionLabel(connection)} connection (${connection.name})? Its secret is deleted from the server.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`${path}/${segment(connection.id)}`, { method: "DELETE" });
      refresh(); changed();
    }, "Connection removed.");
  }
  const saved = () => { refresh(); changed(); };
  return <Section title="Connections"
    info={<div className="stack">
      <p>Service accounts this workspace reads its sources with, instead of each member's own: a GitLab or Gitea bot, a Git server's deploy user, a Notion integration, a Google service account or a Feishu/Lark app. Connect accounts made for that, never your personal one: every member's sessions read with it.</p>
      <p>A source uses a connection only where an owner or admin sets it to, under Sources; Pistead reads the source with the connection first. Otherwise sessions read with their owner's own account, as before, and never fall back from one to the other.</p>
      <p>Connections only read. Pushes and pull requests use the session owner's account or the workspace's push access. Secrets are encrypted on the server and never sent to any host; members see only which account it is. github.com repositories, Dropbox, OneDrive and Tencent Docs read with each member's own sign-in.</p>
    </div>}
    action={admin && !full && <DropdownMenu label="Add connection" triggerVariant="outline" trigger={<><Icon name="plus" size={16} />Add connection</>} items={[
      ...workspaceGitProviders.map(provider => ({ label: gitProviderNames[provider], onSelect: () => setGit(provider) })),
      "separator" as const,
      ...workspaceDocumentProviders.map(kind => ({ label: documentKindNames[kind], onSelect: () => setDocument(kind) })),
    ]} />}>
    <ResourceState loading={loading && !connections} error={error} retry={refresh}>
      {!connections?.length
        ? <CardBody><span className="muted">No connections. Sessions read every source with their owner's own account</span></CardBody>
        : connections.map(connection => <Row key={connection.id} leading={<Icon name={connection.family === "git" ? "git-branch" : "file"} size={16} />}
          title={connectionLabel(connection)}
          hint={`${connection.name} · ${connection.sources ? `${connection.sources} source${connection.sources === 1 ? "" : "s"} read with it` : "No source reads with it yet"}`}
          trailing={admin && <>
            <Button variant="ghost" size="sm" disabled={action.busy} aria-label={`Replace ${connectionLabel(connection)}`}
              title="Connect it again with a new secret, keeping the sources that read with it"
              onClick={() => connection.family === "git"
                ? (setReplacing(connection), setGit(connection.provider as TokenGitProvider))
                : setDocument(connection.provider as DocumentKind)}>Replace</Button>
            <Button variant="ghost" size="sm" disabled={action.busy || connection.sources > 0}
              title={connection.sources > 0 ? "Switch its sources to members' own accounts first" : undefined}
              aria-label={`Remove ${connectionLabel(connection)}`} onClick={() => void remove(connection)}>Remove</Button>
          </>} />)}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
    {admin && full && <CardBody><span className="muted small">This workspace has {workspaceConnectionLimit} connections, the most it can have. Replace one, or remove one to add another.</span></CardBody>}
    {admin && <ConnectGitAccountSheet provider={git} close={() => { setGit(null); setReplacing(null); }} added={saved}
      initial={initial}
      save={async body => { await api(path, { method: "POST", body: { family: "git", ...body } }); }} />}
    {admin && <ConnectSheet provider={document} close={() => setDocument(null)} connected={saved}
      save={async (provider, body) => { await api(path, { method: "POST", body: { family: "document", provider, ...body } }); }} />}
  </Section>;
}
