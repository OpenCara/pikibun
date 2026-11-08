import { signal, untracked, View } from "nsh";
import { assignableWorkspaceRoles, type AssignableWorkspaceRole, type UserProfile, type WorkspaceRole } from "../../../../packages/shared/src/types";
import { adminManagedRoles } from "../../../../packages/shared/src/policy";
import {
  gitProviderHasForge, gitProviderNames, repositoryLimits, type GitAccount, type ProviderRepository, type ProviderRepositoryList, type WorkspaceRepository,
  type WorkspaceRepositoryList,
} from "../../../../packages/shared/src/repositories";
import type { WorkspaceSourceList } from "../../../../packages/shared/src/sources";
import type { WorkspaceConnection } from "../../../../packages/shared/src/workspace-connections";
import type { WorkspaceInviteLink, WorkspaceJoinRequest } from "../../../../packages/shared/src/invites";
import { canCreateSessions, memberPerson, segment, userIdFromInput, username, usernameWithId, type Workspace, type WorkspaceMember } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { relativeTime } from "../lib/format";
import { openServerLink, opensServerPages } from "../lib/links";
import { createAction, createResource } from "../lib/resource";
import { createConnections } from "../hosts";
import { Icon } from "../icons";
import { palette } from "../theme";
import { Checkbox, Field, Select, TextField } from "../form";
import {
  Badge, Banner, Button, CardBody, confirm, CopyField, DropdownMenu, EmptyState, Feedback, FormSheet, IconButton, IdentityBadge, Note, ResourceState, Row, Section, Small, StatusDot,
} from "../ui";
import { NewWorkspaceSheet } from "../components/NewWorkspaceSheet";
import { Card, gitAccountLabel, GroupTitle } from "./accounts";
import { SectionPage, type SectionProps } from "./parts";
import { WorkspaceDatabaseSection } from "./workspace-database";
import { WorkspaceExtensions } from "./workspace-extensions";
import { ApprovalSettings, AttachmentSettings, ChildSessionSettings, NetworkAccess, TranscriptSettings } from "./workspace-options";
import {
  connectionLabel, createWorkspaceConnections, DocumentSources, gitConnectionFor, gitProviderLabel, PushAccess, ReadAsControl, WorkspaceConnections,
} from "./workspace-sources";

// Settings → Workspaces, as the web app's (settings/WorkspacesSettings.tsx): your workspaces, and each one's page.

const roleLabel: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", collaborator: "Collaborator", member: "Member", viewer: "Viewer" };
const roleHint: Record<AssignableWorkspaceRole, string> = {
  admin: "Collaborator, and manages the workspace: members, models, repositories and settings",
  collaborator: "Starts sessions, and sends messages to any session shared with the workspace",
  member: "Starts sessions, and follows other shared sessions read-only unless granted more",
  viewer: "Follows shared sessions read-only, and can't start sessions",
};
const workspaceRole = (workspace: Workspace, user: UserProfile): WorkspaceRole => (workspace.ownerId === user.id ? "owner" : workspace.role ?? "member");
const assignableRoles = (owner: boolean): AssignableWorkspaceRole[] => assignableWorkspaceRoles.filter(item => owner || adminManagedRoles.includes(item));

export function Workspaces(props: SectionProps) {
  const data = useAppData();
  const creating = signal(false);
  const workspace = () => data.workspaces().find(item => item.id === props.id);
  const sheet = <NewWorkspaceSheet open={creating()} onClose={() => creating.set(false)} created={created => props.go({ name: "new", workspaceId: created.id })} />;
  const error = <Banner tone="danger" title="Unable to load workspaces" actions={<Button small variant="outline" label="Try again" onPress={data.refreshWorkspaces} />}>{data.workspacesError()}</Banner>;
  return (
    <SectionPage testID="settings-workspaces">
      <If when={!props.id}
        else={
          <>
            <View style={{ flexDirection: "row", marginLeft: -8, marginBottom: -16 }}>
              <Button small variant="ghost" icon="chevron-left" label="Workspaces" testID="workspaces-back" onPress={() => props.go({ name: "settings", section: "workspaces" })} />
            </View>
            <If when={workspace()}
              else={<If when={!data.workspacesLoading()} else={<Small>Loading…</Small>}><If when={data.workspacesError()} else={<EmptyState title="Workspace not found" />}>{error}</If></If>}>
              <Each of={[props.id!]} key={id => id}>{() => <WorkspaceDetail workspace={workspace()!} workspaceOf={workspace} go={props.go} />}</Each>
            </If>
          </>
        }>
        <If when={!(data.workspacesLoading() && !data.workspaces().length)} else={<Small>Loading…</Small>}>
          <If when={!(data.workspacesError() && !data.workspaces().length)} else={error}>
            <If when={data.workspaces().length > 0}
              else={<EmptyState title="No workspaces yet" action={<Button variant="primary" icon="plus" label="New workspace" testID="new-workspace" onPress={() => creating.set(true)} />} />}>
              <Section title="Workspaces" info="A shared home for your repositories, people, agents and sessions"
                action={<Button small variant="outline" icon="plus" label="New workspace" testID="new-workspace" onPress={() => creating.set(true)} />}>
                <Each of={data.workspaces()} key={item => item.id}>
                  {item => (
                    <Row testID={`workspace-${item().id}`} leading={<IdentityBadge name={item().name} id={item().id} />} title={item().name}
                      hint={roleLabel[workspaceRole(item(), session().user)]} chevron onPress={() => props.go({ name: "settings", section: "workspaces", id: item().id })} />
                  )}
                </Each>
              </Section>
            </If>
          </If>
        </If>
      </If>
      {sheet}
    </SectionPage>
  );
}

function WorkspaceDetail(props: { workspace: Workspace; workspaceOf: () => Workspace | undefined; go: SectionProps["go"] }) {
  const workspace = () => props.workspaceOf() ?? props.workspace;
  const user = () => session().user;
  const role = () => workspaceRole(workspace(), user());
  const admin = () => role() === "owner" || role() === "admin";
  const repositories = createResource<WorkspaceRepositoryList>(() => `/api/workspaces/${segment(workspace().id)}/repositories`);
  const sources = createResource<WorkspaceSourceList>(() => `/api/workspaces/${segment(workspace().id)}/sources`);
  const connections = createWorkspaceConnections(() => workspace().id);
  const sourcesChanged = () => { repositories.refresh(); sources.refresh(); connections.refresh(); };
  const sourceCount = () => (repositories.data() ? repositories.data()!.sources ?? repositories.data()!.repositories.length : null);
  return (
    <>
      <Section title="General">
        <Row title="Name" trailing={workspace().name} />
        <Row title="Your role" trailing={<Badge tone={admin() ? "success" : "neutral"}>{roleLabel[role()]}</Badge>} />
      </Section>
      <If when={canCreateSessions(role())}><Setup workspace={workspace()} admin={admin()} sourceCount={sourceCount()} go={props.go} /></If>
      <Repositories workspace={workspace()} admin={admin()} repositories={repositories.data()?.repositories ?? null} sourceCount={sourceCount()}
        loading={repositories.loading() && !repositories.data()} error={repositories.error()} refresh={repositories.refresh}
        connections={connections.data()?.connections ?? null} changed={sourcesChanged} go={props.go} />
      <DocumentSources workspaceId={workspace().id} workspaceName={workspace().name} admin={admin()} sources={sources.data()?.sources ?? null}
        loading={sources.loading() && !sources.data()} error={sources.error()} refresh={sources.refresh} connections={connections.data()?.connections ?? null}
        changed={sourcesChanged} go={props.go} />
      <WorkspaceConnections workspaceId={workspace().id} admin={admin()} connections={connections.data()?.connections ?? null}
        loading={connections.loading()} error={connections.error()} refresh={connections.refresh} changed={sourcesChanged} />
      <PushAccess workspace={workspace()} admin={admin()} />
      <NetworkAccess workspace={workspace()} admin={admin()} />
      <WorkspaceExtensions workspace={workspace()} />
      <TranscriptSettings workspace={workspace()} admin={admin()} />
      <ApprovalSettings workspace={workspace()} admin={admin()} />
      <ChildSessionSettings workspace={workspace()} admin={admin()} />
      <AttachmentSettings workspace={workspace()} admin={admin()} />
      <WorkspaceDatabaseSection workspace={workspace()} owner={role() === "owner"} />
      <Members workspace={workspace()} admin={admin()} owner={role() === "owner"} />
      <If when={admin()}>
        <Section title="Data export" info={<View style={{ gap: 8 }}>
          <Note>Downloads this workspace as JSON: its settings, members, models, published agents, repositories, push access, session database connection and activity, with your own sessions in full and the records of every other session, which owners and admins manage.</Note>
          <Note>Secrets are never included, and a session's conversation is in its backups. The workspace owner can import exports into the workspace's session database.</Note>
        </View>}>
          <Row title="Workspace data" hint={opensServerPages ? "JSON, without secrets" : "JSON, without secrets. Download it from Pikibun on the web"}
            trailing={opensServerPages ? <Button small variant="outline" label="Export" onPress={() => openServerLink(`/api/workspaces/${segment(workspace().id)}/export`)} /> : undefined} />
        </Section>
      </If>
    </>
  );
}

/** What a workspace still needs before work starts there: a source, a host, a first session. */
function Setup(props: { workspace: Workspace; admin: boolean; sourceCount: number | null; go: SectionProps["go"] }) {
  const data = useAppData();
  const { user } = untracked(session);
  const connectors = createConnections(() => `/api/workspaces/${segment(props.workspace.id)}/connectors`);
  const steps = () => [
    { label: "Add a source", done: (props.sourceCount ?? 0) > 0, hint: props.admin ? undefined : "An owner or admin does this", go: undefined },
    { label: "Pair a host", done: (connectors.data()?.connectors ?? []).some(connector => !connector.revokedAt && connector.online && (connector.ownerId === user.id || connector.workspaceIds.includes(props.workspace.id))),
      go: () => props.go({ name: "settings", section: "hosts" }) },
    { label: "Start a session", done: data.sessions().some(item => item.workspaceId === props.workspace.id), go: () => props.go({ name: "new", workspaceId: props.workspace.id }) },
  ];
  // Only once every signal is known, so it never flashes in and out.
  const known = () => props.sourceCount !== null && Boolean(connectors.data()) && !data.sessionsLoading();
  return (
    <If when={known() && !steps().every(step => step.done)}>
      <Section title="Setup" testID="workspace-setup" action={<Small>{`${steps().filter(step => step.done).length} / ${steps().length}`}</Small>}>
        <Each of={steps()} key={step => step.label}>
          {step => (
            <Row leading={<StatusDot tone={step().done ? "success" : "neutral"} label={step().done ? "Done" : "To do"} />} title={step().label} hint={step().done ? undefined : step().hint}
              chevron={!step().done && Boolean(step().go)} onPress={!step().done ? step().go : undefined} />
          )}
        </Each>
      </Section>
    </If>
  );
}

const workspaceAccountPrefix = "workspace:";
function connectionAccount(connection: WorkspaceConnection): GitAccount {
  return { id: `${workspaceAccountPrefix}${connection.id}`, provider: connection.provider as GitAccount["provider"], host: connection.host,
    organization: connection.organization, login: connection.name, createdAt: connection.createdAt };
}

/** The workspace's Git repositories, under Sources (the documents follow, in DocumentSources). */
function Repositories(props: {
  workspace: Workspace; admin: boolean; repositories: WorkspaceRepository[] | null; sourceCount: number | null; loading: boolean; error: string; refresh: () => void;
  connections: WorkspaceConnection[] | null; changed: () => void; go: SectionProps["go"];
}) {
  const action = createAction();
  const accounts = createResource<{ accounts: GitAccount[] }>(() => (props.admin ? "/api/git/accounts" : null));
  const picking = signal(false);
  const full = () => (props.repositories?.length ?? 0) >= repositoryLimits.repositories;
  const gitConnections = () => props.connections?.filter(item => item.family === "git") ?? [];
  const canAdd = () => props.admin && Boolean(accounts.data()?.accounts.length || gitConnections().length) && !full();
  async function remove(repository: WorkspaceRepository) {
    if (action.busy() || !props.admin) return;
    const last = props.sourceCount === 1;
    if (!await confirm({ title: "Remove repository", confirmLabel: "Remove", destructive: true,
      message: `Remove ${repository.fullName} from ${props.workspace.name}? Existing sessions keep their pinned snapshots.${last ? " With no sources, new sessions, pairing and sharing will be disabled until an owner or admin adds a source." : " This changes new sessions only."}` })) return;
    void action.run(async () => {
      await session().api(`/api/workspaces/${segment(props.workspace.id)}/repositories/${segment(repository.id)}`, { method: "DELETE" });
      props.refresh();
    }, "Repository removed. Existing sessions keep their pinned snapshots.");
  }
  const put = (repository: WorkspaceRepository, what: string, body: Record<string, unknown>, notice: string) => {
    if (action.busy() || !props.admin) return;
    void action.run(async () => {
      await session().api(`/api/workspaces/${segment(props.workspace.id)}/repositories/${segment(repository.id)}/${what}`, { method: "PUT", body });
      props.refresh();
    }, notice);
  };
  return (
    <Section bare title="Sources" testID="workspace-sources" info={<View style={{ gap: 8 }}>
      <Note>What this workspace's sessions work on: Git repositories, which agents clone, and documents (Notion, Google Drive, Dropbox, OneDrive, Feishu/Lark, Tencent Docs), which agents read. Every session in the workspace gets every source, and reads each with its owner's own accounts.</Note>
      <If when={!props.admin}><Note>Only workspace owners and admins can add or remove sources.</Note></If>
      <Note>Changes apply at once, in running sessions too: a removed source can no longer be read, nor a removed repository pushed. To change a ref, remove and re-add the repository.</Note>
      <Note>Git LFS is off by default, and clones check out LFS pointer files. Turned on, sessions download the repository's LFS files with their owner's own account, where the host has git-lfs installed.</Note>
      <Note>{`Each session starts with an empty worktree, and its agent clones the workspace repositories it needs with Git, through the session's egress proxy: reads use the session owner's access and pushes go only to the session's own branches. Limit: ${repositoryLimits.repositories} repositories per workspace.`}</Note>
    </View>}>
      <View style={{ gap: 8 }}>
        <GroupTitle action={canAdd() ? <Button small variant="outline" icon="plus" label="Add repository" testID="add-repository"
          disabled={props.loading || Boolean(props.error) || action.busy()} onPress={() => picking.set(true)} /> : undefined}>Git repositories</GroupTitle>
        <Card>
          <ResourceState inline loading={props.loading} error={props.error} retry={props.refresh}>
            <If when={props.repositories?.length}
              else={<CardBody><Small>{props.admin ? "No repositories yet" : "No repositories yet. Ask a workspace owner or admin to bind one"}</Small></CardBody>}>
              <Each of={props.repositories ?? []} key={repository => repository.id}>
                {repository => (
                  <Row title={repository().fullName} hint={`${gitProviderLabel(repository().provider, repository().host)} · ${repository().ref}`} trailing={<>
                    <Checkbox label="Agent pushes to the default branch" checked={!repository().forbidDefaultBranchPush} disabled={!props.admin || action.busy()}
                      onChange={allow => put(repository(), "push-policy", { forbidDefaultBranch: !allow }, "Push policy saved.")} />
                    <Checkbox label="Git LFS" checked={repository().lfs} disabled={!props.admin || action.busy()}
                      onChange={enabled => put(repository(), "lfs", { enabled }, enabled ? "Git LFS turned on. New clones download LFS files." : "Git LFS turned off. Clones check out LFS pointer files.")} />
                    <If when={repository().provider !== "github"}>
                      <ReadAsControl workspaceId={props.workspace.id} sourceId={repository().id} title={repository().fullName} readAs={repository().readAs}
                        connection={gitConnectionFor(props.connections, repository())} admin={props.admin} action={action} changed={props.changed} />
                    </If>
                    <Badge>{repository().private ? "Private" : "Public"}</Badge>
                    <If when={props.admin}><Button small variant="outline" label="Remove" disabled={action.busy()} onPress={() => void remove(repository())} /></If>
                  </>} />
                )}
              </Each>
            </If>
          </ResourceState>
          <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
        </Card>
        <If when={props.admin && accounts.error()}>
          <Banner tone="danger" title="Unable to load Git accounts" actions={<Button small variant="outline" label="Try again" onPress={accounts.refresh} />}>{accounts.error()}</Banner>
        </If>
        <If when={props.admin && accounts.data() && !accounts.data()!.accounts.length && !gitConnections().length}>
          <Banner tone="warning" title="No Git accounts connected" actions={<Button small variant="outline" label="Open profile" onPress={() => props.go({ name: "settings", section: "profile" })} />}>
            Connect GitHub or add a Git account in Settings → Profile before choosing repositories.
          </Banner>
        </If>
        <If when={props.admin && accounts.data()?.accounts.length && full()}>
          <Banner tone="info" title="Repository limit reached">{`The workspace has reached its ${repositoryLimits.repositories}-repository limit. Remove a binding to choose another.`}</Banner>
        </If>
      </View>
      <If when={canAdd()}>
        <RepositoryPicker open={picking()} workspace={props.workspace} accounts={[...(accounts.data()?.accounts ?? []), ...gitConnections().map(connectionAccount)]}
          repositories={props.repositories ?? []} disabled={props.loading || Boolean(props.error) || action.busy()} refresh={props.refresh} close={() => picking.set(false)} go={props.go} />
      </If>
    </Section>
  );
}

function RepositoryPicker(props: { open: boolean; workspace: Workspace; accounts: GitAccount[]; repositories: WorkspaceRepository[]; disabled: boolean; refresh: () => void; close: () => void;
  go: SectionProps["go"] }) {
  const accountId = signal("");
  const selectedId = signal("");
  const ref = signal("");
  const path = signal("");
  const found = signal<ProviderRepository | null>(null);
  const account = () => props.accounts.find(item => item.id === accountId()) ?? props.accounts[0];
  const listed = () => (account() ? gitProviderHasForge(account()!.provider) : true);
  const workspaceConnection = () => account()?.id.startsWith(workspaceAccountPrefix) ?? false;
  const repositoriesPath = () => {
    const current = account();
    if (!current) return null;
    return workspaceConnection()
      ? `/api/workspaces/${segment(props.workspace.id)}/connections/${segment(current.id.slice(workspaceAccountPrefix.length))}/repositories`
      : `/api/git/accounts/${segment(current.id)}/repositories`;
  };
  const lookup = createAction();
  const resource = createResource<ProviderRepositoryList>(() => (props.open && listed() ? repositoriesPath() : null));
  const action = createAction();
  const selected = () => (listed() ? resource.data()?.repositories.find(repository => repository.id === selectedId()) : found() ?? undefined);
  const alreadyBound = (repository: ProviderRepository) => props.repositories.some(binding => binding.provider === account()?.provider && binding.host === account()?.host
    && (binding.repositoryId === repository.id || binding.fullName.toLowerCase() === repository.fullName.toLowerCase()));
  const blocked = () => props.disabled || action.busy() || lookup.busy() || (listed() && (resource.loading() || Boolean(resource.error()))) || !account() || !selected()
    || alreadyBound(selected()!) || props.repositories.length >= repositoryLimits.repositories;
  const providerName = () => (account() ? gitProviderNames[account()!.provider] : "Git");
  const choose = (id: string) => { selectedId.set(id); ref.set(""); };
  const chooseAccount = (id: string) => { accountId.set(id); choose(""); path.set(""); found.set(null); };
  function find() {
    if (!account() || lookup.busy() || !path().trim()) return;
    found.set(null); ref.set("");
    void lookup.run(async () => {
      const result = await session().api<ProviderRepositoryList>(`${repositoriesPath()}?path=${encodeURIComponent(path().trim())}`);
      found.set(result.repositories[0] ?? null);
    });
  }
  function dismiss() {
    if (action.busy()) return;
    selectedId.set(""); ref.set(""); path.set(""); found.set(null);
    props.close();
  }
  function add() {
    const repository = selected();
    const current = account();
    if (blocked() || !repository || !current) return;
    void action.run(async () => {
      await session().api(`/api/workspaces/${segment(props.workspace.id)}/repositories`, { method: "POST", body: {
        provider: current.provider, host: current.host, repositoryId: repository.id, fullName: repository.fullName, ...(ref().trim() ? { ref: ref().trim() } : {}),
        ...(workspaceConnection() ? { readAs: "workspace" } : {}) } });
      props.refresh();
      selectedId.set(""); ref.set(""); path.set(""); found.set(null);
      props.close();
    });
  }
  const refField = () => (
    <Field label="Branch, tag or commit" hint={`Optional. Leave blank to use ${selected() ? `the default branch, ${selected()!.defaultBranch}` : "the repository's default branch"}. New sessions pin this ref to a commit; existing sessions never follow branch changes`}>
      <TextField monospace value={ref()} onChange={value => ref.set(value)} disabled={props.disabled || action.busy() || !selected()} maxLength={255} placeholder={selected()?.defaultBranch ?? "Repository default branch"} />
    </Field>
  );
  return (
    <FormSheet open={props.open} title="Add repository" onClose={dismiss} testID="repository-picker"
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={dismiss} />
        <Button variant="primary" label={action.busy() ? "Binding…" : "Bind repository"} disabled={blocked()} onPress={add} />
      </>}>
      <Field label="Account">
        <Select<string> label="Account" placeholder="Choose an account" value={account()?.id} disabled={props.disabled || action.busy()} onChange={chooseAccount}
          options={props.accounts.map(item => (item.id.startsWith(workspaceAccountPrefix)
            ? { value: item.id, label: `Workspace · ${connectionLabel({ family: "git", provider: item.provider as WorkspaceConnection["provider"], host: item.host, organization: item.organization })}`, hint: item.login }
            : { value: item.id, label: gitAccountLabel(item), hint: item.login }))} />
      </Field>
      <If when={workspaceConnection()}><Note>{`Sessions read this repository with the workspace's connection (${account()?.login}), not their owner's account. Pushes still use the session owner's account or the workspace's push access`}</Note></If>
      <If when={listed()}
        else={<Note>{`A Git server lists no repositories: enter the one to add. Pikibun reads it with this ${workspaceConnection() ? "connection" : "account"} to check it${workspaceConnection() ? "" : ", and sessions read it with their owner's own account for the same server"}. Never paste a token`}</Note>}>
        <Note>{`Only repositories this ${providerName()} account can access are listed. Sessions read them with their owner's own account for the same provider. Never paste a token or clone URL`}</Note>
      </If>
      <If when={!listed() && account()}>
        <Field label="Clone URL or path" hint={`The repository's https:// clone URL on ${account()?.host}, or its path there, such as team/project.git`}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <TextField flex monospace value={path()} onChange={value => { path.set(value); found.set(null); }} disabled={props.disabled || action.busy() || lookup.busy()}
              maxLength={600} placeholder={`https://${account()?.host}/team/project.git`} onSubmit={find} />
            <Button small variant="outline" label={lookup.busy() ? "Checking…" : "Look up"} disabled={props.disabled || action.busy() || lookup.busy() || !path().trim()} onPress={find} />
          </View>
        </Field>
        <If when={found()}>
          {repository => <Row leading={<Icon name="branch" size={16} color={palette().muted} />} title={repository().fullName}
            hint={`${repository().private ? "Private" : "Public"} · default branch ${repository().defaultBranch}${alreadyBound(repository()) ? " · Already configured" : ""}`} />}
        </If>
        <Feedback error={lookup.error()} />
        <If when={found()}>{refField()}</If>
      </If>
      <If when={listed()}>
        <ResourceState inline loading={resource.loading()} error={resource.error()} retry={resource.refresh}>
          <If when={resource.data()?.repositories.length} else={<EmptyState title="No repositories found">{`Check your ${providerName()} account and organization access`}</EmptyState>}>
            <Field label={`${providerName()} repository`}
              hint={resource.data()?.truncated ? `Only the first ${repositoryLimits.pickerRepositories} repositories this account can access are listed` : undefined}>
              <Select<string> label={`${providerName()} repository`} placeholder="Choose a repository" value={selected()?.id} disabled={props.disabled || action.busy()} onChange={choose}
                options={(resource.data()?.repositories ?? []).map(repository => ({ value: repository.id, label: repository.fullName, disabled: alreadyBound(repository),
                  hint: `${repository.private ? "Private" : "Public"}${alreadyBound(repository) ? " · Already configured" : ""}` }))} />
            </Field>
            {refField()}
          </If>
        </ResourceState>
      </If>
      <If when={resource.error()}>
        <Note>Review your Git accounts and repository access, then retry. An owner or admin with access can also configure this workspace</Note>
        <View style={{ flexDirection: "row" }}><Button small variant="ghost" label="Open profile" onPress={() => { props.close(); props.go({ name: "settings", section: "profile" }); }} /></View>
      </If>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}

function Members(props: { workspace: Workspace; admin: boolean; owner: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/members`;
  const resource = createResource<{ members: WorkspaceMember[] }>(path);
  const adding = signal(false);
  const changing = signal<WorkspaceMember | null>(null);
  const action = createAction();
  async function remove(member: WorkspaceMember) {
    if (!await confirm({ title: "Remove member", message: `Remove ${usernameWithId(memberPerson(member))} from this workspace?`, confirmLabel: "Remove", destructive: true })) return;
    void action.run(async () => {
      await session().api(`${path()}/${segment(member.userId)}`, { method: "DELETE" });
      resource.refresh();
    }, "Membership removed.");
  }
  return (
    <>
      <Section title="Members" testID="workspace-members" info={<View style={{ gap: 8 }}>
        <If when={!props.admin}><Note>Only workspace owners and admins can manage membership.</Note></If>
        <Note>Every role can follow workspace-visible sessions, which shows prompts, tool output and repository content in the transcript.</Note>
        <Note>Viewer: follows them read-only and can't start sessions, whatever a session grants. Member: starts sessions, and follows other people's read-only unless they grant more. Collaborator: starts sessions, and sends messages to any workspace-visible session. Admin: a collaborator who also manages the workspace and every session in it, private ones included. Only the owner manages admins.</Note>
        <Note>Membership never grants GitHub access, tool execution, or use of anyone's private Pi host.</Note>
      </View>} action={props.admin ? <Button small variant="outline" icon="plus" label="Add member" testID="add-member" onPress={() => adding.set(true)} /> : undefined}>
        <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
          <If when={resource.data()?.members.length} else={<CardBody><Small>No members to display</Small></CardBody>}>
            <Each of={resource.data()?.members ?? []} key={member => member.userId}>
              {member => {
                const name = () => member().displayName || username(memberPerson(member()));
                return (
                  <Row leading={<IdentityBadge name={name()} id={member().userId} />} title={name()} hint={usernameWithId(memberPerson(member()))} trailing={<>
                    <Badge tone={member().role === "owner" || member().role === "admin" ? "success" : "neutral"}>{roleLabel[member().role]}</Badge>
                    <If when={props.admin && member().userId !== props.workspace.ownerId && (props.owner || adminManagedRoles.includes(member().role))}>
                      <DropdownMenu label={`Actions for ${name()}`} items={[
                        { label: "Change role", icon: "shield", disabled: action.busy(), onSelect: () => changing.set(member()) },
                        { label: "Remove", icon: "trash", destructive: true, disabled: action.busy(), onSelect: () => void remove(member()) },
                      ]} />
                    </If>
                  </>} />
                );
              }}
            </Each>
          </If>
        </ResourceState>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Section>
      <If when={props.admin}>
        <InviteLink workspace={props.workspace} />
        <PendingMembers workspace={props.workspace} owner={props.owner} accepted={resource.refresh} />
        <AddMember open={adding()} path={path()} owner={props.owner} close={() => adding.set(false)} saved={resource.refresh} />
        <If when={changing()}>
          {member => <ChangeRole member={member()} path={path()} owner={props.owner} close={() => changing.set(null)} saved={resource.refresh} />}
        </If>
      </If>
    </>
  );
}

function InviteLink(props: { workspace: Workspace }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/invite-link`;
  const resource = createResource<{ link: WorkspaceInviteLink | null }>(path);
  const action = createAction();
  const link = () => resource.data()?.link;
  function create() {
    if (action.busy()) return;
    void action.run(async () => {
      await session().api<{ link: WorkspaceInviteLink }>(path(), { method: "PUT" });
      resource.refresh();
    }, "Invite link created. Share it with the people you want to invite.");
  }
  async function turnOff(replace: boolean) {
    if (action.busy()) return;
    if (!await confirm(replace
      ? { title: "Replace the invite link?", message: "The current link stops working at once, and a new one replaces it. People already waiting to join stay pending.", confirmLabel: "Replace link", destructive: true }
      : { title: "Turn off the invite link?", message: "The link stops working at once, for everyone who has it. People already waiting to join stay pending until you accept or decline them. Turning the link on again creates a new link.", confirmLabel: "Turn off link", destructive: true })) return;
    void action.run(async () => {
      await session().api(path(), { method: "DELETE" });
      if (replace) await session().api(path(), { method: "PUT" });
      resource.refresh();
    }, replace ? "Invite link replaced. The old link no longer works." : "Invite link turned off.");
  }
  return (
    <Section title="Invite link" testID="workspace-invite" info={<View style={{ gap: 8 }}>
      <Note>Share this link with anyone. When someone signed in to this Pikibun server opens it, they can ask to join, and appear under Pending members.</Note>
      <Note>A pending member can't see or do anything in the workspace until an owner or admin accepts them with a role. Anyone with the link can ask, so only accept people you recognize.</Note>
    </View>} action={link()
      ? <DropdownMenu label="Invite link actions" items={[
        { label: "Replace link", icon: "refresh", disabled: action.busy(), onSelect: () => void turnOff(true) },
        { label: "Turn off link", icon: "trash", destructive: true, disabled: action.busy(), onSelect: () => void turnOff(false) },
      ]} />
      : resource.data() ? <Button small variant="outline" icon="plus" label="Create link" disabled={action.busy()} onPress={create} /> : undefined}>
      <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={link()} else={<CardBody><Small>No invite link. Create one to let people ask to join</Small></CardBody>}>
          {current => (
            <CardBody>
              <Field label="Invite link" hint={`Created ${relativeTime(current().createdAt)}. Anyone who opens it can ask to join`}><CopyField value={current().url} label="Copy invite link" /></Field>
            </CardBody>
          )}
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

function PendingMembers(props: { workspace: Workspace; owner: boolean; accepted: () => void }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/join-requests`;
  const resource = createResource<{ requests: WorkspaceJoinRequest[] }>(path);
  const action = createAction();
  const roles = signal<Record<string, AssignableWorkspaceRole>>({});
  const requests = () => resource.data()?.requests ?? [];
  function accept(request: WorkspaceJoinRequest, name: string) {
    if (action.busy()) return;
    const role = roles()[request.userId] ?? "member";
    void action.run(async () => {
      await session().api(`${path()}/${segment(request.userId)}/accept`, { method: "POST", body: { role } });
      resource.refresh();
      props.accepted();
    }, `${name} joined as ${roleLabel[role].toLowerCase()}.`);
  }
  async function decline(request: WorkspaceJoinRequest, name: string) {
    if (action.busy()) return;
    if (!await confirm({ title: "Decline request", message: `Decline ${name}'s request to join? They can ask again while they have a working invite link.`, confirmLabel: "Decline", destructive: true })) return;
    void action.run(async () => {
      await session().api(`${path()}/${segment(request.userId)}`, { method: "DELETE" });
      resource.refresh();
    }, "Request declined.");
  }
  return (
    <Section title="Pending members" testID="workspace-pending" info="People who asked to join through the invite link. Choose a role and accept them, or decline. Until then they can't see or do anything in the workspace."
      action={<IconButton icon="refresh" label="Refresh pending members" size={28} disabled={resource.loading()} onPress={resource.refresh} />}>
      <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={requests().length} else={<CardBody><Small>Nobody is waiting to join</Small></CardBody>}>
          <Each of={requests()} key={request => request.userId}>
            {request => {
              const person = () => memberPerson({ ...request(), role: "member" });
              const name = () => request().displayName || username(person());
              const role = () => roles()[request().userId] ?? "member";
              return (
                <Row leading={<IdentityBadge name={name()} id={request().userId} />} title={name()} hint={`${usernameWithId(person())} · asked ${relativeTime(request().createdAt)}`} trailing={<>
                  <Select<AssignableWorkspaceRole> compact label={`Role for ${name()}`} value={role()} disabled={action.busy()}
                    options={assignableRoles(props.owner).map(item => ({ value: item, label: roleLabel[item], hint: roleHint[item] }))}
                    onChange={value => roles.update(current => ({ ...current, [request().userId]: value }))} />
                  <Button small variant="outline" label="Accept" disabled={action.busy()} onPress={() => accept(request(), name())} />
                  <Button small variant="ghost" label="Decline" disabled={action.busy()} onPress={() => void decline(request(), name())} />
                </>} />
              );
            }}
          </Each>
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

function ChangeRole(props: { member: WorkspaceMember; path: string; owner: boolean; close: () => void; saved: () => void }) {
  const current = untracked(() => (props.member.role === "owner" ? null : props.member.role as AssignableWorkspaceRole));
  const role = signal<AssignableWorkspaceRole>(current ?? "member");
  const action = createAction();
  const name = () => props.member.displayName || username(memberPerson(props.member));
  function save() {
    if (action.busy() || role() === current) return;
    void action.run(async () => {
      await session().api(`${props.path}/${segment(props.member.userId)}`, { method: "PATCH", body: { role: role() } });
      props.saved();
      props.close();
    });
  }
  return (
    <FormSheet open title={`Change role of ${name()}`} onClose={() => { if (!action.busy()) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={props.close} />
        <Button variant="primary" label={action.busy() ? "Saving…" : "Save"} disabled={action.busy() || role() === current} onPress={save} />
      </>}>
      <Field label="Role" hint={`${roleHint[role()]}. Takes effect at once, in their open sessions too`}>
        <Select<AssignableWorkspaceRole> label="Role" value={role()} onChange={value => role.set(value)}
          options={assignableRoles(props.owner).map(item => ({ value: item, label: `${roleLabel[item]}${item === current ? " (current)" : ""}` }))} />
      </Field>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}

function AddMember(props: { open: boolean; path: string; owner: boolean; close: () => void; saved: () => void }) {
  const userId = signal("");
  const role = signal<AssignableWorkspaceRole>("member");
  const action = createAction();
  function save() {
    if (action.busy() || !userId().trim()) return;
    void action.run(async () => {
      // Profiles show the ID as "username(id)", so a pasted label names its ID.
      await session().api(props.path, { method: "POST", body: { userId: userIdFromInput(userId()), role: role() } });
      userId.set("");
      props.saved();
      props.close();
    });
  }
  return (
    <FormSheet open={props.open} title="Add member" onClose={() => { if (!action.busy()) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={props.close} />
        <Button variant="primary" label={action.busy() ? "Saving…" : "Save"} disabled={action.busy() || !userId().trim()} onPress={save} />
      </>}>
      <Field label="User ID" hint="Copy it from their profile. To change an existing member's role, use Change role in their menu">
        <TextField monospace value={userId()} onChange={value => userId.set(value)} placeholder="User ID" autoFocus onSubmit={save} />
      </Field>
      <Field label="Role" hint={roleHint[role()]}>
        <Select<AssignableWorkspaceRole> label="Role" value={role()} onChange={value => role.set(value)} options={assignableRoles(props.owner).map(item => ({ value: item, label: roleLabel[item] }))} />
      </Field>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}
