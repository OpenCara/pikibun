import { signal, untracked, View } from "nsh";
import {
  sessionRoles, type ApprovalRecord, type ModelDefinition, type Operation, type SessionGrant, type SessionRecord, type SessionRole, type SessionView, type WorkspaceRole,
} from "../../../../packages/shared/src/types";
import {
  managesSession, sessionRoleAllowed, sessionRoleGrantable, sessionRoleOf, sessionRolePermissions, workspaceManagerRoles, workspaceSessionPermissions,
} from "../../../../packages/shared/src/policy";
import { builtinExtensions } from "../../../../packages/shared/src/host-config";
import { tunnelUnavailableText } from "../../../../packages/shared/src/tunnel";
import type { SessionLink } from "../../../../packages/shared/src/sharing";
import type { CrossSessionMessage, SessionConnections } from "../../../../packages/shared/src/cross-session";
import { browserUnavailableText, errorMessage, REDACTED, segment, userIdFromInput, usernameWithId, type ConnectorInfo } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { relativeTime, timestamp } from "../lib/format";
import { openExternal, openServerLink, opensServerPages } from "../lib/links";
import { createUsername, createWorkspacePeople } from "../lib/people";
import { createAction, createResource } from "../lib/resource";
import { backupDatabaseLabel, type Backup, type SessionActions } from "../lib/session-actions";
import { ConnectionStatus, HostCapabilities } from "../hosts";
import { Icon } from "../icons";
import { palette, type Tone } from "../theme";
import { Checkbox, CheckControl, Field, RadioRow, Select, TextField } from "../form";
import { Badge, Banner, Button, CardBody, CollapsibleRow, confirm, CopyField, Feedback, IconButton, Note, Row, Section, Small } from "../ui";
import type { PanelTabProps } from "./parts";

// The session panel's Details, as the web app's (session-panel.tsx PanelDetails and the sections it holds).

export interface DetailsProps extends PanelTabProps {
  actions: SessionActions;
  hosts: () => ConnectorInfo[] | null;
  hostsLoading: () => boolean;
}

const icon = (name: Parameters<typeof Icon>[0]["name"]) => <Icon name={name} size={16} color={palette().muted} />;

export function Details(props: DetailsProps) {
  const data = useAppData();
  const { user } = untracked(session);
  return (
    <If when={props.session()} else={<Small>Loading…</Small>}>
      {current => {
        const workspaceRole = () => data.workspaces().find(item => item.id === current().workspaceId)?.role as WorkspaceRole | undefined;
        const owner = () => current().ownerId === user.id;
        const canWrite = () => (current().permissions ?? []).includes("write");
        const manages = () => managesSession(user.id, current().ownerId, workspaceRole());
        const archived = () => current().status === "archived";
        return (
          <View testID="panel-details" style={{ gap: 32 }}>
            <If when={props.view()?.tunnel}>{() => <TunnelSection {...props} current={current()} canStop={canWrite() && !archived()} />}</If>
            <HostSection {...props} current={current()} />
            <If when={props.view()?.extensions}>{extensions => <ExtensionsSection extensions={extensions()} />}</If>
            <RepositoriesSection {...props} current={current()} />
            <PeopleSection {...props} current={current()} workspaceRole={workspaceRole()} />
            <TranscriptSection {...props} current={current()} manages={manages()} />
            <ConnectionsSection {...props} current={current()} />
            <If when={owner() && !archived()}><BackupsSection {...props} current={current()} /></If>
            <If when={owner() && !archived() && !current().frozen && current().connectorId}><MoveHostSection {...props} current={current()} /></If>
            <If when={canWrite() && !archived() && !current().frozen}><OperationSection {...props} current={current()} /></If>
            <If when={owner()}>
              <Section title="Export" info="Downloads this session's details, people, approvals, pushes, backup list and activity as JSON, without secrets. The conversation itself is in the session's backups. Only the session owner can export it.">
                <Row leading={icon("archive")} title="Session data" hint={opensServerPages ? "JSON, without secrets" : "JSON, without secrets. Download it from Pikibun on the web"}
                  trailing={opensServerPages ? <Button small variant="outline" label="Export" onPress={() => openServerLink(`/api/sessions/${segment(current().id)}/export`)} /> : undefined} />
              </Section>
            </If>
            <AccessSection {...props} current={current()} />
          </View>
        );
      }}
    </If>
  );
}

type Part = DetailsProps & { current: SessionRecord };

function TunnelSection(props: Part & { canStop: boolean }) {
  const action = createAction();
  const name = createUsername();
  const tunnel = () => props.view()!.tunnel!;
  async function stop() {
    if (!await confirm({ title: "Take this server offline?", confirmLabel: "Stop", destructive: true,
      message: `${tunnel().url} stops answering, and the server stops in the session's sandbox. The agent can put it online again, at a new address, with the host owner's approval.` })) return;
    await action.run(async () => {
      await session().api(`/api/sessions/${segment(props.current.id)}/tunnel/stop`, { method: "POST", body: {} });
      props.refresh();
    }, "Offline.");
  }
  return (
    <Section title="Online" info="The agent put the session's web server online through a Cloudflare tunnel, with the approval of its host's owner or a member granted host commands. The server runs in the session's sandbox; cloudflared runs on the host and reaches only its port. Anyone with the address can open it.">
      <Row leading={icon("globe")} title={tunnel().url.replace(/^https:\/\//, "")}
        hint={`${tunnel().command} on port ${tunnel().port} · started by ${name(tunnel().startedBy, true)} · online until ${timestamp(tunnel().expiresAt)} at most`}
        trailing={<>
          <Badge tone={tunnel().connected ? "success" : "warning"} dot>{tunnel().connected ? "Online" : "Connecting"}</Badge>
          <Button small variant="ghost" icon="external-link" label="Open" onPress={() => openExternal(tunnel().url)} />
          <If when={props.canStop}><Button small variant="outline" icon="stop" label="Stop" disabled={action.busy()} onPress={() => void stop()} /></If>
        </>} />
      <CardBody><Field label="Public address"><CopyField value={tunnel().url} /></Field></CardBody>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

function HostSection(props: Part) {
  const name = createUsername();
  const host = () => props.hosts()?.find(item => item.id === props.current.connectorId);
  return (
    <Section title="Host" info={`Work runs as the session owner (${name(props.current.ownerId, true)}), not the host owner. The host operator can access prompts and files processed on it. Sharing a host doesn't change who can view or control this session.`}>
      <If when={props.current.connectorId} else={<Row leading={icon("server")} title="Operator-managed session" hint="No local host is pinned" />}>
        <Row leading={icon("server")} title={host()?.name ?? "Pinned host"} testID="session-host"
          hint={`Hosted by ${host()?.ownerName ?? (props.current.connectorOwnerId ? name(props.current.connectorOwnerId) : "unknown")}${props.current.connectorOwnerId === session().user.id ? " (you)" : ""}`}
          trailing={props.hostsLoading() && !props.hosts() ? "Checking…" : host() ? <ConnectionStatus connector={host()!} />
            : props.current.hostUnsandboxed ? <Badge tone="danger">Unsandboxed</Badge> : undefined} />
        <If when={props.current.hostEnvironment}>
          <Row leading={icon("server")} title="Runs on the host" hint="No sandbox: its commands run on the host owner's machine, as its user" trailing={<Badge tone="danger">On host</Badge>} />
        </If>
        <If when={host()}>{current => <CardBody><HostCapabilities connector={current()} /></CardBody>}</If>
        <If when={props.hosts() && !host()}>
          <Row title="Host not in your list" hint="It may be private to its owner, unshared, or revoked. Viewing a session doesn't let you use its host" />
        </If>
        <Row title="Connection ID" hint={props.current.connectorId ?? ""} selectableHint />
      </If>
    </Section>
  );
}

function ExtensionsSection(props: { extensions: NonNullable<SessionView["extensions"]> }) {
  return (
    <Section title="Extensions" info="Pi extensions the workspace chose, as this session's host has them installed. They run on the host, outside the sandbox; their tool calls are approved like host commands unless the workspace and the host's owner let them run automatically. Built-in ones come with Pikibun, as the host's configuration turns them on.">
      <Each of={props.extensions.running} key={item => item.source}>
        {item => <Row leading={icon("tool")} title={item().source} hint={item().tools.length ? `Tools: ${item().tools.join(", ")}` : "No tools: prompt or hooks only"}
          trailing={item().dev ? <Badge tone="warning">Dev</Badge> : <Badge tone="success">{item().required ? "Required by the host" : "Running"}</Badge>} />}
      </Each>
      <Each of={props.extensions.unavailable ?? []} key={item => item.source}>
        {item => <Row leading={icon("alert")} title={item().source}
          hint={item().source === "piki:browser" ? browserUnavailableText(item().reason as never) : item().source === "piki:tunnel" ? tunnelUnavailableText(item().reason as never)
            : "The workspace has it on, but this session can't offer its tools"}
          trailing={<Badge tone={["missing", "failed"].includes(item().reason) ? "warning" : "neutral"}>{item().reason === "downloading" ? "Not ready yet" : "Unavailable"}</Badge>} />}
      </Each>
      <Each of={props.extensions.missingRequired ?? []}>
        {source => <Row leading={icon("alert")} title={source()} hint="The host's owner requires it of every session on the host, which can't run it now: no message is sent until it can" trailing={<Badge tone="danger">Missing</Badge>} />}
      </Each>
      <Each of={props.extensions.missing}>
        {source => <Row title={source()} hint="Not on this host at this version: the session runs without it until the host's owner installs it" trailing={<Badge>Missing</Badge>} />}
      </Each>
      <Each of={props.extensions.builtin ?? []}>
        {name => {
          const item = () => builtinExtensions.find(candidate => candidate.name === name());
          return <Row leading={icon("tool")} title={item() ? `${item()!.title} · ${name()}` : name()}
            hint={item() ? `${"core" in item()! && (item() as { core?: boolean }).core ? "Built in, in every session" : "Built in, as the host's configuration turns it on"}. Tools: ${item()!.tools.join(", ")}` : "Built in, as the host's configuration turns it on"}
            trailing={<Badge tone="success">Running</Badge>} />;
        }}
      </Each>
    </Section>
  );
}

function RepositoriesSection(props: Part) {
  const repositories = () => props.current.repositories ?? [];
  const manage = <Row title="Manage repositories for future sessions" chevron onPress={() => props.go({ name: "settings", section: "workspaces", id: props.current.workspaceId })} />;
  return (
    <If when={props.current.repositoryMode !== "clone"}
      else={
        <Section title="Repositories" info="Each session starts with an empty worktree, and its agent clones the workspace repositories it needs with Git, through the session's egress proxy: reads use the session owner's access and pushes go only to the session's own branches.">
          <Row leading={icon("branch")} title="Cloned on demand" hint="Nothing is pinned: the agent clones and switches branches as it works" />
          <Row title="Manage repositories and network access" chevron onPress={() => props.go({ name: "settings", section: "workspaces", id: props.current.workspaceId })} />
        </Section>
      }>
      <Section title={`Repositories ${repositories().length}`} info="This session was created before sessions cloned their repositories: it holds snapshots of these commits, pinned when it started, and is read-only."
        action={<IconButton icon="refresh" label="Refresh repositories" size={28} onPress={props.refresh} />}>
        <If when={props.current.status === "error"}><CardBody><Banner tone="danger" title="Snapshots not confirmed">This session is in an error state, so repository snapshots are not confirmed. Check the host, then refresh.</Banner></CardBody></If>
        <If when={props.current.status === "archived"}><CardBody><Banner title="Archived">Pinned files may no longer be on the host.</Banner></CardBody></If>
        <If when={repositories().length}
          else={<Row title="No repository pins" hint={props.current.status === "provisioning" ? "None recorded yet. Refresh to check progress" : props.current.status === "error" ? "None are available for this session" : "This older session has no pinned repositories"} />}>
          <Each of={repositories()} key={repository => repository.bindingId}>
            {repository => <Row leading={icon("branch")} title={repository().fullName} hint={`${repository().ref}@${repository().commit.slice(0, 7)} · ${repository().path}/`} />}
          </Each>
        </If>
        {manage}
      </Section>
    </If>
  );
}

const sessionRoleLabel: Record<SessionRole, string> = { viewer: "Viewer", member: "Member", collaborator: "Collaborator", admin: "Admin" };
const sessionRoleHint: Record<SessionRole, string> = {
  viewer: "Follows the session: prompts, output and side asks",
  member: "Viewer, and asks side questions without messaging the agent",
  collaborator: "Member, and sends messages to the agent and stops its work",
  admin: "Collaborator, and decides approvals and manages who has access",
};
const workspaceRoleLabel: Record<WorkspaceRole, string> = { owner: "workspace owner", admin: "workspace admin", collaborator: "workspace collaborator", member: "workspace member", viewer: "workspace viewer" };
const grantRole = (grant: SessionGrant): SessionRole | null => (grant.sessionRole === undefined ? sessionRoleOf(grant.permissions) : grant.sessionRole);
const grantLabel = (grant: SessionGrant) => { const role = grantRole(grant); return role ? sessionRoleLabel[role] : `Custom (${grant.permissions.join(", ") || "none"})`; };

function PeopleSection(props: Part & { workspaceRole: WorkspaceRole | undefined }) {
  const { user } = untracked(session);
  const form = createAction();
  const people = createWorkspacePeople(() => props.current.workspaceId);
  const name = createUsername();
  const own = () => props.current.permissions ?? [];
  const isOwner = () => props.current.ownerId === user.id;
  const manages = () => managesSession(user.id, props.current.ownerId, props.workspaceRole);
  const managerRole = () => (!isOwner() && props.workspaceRole && workspaceManagerRoles.includes(props.workspaceRole) ? props.workspaceRole : null);
  const visibility = () => props.current.visibility ?? "private";
  const viewerOnly = () => !isOwner() && !own().some(permission => permission !== "read");
  const ownRole = () => sessionRoleOf(own());
  const canManage = () => own().includes("manage");
  const archived = () => props.current.status === "archived";
  const base = () => `/api/sessions/${segment(props.current.id)}`;
  const grants = createResource<{ grants: SessionGrant[] }>(() => (canManage() && !archived() ? `${base()}/grants` : null));
  const member = signal("");
  const selected = signal<SessionRole | null>(null);
  const target = () => userIdFromInput(member(), people().list);
  const targetName = () => usernameWithId(people().person(target()));
  const ownerSelected = () => target() === props.current.ownerId;
  const existing = () => grants.data()?.grants.find(grant => grant.userId === target());
  const existingRole = () => (existing() ? grantRole(existing()!) : null);
  const targetRole = (): WorkspaceRole | undefined => existing()?.workspaceRole ?? (people().person(target()) as { role?: WorkspaceRole }).role;
  const tierBlocked = (role: SessionRole): string | null => (!sessionRoleGrantable(role, own()) ? "needs permissions you don't hold"
    : !sessionRoleAllowed(role, targetRole()) ? "workspace viewers can only be session viewers" : null);
  const fromWorkspace = () => (targetRole() && !ownerSelected() ? workspaceSessionPermissions(targetRole()!, visibility()) : []);
  const targetManages = () => targetRole() !== undefined && workspaceManagerRoles.includes(targetRole()!);
  const grantReady = () => canManage() && !ownerSelected() && Boolean(target()) && selected() !== null && !tierBlocked(selected()!) && selected() !== existingRole();
  function chooseGrant(value: string) {
    member.set(value);
    const grant = grants.data()?.grants.find(item => item.userId === userIdFromInput(value, people().list));
    selected.set(grant ? grantRole(grant) : null);
  }
  function saveGrant() {
    const role = selected();
    if (!grantReady() || !role || form.busy()) return;
    void form.run(async () => {
      await session().api(`${base()}/grants`, { method: "POST", body: { userId: target(), role } });
      grants.refresh();
      props.refresh();
    }, `${targetName()} is now a session ${sessionRoleLabel[role].toLowerCase()}`);
  }
  async function revoke() {
    if (!canManage() || ownerSelected() || !existing() || form.busy()) return;
    if (!await confirm({ title: "Remove session access?", confirmLabel: "Remove access", destructive: true,
      message: targetManages() ? `Remove ${targetName()}'s session role? As a ${workspaceRoleLabel[targetRole()!]}, they still manage this session, as they do every session in the workspace.`
        : visibility() === "workspace" ? `Remove ${targetName()}'s session role? They keep what their workspace role gives them while this session is workspace-visible. Making it private removes that.`
        : `Remove ${targetName()}'s session role? They will no longer be able to open this private session.` })) return;
    await form.run(async () => {
      await session().api(`${base()}/grants/${segment(target())}`, { method: "DELETE" });
      chooseGrant("");
      grants.refresh();
      props.refresh();
    }, targetManages() ? "Session role removed. As a workspace owner or admin, they still manage this session."
      : visibility() === "workspace" ? "Session role removed. Workspace members can still view this session until it is made private." : "Session role removed");
  }
  async function stopAutoApprove(requester: string) {
    if (form.busy()) return;
    await form.run(async () => {
      await session().api(`${base()}/auto-approved-requesters/${segment(requester)}`, { method: "DELETE" });
      props.refresh();
    }, `${usernameWithId(people().person(requester))}'s requests ask again.`);
  }
  // The share link: its owner manages it; everyone else learns from the session that one exists.
  const linkResource = createResource<{ link: SessionLink | null }>(() => (isOwner() ? `${base()}/link` : null));
  const link = () => (linkResource.data() ? linkResource.data()!.link : undefined);
  const linkShared = () => (isOwner() && link() !== undefined ? link() !== null : Boolean(props.current.linkShared));
  async function shareLink() {
    if (!isOwner() || props.actions.action.busy() || archived() || link()) return;
    if (!await confirm({ title: "Share with anyone who has the link?", confirmLabel: "Create link",
      message: "Anyone with the link will be able to view existing and future prompts and output of the shared conversation, including tool output and repository content shown in it, without signing in. They can't send messages, or see side asks, approvals, who sent each message, or the host. The session title and your display name are shown with it. Values that look like passwords, tokens or keys are hidden, but anyone who has the link can pass it on, so check the transcript for other sensitive content first. You can turn the link off at any time." })) return;
    await props.actions.action.run(async () => {
      await session().api(`${base()}/link`, { method: "PUT" });
      linkResource.refresh();
      props.refresh();
    }, "Share link created. Anyone who has it can view the shared conversation.");
  }
  async function unshareLink() {
    if (!manages() || props.actions.action.busy()) return;
    if (!await confirm({ title: "Turn off the share link?", confirmLabel: "Turn off link", destructive: true,
      message: `The link stops working at once, for everyone who has it. Content already viewed or copied can't be recalled. ${isOwner() ? "Turning link sharing on again creates a new link." : "Only the session's owner can share it by link again, with a new link."}` })) return;
    await props.actions.action.run(async () => {
      await session().api(`${base()}/link`, { method: "DELETE" });
      linkResource.refresh();
      props.refresh();
    }, "Share link turned off. It no longer opens this session.");
  }
  return (
    <Section title="People" testID="panel-people" info={<View style={{ gap: 8 }}>
      <Note>The server checks every request. You give a workspace member one of four session roles: a viewer follows the session; a member also asks side questions; a collaborator also sends messages to the agent; an admin also decides approvals and manages who has access. You can only give a role whose permissions you hold, and workspace viewers can only be session viewers.</Note>
      <Note>The workspace's owner and admins manage every session in it, private ones included. Deciding its approvals takes a session role from its owner, since approved operations run as the owner.</Note>
      <Note>The owner can also share a link: anyone who has it can view the shared conversation without signing in, but not side asks, approvals, who sent each message, or the host.</Note>
    </View>}>
      <Row leading={icon("user")} title={isOwner() ? "Owner" : managerRole() ? `Workspace ${managerRole()}` : ownRole() ? `Session ${sessionRoleLabel[ownRole()!].toLowerCase()}` : "Custom access"}
        hint={`Your permissions: ${own().join(", ") || "none"}${viewerOnly() ? ". You can follow committed work but can't ask, submit, approve, manage grants, change visibility, or use backups"
          : managerRole() && !own().includes("approve") ? `. As the workspace's ${managerRole()}, you manage every session in it; deciding approvals takes a session role from the owner` : ""}`} />
      <Row leading={icon(visibility() === "workspace" ? "globe" : "lock")} title={visibility() === "workspace" ? "Workspace-visible" : "Private"}
        hint={`${visibility() === "workspace" ? "All workspace members can view existing and future prompts and output, including tool output, repository content in the transcript, and side asks"
          : "Only the owner, the workspace's owner and admins, and people with a session role can view prompts and output"}. ${manages()
          ? visibility() === "workspace" ? "Making it private keeps explicit grants and can't recall content already viewed or copied" : "Before sharing, check existing prompts, tool output and side asks for secrets"
          : "Only the session owner, or the workspace's owner or an admin, can change visibility"}`}
        trailing={manages() && !archived() ? <Button small variant="outline" label={visibility() === "workspace" ? "Make private" : "Make workspace-visible"} disabled={props.actions.action.busy()}
          onPress={props.actions.changeVisibility} /> : undefined} />
      <If when={isOwner() || linkShared()}>
        <Row leading={icon("link")} title={linkShared() ? "Anyone with the link can view" : "Link sharing off"}
          hint={!isOwner() ? `The owner shared this session by link: anyone who has it can view the shared conversation without signing in, including messages you send to it. Side asks stay hidden${manages() ? ". You can turn the link off, which stops it at once" : ""}`
            : linkShared() ? "Without signing in, they can follow the shared conversation, but not side asks, approvals, who sent each message, or the host. Turning the link off stops it at once"
            : archived() ? "Archived sessions can't get a new share link" : "Create a link that lets anyone who has it view the shared conversation, read-only, without signing in"}
          trailing={isOwner() ? (linkShared() ? <Button small variant="outline" label="Turn off" disabled={props.actions.action.busy()} onPress={() => void unshareLink()} />
            : !archived() ? <Button small variant="outline" label="Create link" testID="share-link-create" disabled={props.actions.action.busy() || linkResource.loading()} onPress={() => void shareLink()} /> : undefined)
            : manages() && linkShared() ? <Button small variant="outline" label="Turn off" disabled={props.actions.action.busy()} onPress={() => void unshareLink()} /> : undefined} />
      </If>
      <If when={isOwner() ? link() : null}>
        {current => <CardBody><Field label="Share link" hint={`Created ${relativeTime(current().createdAt)}`}><CopyField value={current().url} label="Copy share link" /></Field></CardBody>}
      </If>
      <If when={isOwner() && linkResource.error()}><CardBody><Feedback error={linkResource.error()} /></CardBody></If>
      <Each of={props.current.autoApprovedRequesters ?? []}>
        {requester => (
          <Row leading={icon("check")} title={`Always approves ${name(requester(), true)}`}
            hint={props.current.requesterAutoApprove ? `Their commands, pushes, and GitHub comments and issues here run without asking, as the owner. Merges, host commands and new permissions still ask${isOwner() ? "" : ". Only the owner can stop it"}`
              : "Paused: the workspace no longer lets owners auto-approve other members' requests, so they ask again. It applies again if that's turned back on"}
            trailing={isOwner() ? <Button small variant="outline" label="Stop" disabled={form.busy()} onPress={() => void stopAutoApprove(requester())} /> : undefined} />
        )}
      </Each>
      <If when={canManage() && !archived()}
        else={<Row leading={icon("users")} title="Session roles" hint={canManage() ? "Unarchive the session to manage session roles" : "Managing session roles takes the session admin role"} />}>
        <CollapsibleRow leading={icon("users")} title="Session roles" testID="session-roles"
          hint={grants.data() ? `${grants.data()!.grants.length} ${grants.data()!.grants.length === 1 ? "person" : "people"} with access` : undefined}>
          <If when={grants.data()} else={<Small>{grants.error() || "Loading…"}</Small>}>
            {current => (
              <>
                <Field label="People with access" hint={current().grants.length > 1 ? undefined : "Nobody else has a session role yet"}>
                  <Select<string> label="People with access" placeholder="Add someone" value={existing() ? target() : ""}
                    onChange={value => chooseGrant(value && usernameWithId(people().person(value)))}
                    options={[{ value: "", label: "Add someone" }, ...current().grants.map(grant => ({ value: grant.userId,
                      label: `${usernameWithId(people().person(grant.userId))}: ${grant.userId === props.current.ownerId ? "Owner (immutable)" : grantLabel(grant)}` }))]} />
                </Field>
                <Field label="Workspace member" hint={ownerSelected() ? "The owner's access is immutable"
                  : target() ? [targetName() !== target() && member().trim() !== targetName() ? targetName() : null, targetRole() ? workspaceRoleLabel[targetRole()!] : null].filter(Boolean).join(" · ") || undefined : undefined}>
                  <TextField value={member()} onChange={chooseGrant} placeholder="Username or user ID" autoCapitalize="none" autoCorrect={false} disabled={form.busy()} />
                </Field>
                <View style={{ gap: 10, opacity: ownerSelected() ? 0.5 : 1 }}>
                  <Small>Session role</Small>
                  <Each of={sessionRoles}>
                    {role => (
                      <RadioRow checked={selected() === role()} disabled={Boolean(tierBlocked(role())) || ownerSelected() || form.busy()} onSelect={() => selected.set(role())}
                        label={`${sessionRoleLabel[role()]}${existingRole() === role() ? " (current)" : ""}${tierBlocked(role()) ? ` (${tierBlocked(role())})` : ""}`}
                        hint={`${sessionRoleHint[role()]} · ${sessionRolePermissions[role()].join(", ")}`} />
                    )}
                  </Each>
                </View>
                <If when={existing() && !ownerSelected() && !existingRole()}>
                  <Note>{`${targetName()} has a custom grant (${existing()?.permissions.join(", ")}) from before session roles. Choose a role to replace it.`}</Note>
                </If>
                <If when={fromWorkspace().length > 1 && targetRole()}>
                  <Note>{`As a ${workspaceRoleLabel[targetRole()!]}, ${targetName()} already has ${fromWorkspace().join(", ")} on this ${targetManages() ? "session, as on every session in the workspace" : "workspace-visible session"}; a session role adds to that.`}</Note>
                </If>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Button small label={form.busy() ? "Saving…" : existing() ? "Change role" : "Give role"} disabled={!grantReady()} onPress={saveGrant} />
                  <If when={existing() && !ownerSelected()}><Button small variant="outline" label="Remove access" disabled={form.busy()} onPress={() => void revoke()} /></If>
                </View>
                <If when={visibility() === "workspace"}>
                  <Note>Removing someone's session role doesn't stop workspace members from viewing; make the session private for that. The workspace's owner and admins keep managing it either way.</Note>
                </If>
              </>
            )}
          </If>
        </CollapsibleRow>
      </If>
      <If when={form.error() || form.notice()}><CardBody><Feedback error={form.error()} notice={form.notice()} /></CardBody></If>
    </Section>
  );
}

function TranscriptSection(props: Part & { manages: boolean }) {
  const action = createAction();
  const settings = createResource<{ settings: { paging: boolean } }>(() => `/api/workspaces/${segment(props.current.workspaceId)}/transcripts`);
  const full = () => props.current.toolOutput !== "brief";
  const editable = () => props.manages && props.current.status !== "archived";
  function setFull(next: boolean) {
    if (!editable() || action.busy() || next === full()) return;
    void action.run(async () => {
      await session().api(`/api/sessions/${segment(props.current.id)}`, { method: "PATCH", body: { toolOutput: next ? "full" : "brief" } });
      props.refresh();
    }, next ? "Full tool output is on for everyone viewing this session." : "Tool output is brief for everyone viewing this session: one line per tool result.");
  }
  const paging = () => settings.data()?.settings.paging;
  return (
    <Section title="Transcript" info="With full tool output on, the transcript shows everything each tool printed. Turned off, each tool result shows only its first line and long tool calls are cut short, for everyone viewing the session, its share link included. The host keeps the whole output either way, and the agent still sees all of it. Whether the transcript loads latest messages first is a workspace setting.">
      <Row title="Full tool output" hint={full() ? "Every tool result in full" : "One line per tool result"}
        trailing={editable() ? <CheckControl label="Full tool output" checked={full()} disabled={action.busy()} onChange={setFull} /> : <Badge>{full() ? "On" : "Off"}</Badge>} />
      <Row title="Loading" hint={paging() === undefined ? (settings.error() ? "Couldn't check the workspace setting" : "Checking…")
        : paging() ? "Latest messages first; earlier ones load as you scroll up" : "The whole transcript at once"} />
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

const kindLabel: Record<CrossSessionMessage["kind"], string> = { ask: "Side ask", send: "Message", create: "Opening message", notify: "Notification" };
const notifyLabel: Record<NonNullable<CrossSessionMessage["notify"]>, { label: string; tone: Tone }> = {
  pending: { label: "Will notify", tone: "info" }, delivered: { label: "Notified", tone: "success" },
  failed: { label: "Notification failed", tone: "danger" }, expired: { label: "Notification expired", tone: "neutral" },
};

/** The sessions this one is linked with through the sessions tool, and the messages either way. */
function ConnectionsSection(props: Part) {
  const connections = createResource<SessionConnections>(() => `/api/sessions/${segment(props.current.id)}/connections`);
  const name = createUsername();
  const data = () => connections.data();
  const open = (id: string) => props.go({ name: "session", sessionId: id });
  return (
    <If when={data() && (data()!.parent || data()!.children.length || data()!.messages.length)}>
      <Section title="Connected sessions" info="Agents work with other sessions through the sessions tool, always as the person whose message they work on, with that person's own permissions there. Messages they send name this session and their sender in their first line; Pikibun also records each one here. Approvals in another session are decided only by people there.">
        <If when={data()?.parent}>{parent => <Row leading={icon("link")} title={parent().title} hint={`Started this session · ${parent().status === "archived" ? "Archived" : parent().activity ?? parent().status}`} chevron onPress={() => open(parent().id)} />}</If>
        <Each of={data()?.children ?? []} key={child => child.id}>
          {child => <Row leading={icon("link")} title={child().title} hint={`Started by this session · ${child().status === "archived" ? "Archived" : child().activity ?? child().status}`} chevron onPress={() => open(child().id)} />}
        </Each>
        <Each of={data()?.messages ?? []} key={message => message.id}>
          {message => {
            const outgoing = () => message().originSessionId === props.current.id;
            const notify = () => (message().notify ? notifyLabel[message().notify!] : undefined);
            return <Row leading={icon(outgoing() ? "arrow-up" : "message")} title={`${kindLabel[message().kind]} ${outgoing() ? "to" : "from"} ${message().otherTitle}`}
              hint={`By ${name(message().actorId, true)} · hop ${message().hops} · ${relativeTime(message().createdAt)}`}
              trailing={notify() ? <Badge tone={notify()!.tone}>{notify()!.label}</Badge> : undefined}
              onPress={() => open(outgoing() ? message().targetSessionId : message().originSessionId)} />;
          }}
        </Each>
      </Section>
    </If>
  );
}

/* ---------- Backups ---------- */

const backupLocationLabel = (backup: Backup) => `${backup.location === "workspace-database" ? " · Workspace database" : ""}${backup.automatic ? " · Automatic" : ""}${backup.conversationOnly ? " · Conversation only" : ""}`;
const everyLabel = (minutes: number) => (minutes === 15 ? "every 15 minutes" : minutes === 60 ? "every hour" : minutes === 360 ? "every 6 hours" : minutes === 1440 ? "every day" : `every ${minutes} minutes`);
/** Restores asked for, by source and backup: a retry reuses its request so it never makes a second session. */
const restores = new Map<string, { requestId: string; title?: string; targetSessionId?: string }>();

function BackupsSection(props: Part) {
  const actions = props.actions;
  const listing = () => actions.backups.data();
  const off = () => actions.backupsOff();
  const blocked = () => actions.backupBlocked();
  return (
    <Section title="Backups" testID="panel-backups" info={<View style={{ gap: 8 }}>
      <Note>Only the session owner can create, download or restore backups. Backups need the session to be idle.</Note>
      <Note>A backup keeps the conversation, the session's files and each clone's local work. Conversation only keeps just the conversation: it's much smaller, and a session restored from it starts with an empty worktree.</Note>
      <Note>Restore creates a new private session and never overwrites this one. It doesn't replay approvals or run operations, and needs the original host to be available.</Note>
    </View>} action={<View style={{ flexDirection: "row", gap: 4 }}>
      <IconButton icon="refresh" label="Refresh backups" size={28} onPress={actions.backups.refresh} />
      <Button small variant="ghost" label="Conversation only" disabled={off() || actions.backupsPending() || blocked() || actions.conversationOnlyOff() || actions.action.busy()}
        onPress={() => actions.createBackup({ conversationOnly: true })} />
      <Button small variant="outline" label={actions.action.busy() ? "Working…" : "Create backup"} testID="backup-create"
        disabled={off() || actions.backupsPending() || blocked() || actions.action.busy()} onPress={() => actions.createBackup()} />
    </View>}>
      <If when={blocked() && !off()}><Row title="Backup unavailable right now" hint="Unavailable while work is queued or running, or the live state can't be confirmed" /></If>
      <If when={actions.backup()}>
        {backup => <Row leading={icon("check")} title={`Backup created ${timestamp(backup().createdAt)}`} hint={`${backup().size} bytes${backupLocationLabel(backup())} · ID ${backup().id} · SHA-256 ${backup().sha256}`}
          trailing={opensServerPages ? <Button small variant="outline" label="Download" onPress={() => openServerLink(`/api/sessions/${segment(props.current.id)}/backups/${segment(backup().id)}/download`)} /> : undefined} />}
      </If>
      <If when={!actions.backups.loading() || listing()} else={<Row title="Loading backups…" />}>
        <If when={!actions.backups.error()} else={<Row title="Unable to load backups" hint={actions.backups.error()} trailing={<Button small variant="outline" label="Try again" onPress={actions.backups.refresh} />} />}>
          <If when={off()}>
            <Row leading={icon("info")} title="Backups are off" hint={listing()?.destination === "workspace-database"
              ? "This workspace keeps its backups in its own database, which this server no longer connects to. The workspace owner can disconnect it in the workspace settings"
              : "This server keeps no session backups: its operator hasn't set up backup storage (STORAGE_URL)"} />
          </If>
          <If when={!off() ? listing()?.workspaceDatabase : null}>
            {target => <Row leading={icon("server")} title="Saved to the workspace database"
              hint={target().confirm ? `New backups of this session go to ${backupDatabaseLabel(target())}, which the workspace owner connected. Whoever can read it can read them; you confirm before each backup`
                : `New backups of this session go to ${backupDatabaseLabel(target())}${target().consented ? ", which the workspace owner connected and you confirmed" : ""}`} />}
          </If>
          <If when={!off() ? listing()?.automaticBackups : null}>
            {automatic => <Row leading={icon(automatic().error ? "info" : "refresh")} title="Automatic backups" hint={!automatic().included
              ? `The workspace backs up changed sessions ${everyLabel(automatic().minutes)}, but not yours until you confirm its database under Settings → Workspaces → Session database`
              : `Saved ${everyLabel(automatic().minutes)} when the session changed. ${automatic().error ? `The last attempt failed (${automatic().error}); it is retried within 15 minutes` : automatic().pending ? "Changed since the last one: it is saved once the session is idle and due" : "Up to date"}`} />}
          </If>
          <If when={listing()?.backups.length} else={<If when={!off()}><Row title="No backups yet" hint="Listing and downloading work while the host is offline" /></If>}>
            <Each of={listing()?.backups ?? []} key={backup => backup.id}>
              {backup => <BackupItem {...props} backup={backup()} />}
            </Each>
          </If>
        </If>
      </If>
      <If when={actions.action.error() || actions.action.notice()}><CardBody><Feedback error={actions.action.error()} notice={actions.action.notice()} /></CardBody></If>
    </Section>
  );
}

function BackupItem(props: Part & { backup: Backup }) {
  const key = () => `${props.current.id}:${props.backup.id}`;
  const attempt = signal(restores.get(untracked(key)));
  const title = signal(untracked(attempt)?.title ?? "");
  const pending = signal(false);
  const error = signal("");
  const unreadable = () => Boolean(props.backup.unavailable) && !attempt()?.targetSessionId;
  async function restore() {
    if (pending() || unreadable()) return;
    pending.set(true);
    error.set("");
    try {
      let request = restores.get(key());
      if (!request) {
        const newTitle = title().trim();
        if (newTitle.length > 200) throw new Error("Use a title of at most 200 characters, or leave it blank");
        request = { requestId: crypto.randomUUID(), ...(newTitle ? { title: newTitle } : {}) };
        restores.set(key(), request);
      }
      attempt.set(request);
      if (request.targetSessionId) { props.go({ name: "session", sessionId: request.targetSessionId }); return; }
      const result = await session().api<{ session: SessionRecord; restore: { status: string; sourceSessionId: string; backupId: string; targetSessionId: string } }>(
        `/api/sessions/${segment(props.current.id)}/backups/${segment(props.backup.id)}/restore`,
        { method: "POST", body: { requestId: request.requestId, ...(request.title ? { title: request.title } : {}) } });
      if (!result.session?.id || result.session.id === props.current.id || result.restore?.status !== "completed" || result.restore.sourceSessionId !== props.current.id
        || result.restore.backupId !== props.backup.id || result.restore.targetSessionId !== result.session.id) {
        throw new Error("The server did not confirm a completed restore into a new session. Retry this same request to resolve its outcome.");
      }
      const completed = { ...request, targetSessionId: result.session.id };
      restores.set(key(), completed);
      attempt.set(completed);
      props.go({ name: "session", sessionId: result.session.id });
    } catch (reason) {
      error.set(errorMessage(reason));
    } finally {
      pending.set(false);
    }
  }
  return (
    <CollapsibleRow leading={icon("archive")} title={timestamp(props.backup.createdAt)} hint={`${props.backup.size} bytes${backupLocationLabel(props.backup)}${props.backup.unavailable ? " · Unavailable" : ""}`}>
      <Small>{`ID ${props.backup.id}; SHA-256 ${props.backup.sha256}`}</Small>
      <If when={!props.backup.unavailable}
        else={<Small>{props.backup.location === "workspace-database" ? "This backup was saved in the workspace's own database, which this server can't use now, so it can't be downloaded or restored"
          : "This backup was saved in the server's backup storage, which isn't set up now (STORAGE_URL), so it can't be downloaded or restored"}</Small>}>
        <If when={opensServerPages} else={<Small>Download it from Pikibun on the web.</Small>}>
          <View style={{ flexDirection: "row" }}>
            <Button small variant="outline" icon="external-link" label="Download backup"
              onPress={() => openServerLink(`/api/sessions/${segment(props.current.id)}/backups/${segment(props.backup.id)}/download`)} />
          </View>
        </If>
      </If>
      <Field label="New session title" hint="Optional. Restore creates a new private session and never overwrites this one">
        <TextField value={title()} onChange={value => title.set(value)} maxLength={200} disabled={Boolean(attempt()) || unreadable() || pending()} />
      </Field>
      <If when={attempt()}><Note>{`Restore request ${attempt()?.requestId}. Retrying reuses this request ID and title, so it resolves the same new session instead of creating another.`}</Note></If>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Button small label={pending() ? "Restoring…" : attempt()?.targetSessionId ? "Open restored session" : attempt() ? "Retry same restore" : "Restore into new private session"}
          disabled={unreadable() || pending()} onPress={() => void restore()} />
        <If when={pending()}><Small>Waiting for the server to confirm the new session…</Small></If>
      </View>
      <Feedback error={error()} />
      <If when={error() && attempt() && !attempt()?.targetSessionId}>
        <Banner tone="warning" title="Outcome not confirmed">Retry the same restore; an error doesn't mean no session was created.</Banner>
      </If>
      <If when={attempt()?.targetSessionId}>
        {target => <Small>{`Restored session: ${target()}. It is private; only its owner, or the workspace's owner or an admin, can change visibility.`}</Small>}
      </If>
    </CollapsibleRow>
  );
}

/* ---------- Moving to another host ---------- */

type MigrationInfo = { id: string; status: "pending" | "completed" | "cancelled"; sourceSessionId: string; targetSessionId: string; sourceConnectorId: string; targetConnectorId: string };
type MigrationListing = { migrations: (MigrationInfo & { requestId: string; modelId: string; title: string | null; createdAt: string })[] };

function MoveHostSection(props: Part) {
  const { user } = untracked(session);
  const models = createResource<{ models: ModelDefinition[] }>(() => `/api/workspaces/${segment(props.current.workspaceId)}/models`);
  const listing = createResource<MigrationListing>(() => `/api/sessions/${segment(props.current.id)}/migrations`);
  const modelId = signal("");
  const title = signal("");
  const trusted = signal("");
  const error = signal("");
  const pending = signal(false);
  const connectors = () => props.hosts() ?? [];
  const source = () => connectors().find(host => host.id === props.current.connectorId);
  const inFlight = () => listing.data()?.migrations.find(item => item.status === "pending" && item.sourceSessionId === props.current.id);
  const choices = () => (models.data()?.models ?? []).flatMap(model => {
    const host = connectors().find(item => item.id === model.connectorId);
    if (!host || host.id === props.current.connectorId || host.revokedAt || host.capabilities.hostMigration !== true
      || !host.models.some(item => item.provider === model.provider && item.modelId === model.modelId)) return [];
    return [{ model, host }];
  });
  const choice = () => choices().find(item => item.model.id === modelId());
  const foreign = () => Boolean(choice() && choice()!.host.ownerId !== user.id);
  const canMove = () => Boolean(choice() && choice()!.host.online && source()?.online && (!foreign() || trusted() === choice()!.host.id) && !pending());
  async function send(body: Record<string, unknown>) {
    pending.set(true);
    error.set("");
    try {
      const result = await session().api<{ session: SessionRecord; migration: MigrationInfo }>(`/api/sessions/${segment(props.current.id)}/migrate`, { method: "POST", body });
      if (result.migration?.status !== "completed" || result.migration.sourceSessionId !== props.current.id || result.migration.targetSessionId !== result.session?.id) {
        throw new Error("The server did not confirm the move. Retry it to resolve its outcome.");
      }
      props.refresh();
      props.go({ name: "session", sessionId: result.session.id });
    } catch (reason) {
      error.set(errorMessage(reason));
      listing.refresh();
    } finally {
      pending.set(false);
    }
  }
  async function move() {
    const current = choice();
    if (!current || !canMove()) return;
    if (!await confirm({ title: "Move session", confirmLabel: "Move session",
      message: `Move this session to ${current.host.name} (${current.model.name})? Its conversation, files and history are copied there into a new session, and this one is archived. ${foreign() ? `${current.host.name}'s owner can access prompts and files processed on it. ` : ""}Session grants aren't copied.` })) return;
    await send({ requestId: crypto.randomUUID(), modelId: current.model.id, ...(title().trim() ? { title: title().trim() } : {}), ...(foreign() ? { trustedConnectorId: current.host.id } : {}) });
  }
  async function cancel() {
    const current = inFlight();
    if (!current) return;
    if (!await confirm({ title: "Cancel move", confirmLabel: "Cancel move", destructive: true,
      message: "Cancel this move? This session accepts work again, and the unfinished copy on the other host is archived." })) return;
    pending.set(true);
    error.set("");
    try {
      await session().api(`/api/sessions/${segment(props.current.id)}/migrations/${segment(current.id)}/cancel`, { method: "POST" });
      listing.refresh();
      props.refresh();
    } catch (reason) {
      error.set(errorMessage(reason));
    } finally {
      pending.set(false);
    }
  }
  return (
    <Section title="Move to another host" info="Copies this session's conversation, files and history to a model on another connected host, then archives this session. Both hosts must be connected and the session idle. Session grants and approvals given for the rest of this session aren't copied.">
      <If when={inFlight()}
        else={
          <If when={!(models.loading() || listing.loading() || (props.hostsLoading() && !props.hosts()))} else={<Row title="Loading hosts…" />}>
            <If when={choices().length} else={<Row leading={icon("info")} title="No other host available" hint="Another connected host in this workspace, with an up-to-date connector on Linux, must offer a model here" />}>
              <CardBody>
                <Field label="Model on the new host">
                  <Select<string> label="Model on the new host" placeholder="Choose a model…" value={modelId() || undefined} disabled={pending()}
                    onChange={value => { modelId.set(value); trusted.set(""); }}
                    options={choices().map(({ model, host }) => ({ value: model.id, label: `${host.name} · ${model.name}${host.online ? "" : " (offline)"}` }))} />
                </Field>
                <Field label="New session title" hint="Optional. Defaults to this session's title">
                  <TextField value={title()} onChange={value => title.set(value)} maxLength={200} disabled={pending()} />
                </Field>
                <If when={choice() && foreign()}>
                  <Checkbox checked={trusted() === choice()?.host.id} onChange={value => trusted.set(value ? choice()!.host.id : "")}
                    label={`I understand that ${choice()?.host.name}'s owner can access this session's prompts and files`} />
                </If>
                <If when={choice() && !choice()!.host.online}><Banner tone="warning" title="Host offline">{`${choice()?.host.name} must be connected to receive the session.`}</Banner></If>
                <If when={!source()?.online}><Banner tone="warning" title="This session's host is offline">Both hosts must be connected to start a move.</Banner></If>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <Button small label={pending() ? "Moving…" : "Move session"} disabled={!canMove()} onPress={() => void move()} />
                  <If when={pending()}><Small>Copying the session to the new host…</Small></If>
                </View>
              </CardBody>
            </If>
          </If>
        }>
        {current => (
          <>
            <Row leading={icon("refresh")} title="Move in progress"
              hint={`To ${connectors().find(host => host.id === current().targetConnectorId)?.name ?? "another host"}. This session accepts only reads until the move finishes or is cancelled`} />
            <CardBody>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <Button small label={pending() ? "Moving…" : "Retry move"} disabled={pending()}
                  onPress={() => void send({ requestId: current().requestId, modelId: current().modelId, ...(current().title !== null ? { title: current().title } : {}), trustedConnectorId: current().targetConnectorId })} />
                <Button small variant="outline" label="Cancel move" disabled={pending()} onPress={() => void cancel()} />
                <If when={pending()}><Small>Waiting for the other host…</Small></If>
              </View>
            </CardBody>
          </>
        )}
      </If>
      <If when={error() || models.error() || listing.error()}><CardBody><Feedback error={error() || models.error() || listing.error()} /></CardBody></If>
    </Section>
  );
}

/** A person's request for an operation, which runs once approved in the session: a GitHub comment. */
function OperationSection(props: Part) {
  const form = createAction();
  const approval = signal<Pick<ApprovalRecord, "id" | "status"> | null>(null);
  const repository = signal("");
  const issue = signal("");
  const body = signal("");
  const ready = () => /^[^/\s]+\/[^/\s]+$/.test(repository().trim()) && Number.isSafeInteger(Number(issue())) && Number(issue()) > 0 && Boolean(body().trim());
  function request() {
    if (!ready() || form.busy()) return;
    const operation: Operation = { kind: "github.comment", repository: repository().trim(), issue: Number(issue()), body: body() };
    approval.set(null);
    void form.run(async () => {
      const result = await session().api<{ approval: ApprovalRecord }>(`/api/sessions/${segment(props.current.id)}/operations`, { method: "POST", body: operation });
      approval.set({ id: result.approval.id, status: result.approval.status });
      props.refresh();
    }, "Operation requested. Review its approval in the session.");
  }
  return (
    <Section title="Operation request" info="This only requests the operation; it runs after approval in the session. Don't include passwords, tokens or other secrets.">
      <CardBody>
        <Field label="Operation"><Select<string> label="Operation" value="github.comment" onChange={() => undefined} options={[{ value: "github.comment", label: "GitHub comment" }]} /></Field>
        <Field label="Repository" hint="owner/name"><TextField monospace value={repository()} onChange={value => repository.set(value)} disabled={form.busy()} /></Field>
        <Field label="Issue number"><TextField keyboardType="number-pad" value={issue()} onChange={value => issue.set(value)} disabled={form.busy()} /></Field>
        <Field label="Comment"><TextField multiline value={body()} onChange={value => body.set(value)} disabled={form.busy()} /></Field>
        <View style={{ flexDirection: "row" }}><Button small label={form.busy() ? "Requesting…" : "Request approval"} disabled={!ready() || form.busy()} onPress={request} /></View>
        <If when={approval()}>{current => <Small>{`Approval ${current().id}: ${current().status}`}</Small>}</If>
        <Feedback error={form.error()} notice={form.notice()} />
      </CardBody>
    </Section>
  );
}

function AccessSection(props: Part) {
  const { user } = untracked(session);
  const visibility = () => props.current.visibility ?? "private";
  return (
    <Section title="Access" testID="panel-access" info={`${visibility() === "workspace"
      ? "Workspace-visible: all workspace members can view existing and future prompts and output, including tool output, repository content in the transcript, and side asks."
      : "Private: only the owner, the workspace's owner and admins, and members with a session role can view prompts and output."}${props.current.linkShared ? " Anyone with the session's share link can also view the shared conversation, without signing in." : ""} Values that look like passwords, tokens or keys are shown as ${REDACTED} to everyone; the agent and the host still see the real values.`}>
      <If when={props.view()} else={<Row title="Loading identity…" />}>
        {current => (
          <>
            <Row leading={icon("user")} title={`Runs as ${current().owner.displayName}${current().owner.id === user.id ? " (you)" : ""}`}
              hint={current().owner.githubLogin ? `GitHub @${current().owner.githubLogin}` : "No GitHub login connected"} />
            <Row leading={icon("branch")} title="Commits as" hint={`${current().owner.gitName} <${current().owner.gitEmail}>`} />
          </>
        )}
      </If>
      <CardBody><Field label="Session ID"><CopyField testID="session-id-field" value={props.current.id} label="Copy session ID" /></Field></CardBody>
    </Section>
  );
}
