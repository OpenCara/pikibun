import { effect, signal, Text, untracked, View, type JSX } from "nsh";
import {
  gitProviderHosts, gitProviderNames, gitProviders, type GitAccount, type TokenGitProvider,
} from "../../../../packages/shared/src/repositories";
import { documentKindNames, documentKinds, secretKinds, type DocumentKind, type FeishuDomain, type SourceAccountList } from "../../../../packages/shared/src/sources";
import { segment } from "../shared";
import type { UserProfile } from "../../../../packages/shared/src/types";
import { session, updateUser } from "../lib/auth";
import { openServerLink, opensServerPages } from "../lib/links";
import { createAction, createResource } from "../lib/resource";
import { Icon } from "../icons";
import { palette, text, weight } from "../theme";
import { Field, Select, TextField } from "../form";
import { Badge, Button, CardBody, confirm, Feedback, FormSheet, Note, ResourceState, Row, Section } from "../ui";

const tokenProviders = gitProviders.filter((provider): provider is TokenGitProvider => provider !== "github");

const tokenScopes: Record<TokenGitProvider, string> = {
  "github-enterprise": "Fine-grained: Contents and Metadata read (or classic repo); opening pull requests needs Pull requests write, and pushing with your account Contents write (or classic repo)",
  gitlab: "read_api and read_repository; opening merge requests needs api, and pushing with your account write_repository (or api)",
  bitbucket: "API token with read:repository:bitbucket and read:user:bitbucket, connected with your Atlassian account email above; agent pushes need this API token (workspace or repository access tokens can browse but cannot pass the push owner check); opening pull requests needs write:pullrequest:bitbucket, and pushing with your account write:repository:bitbucket",
  "azure-devops": "Code (Read); opening pull requests or pushing with your account needs Code (Read & write)",
  gitea: "read:repository and read:user; opening pull requests or pushing with your account needs write:repository",
  git: "read access to the repositories; pushing with your account needs write access",
};

export const gitAccountsInfo = "Repositories you bind or pin are read with your Git accounts, and the pull requests your agents ask for are opened with them. Their tokens are encrypted on the server and never sent to other people's hosts. Where a workspace's push access uses the session owner's account, your own host receives yours in memory for each push in your sessions; Pikibun resets your GitHub token when the push ends, so that copy stops working.";

function providerHost(provider: TokenGitProvider): string {
  if (provider === "git") return "Any server over HTTPS, without pull requests";
  const hosts = gitProviderHosts[provider];
  return hosts.fixed ?? (hosts.default ? `${hosts.default} or self-managed` : "Self-hosted");
}

export function gitAccountLabel(account: GitAccount): string {
  return `${gitProviderNames[account.provider]} · ${account.host}${account.organization ? `/${account.organization}` : ""}`;
}

export function GroupTitle(props: { children: string; action?: JSX.Element }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingHorizontal: 2 }}>
      <Text role="header" style={{ flex: 1, fontSize: text.body, fontWeight: weight.medium, color: palette().muted }}>{props.children}</Text>
      {props.action}
    </View>
  );
}

export function Card(props: { children?: JSX.Element; testID?: string }) {
  return (
    <View testID={props.testID} style={{ overflow: "hidden", borderRadius: 12, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
      <View style={{ marginTop: -1 }}>{props.children}</View>
    </View>
  );
}

function GitAccountsGroup() {
  const user = () => session().user;
  const accounts = createResource<{ accounts: GitAccount[] }>(() => "/api/git/accounts");
  const action = createAction();
  const connecting = signal<TokenGitProvider | null>(null);
  async function remove(account: GitAccount) {
    if (action.busy()) return;
    if (!await confirm({ title: "Remove Git account", destructive: true, confirmLabel: "Remove",
      message: `Remove ${gitAccountLabel(account)} (${account.login})? Its token is deleted from the server. New sessions you own can no longer read repositories through it; existing session snapshots are kept.` })) return;
    void action.run(async () => {
      await session().api(`/api/git/accounts/${segment(account.id)}`, { method: "DELETE" });
      accounts.refresh();
    }, "Git account removed.");
  }
  async function disconnectGitHub() {
    if (action.busy()) return;
    if (!await confirm({ title: "Disconnect GitHub", destructive: true, confirmLabel: "Disconnect",
      message: `Disconnect ${user().githubLogin ? `@${user().githubLogin}` : "your GitHub account"}? Its token is deleted from the server and revoked with GitHub. You stay signed in, but sessions you own can't read github.com repositories, open pull requests or push with your account until you sign in with GitHub again.` })) return;
    void action.run(async () => {
      await session().api("/api/git/accounts/github", { method: "DELETE" });
      updateUser(await session().api<{ user: UserProfile }>("/api/me").then(result => result.user, () => ({ ...user(), githubConnected: false })));
      accounts.refresh();
    }, "GitHub disconnected.");
  }
  return (
    <View testID="git-accounts" style={{ gap: 8 }}>
      <GroupTitle>Git</GroupTitle>
      <Card>
        <If when={!user().passwordSignIn}
          else={<Row leading={<Icon name="github" size={16} color={palette().muted} />} title={gitProviderNames.github}
            hint={`${gitProviderHosts.github.default} · Repositories on github.com need an account that signs in with GitHub, which this one doesn't`}
            trailing={<Badge tone="warning">Not available</Badge>} />}>
          <Row leading={<Icon name="github" size={16} color={palette().muted} />} title={gitProviderNames.github}
            hint={user().githubConnected ? `${gitProviderHosts.github.default} · ${user().githubLogin ? `@${user().githubLogin} · ` : ""}signed in` : `${gitProviderHosts.github.default} · Not connected`}
            trailing={user().githubConnected ? <>
                <Badge tone="success">Connected</Badge>
                <Button small variant="ghost" label="Disconnect" testID="disconnect-github" disabled={action.busy()} onPress={() => void disconnectGitHub()} />
              </>
              : opensServerPages ? <Button small variant="outline" label="Sign in" onPress={() => openServerLink("/api/auth/github")} /> : "Sign in on the web"} />
        </If>
        <ResourceState inline loading={accounts.loading() && !accounts.data()} error={accounts.error()} retry={accounts.refresh}>
          <Each of={tokenProviders} key={provider => provider}>
            {provider => {
              const connected = () => accounts.data()?.accounts.filter(account => account.provider === provider()) ?? [];
              return (
                <>
                  <Row leading={<Icon name="branch" size={16} color={palette().muted} />} title={gitProviderNames[provider()]}
                    hint={`${providerHost(provider())} · ${connected().length ? `${connected().length} connected` : "Not connected"}`}
                    trailing={<>
                      <If when={connected().length > 0}><Badge tone="success">Connected</Badge></If>
                      <Button small variant={connected().length ? "ghost" : "outline"} disabled={action.busy()} label={connected().length ? "Add another" : "Connect"}
                        testID={`connect-${provider()}`} onPress={() => connecting.set(provider())} />
                    </>} />
                  <Each of={connected()} key={account => account.id}>
                    {account => (
                      <Row leading={<View style={{ width: 16 }} />} title={`${account().host}${account().organization ? `/${account().organization}` : ""}`} hint={account().login}
                        trailing={<Button small variant="ghost" label="Remove" disabled={action.busy()} onPress={() => void remove(account())} />} />
                    )}
                  </Each>
                </>
              );
            }}
          </Each>
        </ResourceState>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Card>
      <ConnectGitAccountSheet provider={connecting()} close={() => connecting.set(null)} added={accounts.refresh} />
    </View>
  );
}

export function ConnectGitAccountSheet(props: {
  provider: TokenGitProvider | null; close: () => void; added: () => void; save?: (body: Record<string, unknown>) => Promise<void>;
  initial?: { host: string; organization: string; username?: string } | null;
}) {
  const host = signal("");
  const organization = signal("");
  const username = signal("");
  const token = signal("");
  const action = createAction();
  effect(() => {
    const provider = props.provider;
    const initial = props.initial;
    untracked(() => {
      host.set(initial?.host ?? (provider ? gitProviderHosts[provider].default ?? "" : ""));
      organization.set(initial?.organization ?? "");
      username.set(initial?.username ?? "");
      token.set("");
      action.clear();
    });
  });
  const fixedHost = () => (props.provider ? gitProviderHosts[props.provider].fixed : null);
  const forWorkspace = () => Boolean(props.save);
  function dismiss() {
    if (action.busy()) return;
    token.set("");
    props.close();
  }
  const ready = () => Boolean(props.provider && token() && (fixedHost() || host().trim()) && (props.provider !== "azure-devops" || organization().trim())
    && (props.provider !== "git" || username().trim()));
  function submit() {
    const provider = props.provider;
    if (!provider || !ready() || action.busy()) return;
    const body = {
      provider, token: token(),
      ...(fixedHost() ? {} : { host: host().trim() }),
      ...(provider === "azure-devops" ? { organization: organization().trim() } : {}),
      ...((provider === "bitbucket" || provider === "git") && username().trim() ? { username: username().trim() } : {}),
    };
    void action.run(async () => {
      try {
        if (props.save) await props.save(body);
        else await session().api("/api/git/accounts", { method: "POST", body });
      } finally {
        token.set("");
      }
      props.added();
      props.close();
    });
  }
  return (
    <FormSheet open={props.provider !== null} title={`Connect ${props.provider ? gitProviderNames[props.provider] : "Git"}${forWorkspace() ? " for the workspace" : ""}`}
      onClose={dismiss} testID="git-account-sheet"
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={dismiss} />
        <Button testID="git-account-connect" variant="primary" label={action.busy() ? "Verifying…" : "Connect"} disabled={!ready() || action.busy()} onPress={submit} />
      </>}>
      <If when={props.provider}>
        {provider => (
          <>
            <If when={forWorkspace()}><Note>Use a service account made for this, such as a bot or a deploy user, never your own: every member's sessions read with it. It only reads; pushes keep using each session owner's account or the workspace's push access.</Note></If>
            <If when={provider() === "git"}><Note>Any Git server that serves smart HTTP over HTTPS (git http-backend, cgit, Gerrit, a forge without its API). There is no repository list and agents can't open pull requests; you add each repository by its clone URL. SSH isn't supported.</Note></If>
            <If when={!fixedHost()}>
              <Field label="Host" hint={provider() === "git" ? "The host name in the server's https:// clone URLs, with its port if it has one, for example git.example.com" : "HTTPS host name of the instance, without https://, for example git.example.com"}>
                <TextField value={host()} onChange={value => host.set(value)} disabled={action.busy()} placeholder="git.example.com" monospace maxLength={253} />
              </Field>
            </If>
            <If when={provider() === "azure-devops"}>
              <Field label="Organization" hint="From dev.azure.com/<organization>">
                <TextField value={organization()} onChange={value => organization.set(value)} disabled={action.busy()} monospace maxLength={100} />
              </Field>
            </If>
            <If when={provider() === "bitbucket"}>
              <Field label="Username or email" hint="Your Atlassian account email when using an API token (required for agent pushes); leave blank for a workspace or repository access token, which can browse but not push">
                <TextField value={username()} onChange={value => username.set(value)} disabled={action.busy()} monospace maxLength={254} keyboardType="email-address" />
              </Field>
            </If>
            <If when={provider() === "git"}>
              <Field label="User name" hint={forWorkspace() ? "The service account's user name over HTTPS" : "The user name you clone with over HTTPS"}>
                <TextField value={username()} onChange={value => username.set(value)} disabled={action.busy()} monospace maxLength={254} />
              </Field>
            </If>
            <Field label={provider() === "git" ? "Password or token" : "Token"} hint={forWorkspace()
              ? `Read access to the repositories it will read is enough. ${provider() === "git" ? "Encrypted on the server and checked when a repository reads with it" : `Verified with ${gitProviderNames[provider()]}, then encrypted on the server`}`
              : provider() === "git"
              ? `Needs ${tokenScopes.git}. Encrypted on the server and checked when you add a repository: a Git server has no account to verify it against`
              : `Scopes: ${tokenScopes[provider()]}. Verified with ${gitProviderNames[provider()]}, then encrypted on the server`}>
              <TextField testID="git-account-token" value={token()} onChange={value => token.set(value)} disabled={action.busy()} masked onSubmit={submit} />
            </Field>
          </>
        )}
      </If>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}

const setup: Record<DocumentKind, string> = {
  notion: "Create an internal integration at notion.so/profile/integrations with Read content, and share the pages it may read with it (a page's ••• menu → Connections).",
  "google-drive": "Create a service account in Google Cloud with the Drive API enabled, download its JSON key, and share the folders and files it may read with the service account's email, as Viewer.",
  feishu: "Create a custom app in the Feishu or Lark developer console with read access to Drive, Docs and Wiki, publish it, and add it to the folders, documents or wiki spaces it may read.",
  dropbox: "Sign in to Dropbox. Sessions read the folders and files under the workspace's Dropbox sources that your account can see.",
  onedrive: "Sign in with your Microsoft account. Sessions read the OneDrive and SharePoint folders and files under the workspace's sources that you can open.",
  "tencent-docs": "Sign in to Tencent Docs. Sessions read the folders and documents under the workspace's Tencent Docs sources that you can open.",
};

function DocumentAccountsGroup() {
  const resource = createResource<SourceAccountList>(() => "/api/source-accounts");
  const accounts = () => resource.data()?.accounts ?? null;
  const signIn = () => resource.data()?.oauth ?? [];
  const action = createAction();
  const connecting = signal<DocumentKind | null>(null);
  const shown = () => documentKinds.filter(kind => secretKinds.includes(kind) || signIn().includes(kind) || accounts()?.some(account => account.provider === kind));
  async function remove(provider: DocumentKind, name: string) {
    if (action.busy()) return;
    if (!await confirm({ title: `Disconnect ${documentKindNames[provider]}`, destructive: true, confirmLabel: "Disconnect",
      message: `Disconnect ${documentKindNames[provider]} (${name})? Its secret is deleted from the server, and sessions you own can no longer read the workspaces' ${documentKindNames[provider]} sources.` })) return;
    void action.run(async () => {
      await session().api(`/api/source-accounts/${provider}`, { method: "DELETE" });
      resource.refresh();
    }, `${documentKindNames[provider]} disconnected.`);
  }
  return (
    <View testID="document-accounts" style={{ gap: 8 }}>
      <GroupTitle>Documents</GroupTitle>
      <Card>
        <ResourceState inline loading={resource.loading() && !accounts()} error={resource.error()} retry={resource.refresh}>
          <Each of={shown()} key={kind => kind}>
            {provider => {
              const account = () => accounts()?.find(item => item.provider === provider());
              const oauth = () => signIn().includes(provider());
              const paste = () => secretKinds.includes(provider());
              return (
                <Row leading={<Icon name="file" size={16} color={palette().muted} />} title={documentKindNames[provider()]}
                  hint={account() ? `${account()!.name}${account()!.method === "oauth" ? " · signed in" : ""}` : "Not connected"}
                  trailing={<>
                    <If when={account()}><Badge tone="success">Connected</Badge></If>
                    <If when={oauth() && opensServerPages}>
                      <Button small variant={account() ? "ghost" : "outline"} label={account() ? "Sign in again" : "Sign in"}
                        onPress={() => openServerLink(`/api/source-accounts/${provider()}/oauth/start`)} />
                    </If>
                    <If when={paste()}>
                      <Button small variant={account() || oauth() ? "ghost" : "outline"} disabled={action.busy()} label={oauth() ? "Paste secret" : account() ? "Replace" : "Connect"}
                        onPress={() => connecting.set(provider())} />
                    </If>
                    <If when={account()}>
                      <Button small variant="ghost" label="Disconnect" disabled={action.busy()} onPress={() => void remove(provider(), account()!.name)} />
                    </If>
                  </>} />
              );
            }}
          </Each>
        </ResourceState>
        <If when={!opensServerPages && signIn().length > 0}>
          <CardBody><Note>Providers you sign in to (Dropbox, OneDrive, Tencent Docs) connect from Pikibun on the web.</Note></CardBody>
        </If>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Card>
      <ConnectDocumentSheet provider={connecting()} close={() => connecting.set(null)} connected={resource.refresh} />
    </View>
  );
}

export function ConnectDocumentSheet(props: {
  provider: DocumentKind | null; close: () => void; connected: () => void; save?: (provider: DocumentKind, body: Record<string, unknown>) => Promise<void>;
}) {
  const secret = signal("");
  const appId = signal("");
  const domain = signal<FeishuDomain>("feishu");
  const action = createAction();
  const reset = () => { secret.set(""); appId.set(""); domain.set("feishu"); };
  function dismiss() {
    if (action.busy()) return;
    reset();
    props.close();
  }
  const ready = () => Boolean(secret().trim() && (props.provider !== "feishu" || appId().trim()));
  function submit() {
    const provider = props.provider;
    if (!provider || !ready() || action.busy()) return;
    const body = provider === "notion" ? { token: secret().trim() } : provider === "google-drive" ? { key: secret() } : { appId: appId().trim(), appSecret: secret().trim(), domain: domain() };
    void action.run(async () => {
      try {
        if (props.save) await props.save(provider, body);
        else await session().api(`/api/source-accounts/${provider}`, { method: "PUT", body });
      } finally {
        secret.set("");
      }
      reset();
      props.connected();
      props.close();
    });
  }
  const name = () => (props.provider ? documentKindNames[props.provider] : "");
  return (
    <FormSheet open={props.provider !== null} title={`Connect ${name()}${props.save ? " for the workspace" : ""}`} onClose={dismiss}
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={dismiss} />
        <Button variant="primary" label={action.busy() ? "Verifying…" : "Connect"} disabled={!ready() || action.busy()} onPress={submit} />
      </>}>
      <If when={props.provider}>
        {provider => (
          <>
            <Note>{`${setup[provider()]} Pikibun verifies it with ${name()}, then encrypts it on the server.`}</Note>
            <If when={props.save}><Note>This is the workspace's connection: every member's sessions read the sources set to it with it. Share with it only what the workspace should read.</Note></If>
            <If when={provider() === "notion"}>
              <Field label="Internal integration secret"><TextField value={secret()} onChange={value => secret.set(value)} disabled={action.busy()} masked placeholder="ntn_…" /></Field>
            </If>
            <If when={provider() === "google-drive"}>
              <Field label="Service account JSON key" hint="The whole key file. Only its email and private key are kept">
                <TextField value={secret()} onChange={value => secret.set(value)} disabled={action.busy()} multiline monospace minHeight={140} placeholder='{"type": "service_account", …}' />
              </Field>
            </If>
            <If when={provider() === "feishu"}>
              <Field label="Platform">
                <Select<FeishuDomain> label="Platform" value={domain()} disabled={action.busy()} onChange={value => domain.set(value)}
                  options={[{ value: "feishu", label: "Feishu", hint: "open.feishu.cn" }, { value: "lark", label: "Lark", hint: "open.larksuite.com" }]} />
              </Field>
              <Field label="App ID"><TextField value={appId()} onChange={value => appId.set(value)} disabled={action.busy()} monospace placeholder="cli_…" /></Field>
              <Field label="App Secret"><TextField value={secret()} onChange={value => secret.set(value)} disabled={action.busy()} masked /></Field>
            </If>
          </>
        )}
      </If>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}

export function ConnectedAccountsSection() {
  return (
    <Section bare title="Connected accounts" testID="connected-accounts"
      info={<View style={{ gap: 8 }}>
        <Note>Sessions you own work on the workspaces' sources with your own accounts here, through Pikibun.</Note>
        <Note>{gitAccountsInfo}</Note>
        <Note>Documents are read with your own connections: sign in to a provider, or for Notion, Google Drive and Feishu/Lark paste a secret. Their tokens and secrets are encrypted on the server, refreshed there, and never sent to any host, yours included. Each provider lets its connection read only what you share with it, and sessions read only what lies under the workspace's sources.</Note>
        <Note>Connecting an account doesn't change how you sign in; viewing a session, sharing a host or publishing an agent never grants access to your accounts.</Note>
      </View>}>
      <View style={{ gap: 24 }}>
        <GitAccountsGroup />
        <DocumentAccountsGroup />
      </View>
    </Section>
  );
}
