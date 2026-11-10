import { signal, untracked, View } from "nsh";
import type { PushIdentity, PushIdentityKind } from "../../../../packages/shared/src/types";
import {
  gitProviderHosts, gitProviderNames, gitProviders, pushIdentityKindsByProvider, type GitProvider, type TokenGitProvider,
} from "../../../../packages/shared/src/repositories";
import { documentKindNames, documentKinds, sourceLimits, type DocumentItemType, type DocumentKind, type SourceAccountList, type WorkspaceDocumentSource } from "../../../../packages/shared/src/sources";
import {
  workspaceConnectionLimit, workspaceDocumentProviders, workspaceGitProviders, type SourceReadAs, type WorkspaceConnection, type WorkspaceConnectionList,
} from "../../../../packages/shared/src/workspace-connections";
import { segment, type Workspace } from "../shared";
import { session } from "../lib/auth";
import { openExternal } from "../lib/links";
import { createAction, createResource, type Action } from "../lib/resource";
import { Icon } from "../icons";
import { palette } from "../theme";
import { Field, Select, TextField } from "../form";
import { Badge, Banner, Button, CardBody, confirm, CopyField, DropdownMenu, Feedback, FormSheet, Note, ResourceState, Row, Section, Small } from "../ui";
import { Card, ConnectDocumentSheet, ConnectGitAccountSheet, GroupTitle } from "./accounts";

export function gitProviderLabel(provider: GitProvider, host: string): string {
  return host === gitProviderHosts[provider].default ? gitProviderNames[provider] : `${gitProviderNames[provider]} (${host})`;
}

export function createWorkspaceConnections(workspaceId: () => string) {
  return createResource<WorkspaceConnectionList>(() => `/api/workspaces/${segment(workspaceId())}/connections`);
}

export function connectionLabel(connection: Pick<WorkspaceConnection, "family" | "provider" | "host" | "organization">): string {
  if (connection.family === "document") return documentKindNames[connection.provider as DocumentKind];
  const label = gitProviderLabel(connection.provider as GitProvider, connection.host);
  return connection.organization ? `${label} · ${connection.organization}` : label;
}

export function gitConnectionFor(connections: WorkspaceConnection[] | null, repository: { provider: GitProvider; host: string; fullName: string }) {
  const organization = repository.provider === "azure-devops" ? repository.fullName.split("/")[0]!.toLowerCase() : "";
  return connections?.find(item => item.family === "git" && item.provider === repository.provider && item.host === repository.host && item.organization === organization) ?? null;
}
export function documentConnectionFor(connections: WorkspaceConnection[] | null, kind: DocumentKind) {
  return connections?.find(item => item.family === "document" && item.provider === kind) ?? null;
}

export function ReadAsControl(props: {
  workspaceId: string; sourceId: string; title: string; readAs: SourceReadAs; connection: WorkspaceConnection | null; admin: boolean; action: Action; changed: () => void;
}) {
  function choose(next: SourceReadAs) {
    if (next === props.readAs || props.action.busy()) return;
    void props.action.run(async () => {
      await session().api(`/api/workspaces/${segment(props.workspaceId)}/sources/${segment(props.sourceId)}/read-as`, { method: "PUT", body: { readAs: next } });
      props.changed();
    }, next === "workspace" ? `${props.title} now reads with the workspace connection.` : `${props.title} now reads with each session owner's own account.`);
  }
  return (
    <If when={props.admin} else={<If when={props.readAs === "workspace"}><Badge>Workspace connection</Badge></If>}>
      <Select<SourceReadAs> compact label={`Account ${props.title} reads with`} value={props.readAs} disabled={props.action.busy()} onChange={choose}
        options={[{ value: "members", label: "Members' accounts" },
          { value: "workspace", label: props.connection ? `Workspace: ${props.connection.name}` : "Workspace (not connected)", disabled: !props.connection && props.readAs !== "workspace" }]} />
    </If>
  );
}

export function WorkspaceConnections(props: { workspaceId: string; admin: boolean; connections: WorkspaceConnection[] | null; loading: boolean; error: string; refresh: () => void; changed: () => void }) {
  const action = createAction();
  const git = signal<TokenGitProvider | null>(null);
  const replacing = signal<WorkspaceConnection | null>(null);
  const initial = () => {
    const current = replacing();
    return current ? { host: current.host, organization: current.organization, ...(current.provider === "git" ? { username: current.name } : {}) } : null;
  };
  const document = signal<DocumentKind | null>(null);
  const path = () => `/api/workspaces/${segment(props.workspaceId)}/connections`;
  const full = () => (props.connections?.length ?? 0) >= workspaceConnectionLimit;
  async function remove(connection: WorkspaceConnection) {
    if (action.busy()) return;
    if (!await confirm({ title: "Remove connection", confirmLabel: "Remove", destructive: true,
      message: `Remove the workspace's ${connectionLabel(connection)} connection (${connection.name})? Its secret is deleted from the server.` })) return;
    void action.run(async () => {
      await session().api(`${path()}/${segment(connection.id)}`, { method: "DELETE" });
      props.refresh(); props.changed();
    }, "Connection removed.");
  }
  const saved = () => { props.refresh(); props.changed(); };
  return (
    <Section title="Connections" testID="workspace-connections"
      info={<View style={{ gap: 8 }}>
        <Note>Service accounts this workspace reads its sources with, instead of each member's own: a GitLab or Gitea bot, a Git server's deploy user, a Notion integration, a Google service account or a Feishu/Lark app. Connect accounts made for that, never your personal one: every member's sessions read with it.</Note>
        <Note>A source uses a connection only where an owner or admin sets it to, under Sources; Pikibun reads the source with the connection first. Otherwise sessions read with their owner's own account, as before, and never fall back from one to the other.</Note>
        <Note>Connections only read. Pushes and pull requests use the session owner's account or the workspace's push access. Secrets are encrypted on the server and never sent to any host; members see only which account it is.</Note>
      </View>}
      action={props.admin && !full() ? <DropdownMenu label="Add connection" trigger={<Button small variant="outline" icon="plus" label="Add connection" />} items={[
        ...workspaceGitProviders.map(provider => ({ label: gitProviderNames[provider], onSelect: () => git.set(provider) })),
        "separator" as const,
        ...workspaceDocumentProviders.map(kind => ({ label: documentKindNames[kind], onSelect: () => document.set(kind) })),
      ]} /> : undefined}>
      <ResourceState inline loading={props.loading && !props.connections} error={props.error} retry={props.refresh}>
        <If when={props.connections?.length} else={<CardBody><Small>No connections. Sessions read every source with their owner's own account</Small></CardBody>}>
          <Each of={props.connections ?? []} key={connection => connection.id}>
            {connection => (
              <Row leading={<Icon name={connection().family === "git" ? "branch" : "file"} size={16} color={palette().muted} />} title={connectionLabel(connection())}
                hint={`${connection().name} · ${connection().sources ? `${connection().sources} source${connection().sources === 1 ? "" : "s"} read with it` : "No source reads with it yet"}`}
                trailing={props.admin ? <>
                  <Button small variant="ghost" label="Replace" disabled={action.busy()}
                    onPress={() => (connection().family === "git" ? (replacing.set(connection()), git.set(connection().provider as TokenGitProvider)) : document.set(connection().provider as DocumentKind))} />
                  <Button small variant="ghost" label="Remove" disabled={action.busy() || connection().sources > 0} onPress={() => void remove(connection())} />
                </> : undefined} />
            )}
          </Each>
        </If>
      </ResourceState>
      <If when={props.admin && full()}><CardBody><Small>{`This workspace has ${workspaceConnectionLimit} connections, the most it can have. Replace one, or remove one to add another.`}</Small></CardBody></If>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      <If when={props.admin}>
        <ConnectGitAccountSheet provider={git()} close={() => { git.set(null); replacing.set(null); }} added={saved} initial={initial()}
          save={async body => { await session().api(path(), { method: "POST", body: { family: "git", ...body } }); }} />
        <ConnectDocumentSheet provider={document()} close={() => document.set(null)} connected={saved}
          save={async (provider, body) => { await session().api(path(), { method: "POST", body: { family: "document", provider, ...body } }); }} />
      </If>
    </Section>
  );
}

const itemLabels: Record<DocumentItemType, string> = {
  page: "Page", database: "Database", folder: "Folder", document: "Document", spreadsheet: "Spreadsheet", presentation: "Presentation", file: "File", wiki: "Wiki page",
};
const linkHints: Record<DocumentKind, string> = {
  notion: "A page or database link (Share → Copy link). It must be shared with your Notion integration",
  "google-drive": "A folder, file, Google Doc, Sheet or Slides link. It must be shared with your service account",
  feishu: "A folder, docx document or wiki page link. Your app must be added to it",
  dropbox: "A folder or file link, or its path in your Dropbox (/Specs). Shared folders must be added to your Dropbox",
  onedrive: "A OneDrive or SharePoint folder or file link",
  "tencent-docs": "A Tencent Docs folder or document link (docs.qq.com/…)",
};

export function DocumentSources(props: {
  workspaceId: string; workspaceName: string; admin: boolean; sources: WorkspaceDocumentSource[] | null; loading: boolean; error: string; refresh: () => void; changed: () => void;
  connections: WorkspaceConnection[] | null; go: (route: { name: "settings"; section: string }) => void;
}) {
  const action = createAction();
  const accounts = createResource<SourceAccountList>(() => (props.admin ? "/api/source-accounts" : null));
  const adding = signal(false);
  const own = () => documentKinds.filter(kind => accounts.data()?.accounts.some(account => account.provider === kind));
  const workspaceKinds = () => documentKinds.filter(kind => documentConnectionFor(props.connections, kind));
  const connected = () => documentKinds.filter(kind => own().includes(kind) || workspaceKinds().includes(kind));
  const full = () => (props.sources?.length ?? 0) >= sourceLimits.documents;
  async function remove(source: WorkspaceDocumentSource) {
    if (action.busy() || !props.admin) return;
    if (!await confirm({ title: "Remove source", confirmLabel: "Remove", destructive: true,
      message: `Remove ${source.title} (${documentKindNames[source.kind]}) from ${props.workspaceName}? Sessions, running ones too, can no longer read it or what is under it.` })) return;
    void action.run(async () => {
      await session().api(`/api/workspaces/${segment(props.workspaceId)}/sources/${segment(source.id)}`, { method: "DELETE" });
      props.refresh(); props.changed();
    }, "Source removed.");
  }
  return (
    <View style={{ gap: 8 }}>
      <GroupTitle action={props.admin && connected().length > 0 && !full()
        ? <Button small variant="outline" icon="plus" label="Add document source" disabled={props.loading || Boolean(props.error) || action.busy()} onPress={() => adding.set(true)} /> : undefined}>Documents</GroupTitle>
      <Card>
        <ResourceState inline loading={props.loading} error={props.error} retry={props.refresh}>
          <If when={props.sources?.length}
            else={<CardBody><Small>No documents yet. Sessions read a bound Notion page or a folder or document in Google Drive, Dropbox, OneDrive, Feishu/Lark or Tencent Docs, and what is under it, with their owner's own connection</Small></CardBody>}>
            <Each of={props.sources ?? []} key={source => source.id}>
              {source => (
                <Row leading={<Icon name="file" size={16} color={palette().muted} />} title={source().title}
                  hint={`${documentKindNames[source().kind]} · ${itemLabels[source().itemType]}`}
                  trailing={<>
                    <Button small variant="ghost" icon="external-link" label="Open" onPress={() => openExternal(source().url)} />
                    <If when={workspaceDocumentProviders.includes(source().kind)}>
                      <ReadAsControl workspaceId={props.workspaceId} sourceId={source().id} title={source().title} readAs={source().readAs}
                        connection={documentConnectionFor(props.connections, source().kind)} admin={props.admin} action={action} changed={props.changed} />
                    </If>
                    <If when={props.admin}><Button small variant="outline" label="Remove" disabled={action.busy()} onPress={() => void remove(source())} /></If>
                  </>} />
              )}
            </Each>
          </If>
        </ResourceState>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Card>
      <If when={props.admin && accounts.data() && !connected().length}>
        <Banner tone="info" title="Connect an account to add documents" actions={<Button small variant="outline" label="Open profile" onPress={() => props.go({ name: "settings", section: "profile" })} />}>
          Pikibun checks each item you add with your own connection to its provider, in Settings → Profile → Connected accounts, or with the workspace's connection under Connections.
        </Banner>
      </If>
      <If when={props.admin && full()}><Banner tone="info" title="Document source limit reached">{`A workspace has at most ${sourceLimits.documents} document sources. Remove one to add another.`}</Banner></If>
      <If when={props.admin && connected().length > 0}>
        <AddSourceSheet open={adding()} kinds={connected()} own={own()} workspaceKinds={workspaceKinds()} workspaceId={props.workspaceId}
          close={() => adding.set(false)} added={() => { props.refresh(); props.changed(); }} />
      </If>
    </View>
  );
}

function AddSourceSheet(props: { open: boolean; kinds: DocumentKind[]; own: DocumentKind[]; workspaceKinds: DocumentKind[]; workspaceId: string; close: () => void; added: () => void }) {
  const kind = signal<DocumentKind | "">("");
  const target = signal("");
  const choice = signal<SourceReadAs | "">("");
  const action = createAction();
  const chosen = () => kind() || (props.kinds.length === 1 ? props.kinds[0]! : "");
  const choices = (): SourceReadAs[] => (chosen()
    ? [...(props.own.includes(chosen() as DocumentKind) ? ["members" as const] : []), ...(props.workspaceKinds.includes(chosen() as DocumentKind) ? ["workspace" as const] : [])] : []);
  const readAs = (): SourceReadAs => (choice() && choices().includes(choice() as SourceReadAs) ? choice() as SourceReadAs : choices()[0] ?? "members");
  function dismiss() {
    if (action.busy()) return;
    target.set(""); kind.set("");
    props.close();
  }
  function submit() {
    if (!chosen() || !target().trim() || action.busy()) return;
    void action.run(async () => {
      await session().api(`/api/workspaces/${segment(props.workspaceId)}/sources`, { method: "POST", body: { kind: chosen(), target: target().trim(), readAs: readAs() } });
      target.set(""); kind.set(""); choice.set("");
      props.added();
      props.close();
    });
  }
  return (
    <FormSheet open={props.open} title="Add document source" onClose={dismiss}
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={dismiss} />
        <Button variant="primary" label={action.busy() ? "Checking…" : "Add source"} disabled={!chosen() || !target().trim() || action.busy()} onPress={submit} />
      </>}>
      <Field label="Provider">
        <Select<DocumentKind> label="Provider" placeholder="Choose a provider" value={chosen() || undefined} disabled={action.busy()}
          options={props.kinds.map(item => ({ value: item, label: documentKindNames[item] }))} onChange={value => kind.set(value)} />
      </Field>
      <If when={choices().length > 1}>
        <Field label="Reads with">
          <Select<SourceReadAs> label="Reads with" value={readAs()} disabled={action.busy()} onChange={value => choice.set(value)} options={[
            { value: "members", label: "Members' own accounts", hint: "Each session reads with its owner's own account; yours checks the link" },
            { value: "workspace", label: "Workspace connection", hint: "Every session reads with the workspace's connection, which checks the link" },
          ]} />
        </Field>
      </If>
      <If when={chosen()}>
        <Field label="Link" hint={`${linkHints[chosen() as DocumentKind]}. ${readAs() === "workspace" ? "Every session reads it with the workspace's connection" : "Each session reads it with its owner's own connection"}`}>
          <TextField value={target()} onChange={value => target.set(value)} disabled={action.busy()} monospace keyboardType="url" placeholder="https://…" onSubmit={submit} />
        </Field>
      </If>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}

interface PushIdentitiesResponse {
  identities: PushIdentity[];
  oidc: { issuer: string; subject: string } | null;
  redirectUri: string | null;
  githubApp: { slug: string; installUrl: string } | null;
}

const kindLabel: Record<PushIdentityKind, string> = {
  "github-app": "GitHub App",
  "entra-federation": "Entra workload identity federation",
  "bitbucket-client-credentials": "Bitbucket OAuth consumer",
  "oauth-refresh": "OAuth app authorized by a bot account",
  "forgejo-integration": "Forgejo authorized integration",
  "owner-account": "Session owner's account",
  "host-credentials": "Host's Git credentials",
};
const ownerAccount: Record<GitProvider, string> = {
  github: "the GitHub account they signed in with",
  "github-enterprise": "the GitHub Enterprise token they connected, which needs Contents write (or classic repo)",
  gitlab: "the GitLab token they connected, which needs write_repository (or api)",
  bitbucket: "the Bitbucket API token they connected, which needs write:repository:bitbucket",
  "azure-devops": "the Azure DevOps token they connected, which needs Code (Read & write)",
  gitea: "the Gitea token they connected, which needs write:repository",
  git: "the Git server account they connected, which needs write access",
};
const entraAudience = "api://AzureADTokenExchange";
const scopeLabel = (identity: PushIdentity) => `${gitProviderLabel(identity.provider, identity.host)}${identity.scope ? ` · ${identity.scope}` : ""}`;

async function authorizeIdentity(path: string, identity: PushIdentity) {
  const result = await session().api<{ url: string }>(`${path}/${segment(identity.id)}/authorize`, { method: "POST" });
  openExternal(result.url);
}

export function PushAccess(props: { workspace: Workspace; admin: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/push-identities`;
  const resource = createResource<PushIdentitiesResponse>(path);
  const action = createAction();
  const editing = signal<{ provider: GitProvider; identity?: PushIdentity } | null>(null);
  async function remove(identity: PushIdentity) {
    if (!await confirm({ title: "Remove push identity", confirmLabel: "Remove", destructive: true,
      message: `Remove the ${scopeLabel(identity)} push identity (${kindLabel[identity.kind]})? Agents can no longer push to these repositories until another identity is configured.` })) return;
    void action.run(async () => {
      await session().api(`${path()}/${segment(identity.id)}`, { method: "DELETE" });
      resource.refresh();
    }, "Push identity removed.");
  }
  const data = () => resource.data();
  return (
    <Section title="Push access" testID="workspace-push-access" info={<View style={{ gap: 8 }}>
      <If when={!props.admin}><Note>Only workspace owners and admins can manage push identities.</Note></If>
      <Note>Agents push with short-lived credentials minted from these workspace app or bot identities, held only in the host's memory. An identity can instead push with the session owner's own account or the host's own Git credentials, for sessions on the owner's own hosts. The session owner must also be able to push to the repository, and to the branch where the Git host reports branch permissions; pull requests are opened as the session owner.</Note>
      <Note>Except for GitHub, the minted token carries everything the identity can reach until it expires, and the host running the session receives it. Give bot accounts, OAuth consumers, service principals and integrations access only to this workspace's repositories.</Note>
      <Note>Secrets are write-only: they are never shown again after saving.</Note>
    </View>} action={props.admin ? <Button small variant="outline" icon="plus" label="Add identity" onPress={() => editing.set({ provider: "github" })} /> : undefined}>
      <ResourceState inline loading={resource.loading() && !data()} error={resource.error()} retry={resource.refresh}>
        <If when={data()?.githubApp}>
          {app => <Row title={`Operator GitHub App (${app().slug})`} hint="Used for github.com repositories without a workspace GitHub App. Install it on the repositories agents should push to"
            trailing={<Button small variant="outline" label="Install" onPress={() => openExternal(app().installUrl)} />} />}
        </If>
        <If when={data()?.identities.length}
          else={<If when={!data()?.githubApp}><CardBody><Small>{props.admin ? "No push identities yet. Add one per provider so agents can push" : "No push identities yet. Ask a workspace owner or admin to add one"}</Small></CardBody></If>}>
          <Each of={data()?.identities ?? []} key={identity => identity.id}>
            {identity => (
              <Row title={scopeLabel(identity())}
                hint={`${kindLabel[identity().kind]}${identity().config.slug ? ` · ${identity().config.slug}` : ""}${identity().config.login ? ` · bot ${identity().config.login}` : ""}`}
                trailing={<>
                  <Badge tone={identity().status === "ready" ? "success" : "warning"}>{identity().status === "ready" ? "Ready" : "Authorization required"}</Badge>
                  <If when={props.admin && identity().kind === "oauth-refresh"}>
                    <Button small variant="outline" label="Authorize" disabled={action.busy()} onPress={() => void action.run(() => authorizeIdentity(path(), identity()))} />
                  </If>
                  <If when={props.admin}>
                    <DropdownMenu label={`Actions for ${scopeLabel(identity())}`} items={[
                      { label: "Replace", icon: "refresh", disabled: action.busy(), onSelect: () => editing.set({ provider: identity().provider, identity: identity() }) },
                      { label: "Remove", icon: "trash", destructive: true, disabled: action.busy(), onSelect: () => void remove(identity()) },
                    ]} />
                  </If>
                </>} />
            )}
          </Each>
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      <If when={props.admin ? editing() : null}>
        {current => <PushIdentitySheet path={path()} oidc={data()?.oidc ?? null} redirectUri={data()?.redirectUri ?? null} initial={current()}
          close={() => editing.set(null)} saved={resource.refresh} />}
      </If>
    </Section>
  );
}

function PushIdentitySheet(props: { path: string; oidc: PushIdentitiesResponse["oidc"]; redirectUri: string | null; initial: { provider: GitProvider; identity?: PushIdentity };
  close: () => void; saved: () => void }) {
  const existing = untracked(() => props.initial.identity);
  const provider = signal<GitProvider>(untracked(() => props.initial.provider));
  const kind = signal<PushIdentityKind>(existing?.kind ?? pushIdentityKindsByProvider[untracked(provider)][0]!);
  const host = signal(existing?.host ?? gitProviderHosts[untracked(provider)].default ?? "");
  const scope = signal(existing?.scope ?? "");
  const config = signal<Record<string, string>>(existing ? { ...existing.config } : {});
  const secret = signal("");
  const created = signal<PushIdentity | null>(null);
  const action = createAction();
  const fixedHost = () => gitProviderHosts[provider()].fixed;
  const scoped = () => provider() === "azure-devops" || provider() === "bitbucket";
  const field = (name: string) => config()[name] ?? "";
  const setField = (name: string, value: string) => config.update(current => ({ ...current, [name]: value }));
  function chooseProvider(next: GitProvider) {
    provider.set(next); kind.set(pushIdentityKindsByProvider[next][0]!); host.set(gitProviderHosts[next].default ?? ""); scope.set(""); config.set({}); secret.set("");
  }
  const configFields: Record<PushIdentityKind, string[]> = { "github-app": ["appId", "slug"], "entra-federation": ["tenantId", "clientId"], "bitbucket-client-credentials": ["key"],
    "oauth-refresh": ["clientId"], "forgejo-integration": ["audience"], "owner-account": [], "host-credentials": [] };
  const needsSecret = () => kind() === "github-app" || kind() === "bitbucket-client-credentials" || kind() === "oauth-refresh";
  const ready = () => Boolean((fixedHost() || host().trim()) && (!scoped() || scope().trim()) && configFields[kind()].every(name => field(name).trim()) && (!needsSecret() || secret().trim()));
  const dismiss = () => { if (!action.busy()) props.close(); };
  function save() {
    if (!ready() || action.busy()) return;
    const body = {
      provider: provider(), kind: kind(),
      ...(fixedHost() ? {} : { host: host().trim() }),
      ...(scoped() ? { scope: scope().trim() } : {}),
      config: Object.fromEntries(configFields[kind()].map(name => [name, field(name).trim()])),
      ...(needsSecret() ? { secret: kind() === "github-app" ? secret() : secret().trim() } : {}),
    };
    void action.run(async () => {
      const result = await session().api<{ identity: PushIdentity }>(props.path, { method: "POST", body });
      secret.set("");
      props.saved();
      if (result.identity.kind === "oauth-refresh") created.set(result.identity);
      else props.close();
    });
  }
  const text = (name: string, label: string, hint?: string, placeholder?: string) => (
    <Field label={label} hint={hint}><TextField monospace value={field(name)} onChange={value => setField(name, value)} placeholder={placeholder} /></Field>
  );
  const issuer = (audience: string) => (
    <If when={props.oidc} else={<Banner tone="warning" title="OIDC issuer unavailable">The operator has not configured Pikibun's OIDC signing key, so this identity cannot be used yet.</Banner>}>
      {oidc => (
        <View style={{ gap: 8 }}>
          <Field label="Issuer"><CopyField value={oidc().issuer} /></Field>
          <Field label="Subject"><CopyField value={oidc().subject} /></Field>
          <If when={audience}><Field label="Audience"><CopyField value={audience} /></Field></If>
        </View>
      )}
    </If>
  );
  return (
    <FormSheet open title={existing ? "Replace push identity" : "Add push identity"} onClose={dismiss}
      footer={<If when={created()} else={<>
        <Button label="Cancel" disabled={action.busy()} onPress={dismiss} />
        <Button variant="primary" label={action.busy() ? "Verifying…" : "Save"} disabled={!ready() || action.busy()} onPress={save} />
      </>}>
        <Button label="Later" disabled={action.busy()} onPress={props.close} />
        <Button variant="primary" label="Authorize" disabled={action.busy()} onPress={() => void action.run(() => authorizeIdentity(props.path, created()!))} />
      </If>}>
      <If when={!created()} else={<Note>{`Saved. Sign in to ${created() ? gitProviderLabel(created()!.provider, created()!.host) : ""} as the bot account, then authorize the OAuth app so Pikibun can mint push tokens.`}</Note>}>
        <Field label="Provider" hint={existing ? "Saving replaces the identity for the same provider, host and scope" : undefined}>
          <Select<GitProvider> label="Provider" value={provider()} disabled={Boolean(existing)} onChange={chooseProvider}
            options={gitProviders.map(item => ({ value: item, label: gitProviderNames[item] }))} />
        </Field>
        <If when={pushIdentityKindsByProvider[provider()].length > 1}>
          <Field label="Identity type">
            <Select<PushIdentityKind> label="Identity type" value={kind()} onChange={value => { kind.set(value); config.set({}); secret.set(""); }}
              options={pushIdentityKindsByProvider[provider()].map(item => ({ value: item, label: kindLabel[item] }))} />
          </Field>
        </If>
        <If when={!fixedHost()}>
          <Field label="Host" hint="Hostname of the instance, for example git.example.com">
            <TextField monospace value={host()} disabled={Boolean(existing)} onChange={value => host.set(value)} placeholder="git.example.com" />
          </Field>
        </If>
        <If when={scoped()}>
          <Field label={provider() === "azure-devops" ? "Azure DevOps organization" : "Bitbucket workspace"}>
            <TextField monospace value={scope()} disabled={Boolean(existing)} onChange={value => scope.set(value)} />
          </Field>
        </If>
        <If when={kind() === "github-app"}>
          <Note>Create a GitHub App with Repository contents read & write and install it on the repositories agents push to.</Note>
          {text("appId", "App ID")}
          {text("slug", "App slug", "From the app's public URL: github.com/apps/<slug>")}
          <Field label="Private key" hint="PEM file contents. Write-only">
            <TextField multiline monospace value={secret()} onChange={value => secret.set(value)} placeholder="-----BEGIN RSA PRIVATE KEY-----" />
          </Field>
        </If>
        <If when={kind() === "entra-federation"}>
          <Note>Register a Microsoft Entra app, add its service principal to the Azure DevOps organization with Code (Read & write) on the repositories, and add a federated credential with these values:</Note>
          {issuer(entraAudience)}
          {text("tenantId", "Tenant ID", undefined, "00000000-0000-0000-0000-000000000000")}
          {text("clientId", "Client ID", undefined, "00000000-0000-0000-0000-000000000000")}
        </If>
        <If when={kind() === "bitbucket-client-credentials"}>
          <Note>Create an OAuth consumer in the Bitbucket workspace settings with the Repositories: Write permission, marked as a private consumer.</Note>
          {text("key", "Key")}
          <Field label="Secret" hint="Write-only"><TextField masked value={secret()} onChange={value => secret.set(value)} /></Field>
        </If>
        <If when={kind() === "oauth-refresh"}>
          <Note>{`Register an OAuth application on the instance (${provider() === "gitlab" ? "scopes write_repository and read_user" : "scopes write:repository and read:user, Gitea 1.23 or later"}) with this redirect URI. After saving, sign in as a dedicated bot account with push access and authorize it.`}</Note>
          <If when={props.redirectUri} else={<Banner tone="warning" title="Redirect URI unavailable">The operator has not configured Pikibun's application origin, so this identity cannot be authorized yet.</Banner>}>
            <Field label="Redirect URI"><CopyField value={props.redirectUri ?? ""} /></Field>
          </If>
          {text("clientId", "Client ID")}
          <Field label="Client secret" hint="Write-only"><TextField masked value={secret()} onChange={value => secret.set(value)} /></Field>
        </If>
        <If when={kind() === "forgejo-integration"}>
          <Note>As a bot account with push access (Forgejo 16 or later), create a Generic JWT authorized integration trusting this issuer and subject, then enter its audience.</Note>
          {issuer("")}
          {text("audience", "Audience")}
        </If>
        <If when={kind() === "owner-account"}>
          <Note>{`Agents push as the session owner, with ${ownerAccount[provider()]} (Settings → Profile → Connected accounts). Only sessions on the owner's own hosts push this way: the token is sent to that host for each push and held only in its memory. ${provider() === "github" ? "Pikibun resets it when the push ends, so the host's copy stops working while the owner stays connected." : "It stays valid after the push: these tokens can't be reset."}`}</Note>
        </If>
        <If when={kind() === "host-credentials"}>
          <Note>Agents push with the Git credentials set up on the host running the session, read through its Git credential helpers (for example gh auth setup-git, the macOS keychain or Git Credential Manager). Only the host's owner pushes this way, in sessions on their own host, once they turn on Git credentials in its configuration (Settings → Hosts).</Note>
        </If>
      </If>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}
