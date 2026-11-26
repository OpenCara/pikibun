import { cleanup, openUrl, signal, Text, untracked, UrlScheme, View } from "nsh";
import {
  parseRemoteMcpAppCode, REMOTE_MCP_APP_LINK, remoteMcpLeftOutNote, remoteMcpLimits, remoteMcpSignInAsOptions, remoteMcpSignInHeaders, remoteMcpSignInMethods, remoteMcpSignInOf,
  type McpConnection, type RemoteMcpSignInAs, type RemoteMcpSignInMethod, type WorkspaceMcpServer,
} from "../../../../packages/shared/src/remote-mcp";
import { descriptionSummary } from "../../../../packages/shared/src/workspace-tools";
import { segment, type Workspace } from "../shared";
import type { PageRoute } from "../lib/page";
import { session } from "../lib/auth";
import { openServerLink, opensServerPages } from "../lib/links";
import { currentOrigin, displayOrigin } from "../lib/server";
import { createAction, createResource } from "../lib/resource";
import { Icon } from "../icons";
import { monospace, palette, text } from "../theme";
import { Checkbox, Field, RadioGroup, Select, TextField } from "../form";
import { Badge, Banner, Button, CardBody, CollapsibleRow, confirm, CopyButton, EmptyState, Feedback, FormSheet, Note, ResourceState, Section, Small } from "../ui";
import { ConnectionSheet } from "./mcp-connections";

interface McpServersResponse { servers: WorkspaceMcpServer[]; admin: boolean }

const signInFailed = (server: WorkspaceMcpServer) => !!server.error?.startsWith("Signing in failed");

const signInAsOf = (server: WorkspaceMcpServer): RemoteMcpSignInAs => server.signInAs ?? "workspace";
const signInAsLabel = (value: RemoteMcpSignInAs) => remoteMcpSignInAsOptions.find(option => option.value === value)?.label ?? value;

function mcpErrorTitle(server: WorkspaceMcpServer): string {
  if (signInFailed(server)) return "It couldn't be signed in to";
  return server.oauth ? "Signed in, but its tools couldn't be listed" : "Its tools couldn't be listed";
}

export function WorkspaceMcpServers(props: { workspace: Workspace; go?: (route: PageRoute) => void }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/mcp-servers`;
  const resource = createResource<McpServersResponse>(path);
  const action = createAction();
  const adding = signal(false);
  const changing = signal<WorkspaceMcpServer | undefined>(undefined);
  const connecting = signal<WorkspaceMcpServer | undefined>(undefined);
  const data = () => resource.data();
  const connectionPath = (connectionId: string) => `/api/mcp-connections/${segment(connectionId)}/workspaces/${segment(props.workspace.id)}`;
  async function useConnection(server: WorkspaceMcpServer, use: boolean) {
    if (!server.connection) return;
    const connectionId = server.connection.id;
    if (await action.run(async () => { await session().api(connectionPath(connectionId), { method: use ? "PUT" : "DELETE" }); },
      use ? "Your requests use your own connection from your next message." : "Your requests no longer use your own connection here.")) resource.refresh();
  }
  async function connect(body: Record<string, unknown>) {
    let added: McpConnection | undefined;
    const done = await action.run(async () => {
      added = (await session().api<{ connection: McpConnection }>("/api/mcp-connections", { method: "POST", body })).connection;
      await session().api(connectionPath(added.id), { method: "PUT" });
    }, () => added && !added.headerNames.length && added.error
      ? (opensServerPages ? "Connected. Signing in…" : "Connected. Sign in to it under Settings → Profile → Connected accounts.")
      : "Connected. Your requests use it from your next message.");
    resource.refresh();
    if (!done) return;
    connecting.set(undefined);
    if (added && !added.headerNames.length && added.error && opensServerPages) openServerLink(`/api/mcp-connections/${segment(added.id)}/oauth/start`);
  }
  const admin = () => data()?.admin === true;
  async function patch(server: WorkspaceMcpServer, body: Record<string, unknown>, notice: string) {
    if (await action.run(async () => { await session().api(`${path()}/${segment(server.id)}`, { method: "PATCH", body }); }, notice)) resource.refresh();
  }
  async function remove(server: WorkspaceMcpServer) {
    if (!await confirm({ title: `Remove ${server.name}?`, confirmLabel: "Remove", destructive: true,
      message: server.sharedBy ? `Sessions stop offering its tools from their next message. ${server.sharedBy.mine ? "Your" : `${server.sharedBy.name}'s`} connection to it stays, no longer shared here.`
        : "Sessions stop offering its tools from their next message, and Pikibun deletes the headers it kept for it." })) return;
    if (await action.run(async () => { await session().api(`${path()}/${segment(server.id)}`, { method: "DELETE" }); }, "Removed.")) resource.refresh();
  }
  async function signOut(server: WorkspaceMcpServer) {
    if (!await confirm({ title: `Sign out of ${server.name}?`, confirmLabel: "Sign out", destructive: true,
      message: "Pikibun deletes the sign-in it kept for it. Its tools stay listed but fail until an owner or admin signs in again." })) return;
    if (await action.run(async () => { await session().api(`${path()}/${segment(server.id)}/oauth`, { method: "DELETE" }); }, "Signed out.")) resource.refresh();
  }
  const signIn = (server: WorkspaceMcpServer) => openServerLink(`${path()}/${segment(server.id)}/oauth/start`);
  const finishing = signal<{ server: WorkspaceMcpServer; url: string } | undefined>(undefined);
  const pasted = signal("");
  async function signInFromApp(server: WorkspaceMcpServer) {
    await action.run(async () => {
      const { url } = await session().api<{ url: string }>(`${path()}/${segment(server.id)}/oauth/app`, { method: "POST" });
      pasted.set("");
      finishing.set({ server, url });
      await openUrl(url).catch(() => undefined);
    });
  }
  async function finish(input: string) {
    const parsed = parseRemoteMcpAppCode(input);
    let listed: WorkspaceMcpServer | undefined;
    const done = await action.run(async () => {
      if (!parsed) throw new Error("That isn't a sign-in code: copy the code, or the whole pikibun:// link, from the page your browser ended on.");
      if (parsed.server !== null && currentOrigin(parsed.server) !== session().origin) {
        throw new Error(`That code is for another Pikibun server (${displayOrigin(parsed.server)}): finish it in the app signed in there.`);
      }
      listed = (await session().api<{ server: WorkspaceMcpServer }>("/api/mcp-servers/oauth/app/finish", { method: "POST", body: { code: parsed.code } })).server;
    }, () => listed?.error ? `Signed in, but its tools couldn't be listed: ${listed.error}` : "Signed in. Sessions use its tools from their next message.");
    if (done) {
      finishing.set(undefined);
      pasted.set("");
    }
    resource.refresh();
  }
  if (!opensServerPages) {
    cleanup(UrlScheme.on("open", ({ url }) => {
      if (url.startsWith(REMOTE_MCP_APP_LINK) && untracked(finishing)) void finish(url);
    }));
  }
  async function changeSignIn(server: WorkspaceMcpServer, method: RemoteMcpSignInMethod, headers: Record<string, string>) {
    const notice = method === "oauth" ? (server.oauth ? "It signs in with OAuth." : "Now sign in to it with Sign in.")
      : method === "none" ? "It now sends no sign-in." : "Its new sign-in is kept encrypted.";
    const done = await action.run(async () => {
      if (method !== "oauth" || server.headerNames.length) {
        await session().api(`${path()}/${segment(server.id)}`, { method: "PATCH", body: { headers: Object.keys(headers).length ? headers : null } });
      }
      if (method !== "oauth" && server.oauth) await session().api(`${path()}/${segment(server.id)}/oauth`, { method: "DELETE" });
    }, notice);
    if (done) {
      changing.set(undefined);
      resource.refresh();
    }
  }
  return (
    <Section title="Remote MCP servers" testID="workspace-mcp-servers" info={<View style={{ gap: 8 }}>
      <Note>Remote MCP servers add tools to this workspace's sessions without anything installed on hosts: Pikibun itself calls each server's https:// address, with headers (an API key, say) it keeps encrypted, which no session or host ever sees.</Note>
      <Note>Each server signs in one way, chosen when it's added and changed with Change sign-in: OAuth, a token, a username and password, a custom header, or none. With OAuth, an owner or admin signs in to it once with Sign in, as the account the workspace's sessions use, and Pikibun keeps and renews the sign-in. A server whose OAuth sign-in fails takes a token or a password instead.</Note>
      <Note>Owners and admins also choose whose sign-in it calls with: the workspace's, each member's own, or each member's own else the workspace's. Members connect their own account once in their profile, or here with Connect my account, and choose the workspaces that use it; a request then uses the requester's own account, never anyone else's.</Note>
      <Note>Each tool's name starts with its server's prefix. Tools may change things unless an owner or admin marks them read-only here: only those run in Read-only messages. A server's own claim that a tool only reads counts for nothing.</Note>
      <Note>A server's answers were written by whoever runs it: sessions treat them as information, not as instructions.</Note>
    </View>} action={admin() && (data()?.servers.length ?? 0) < remoteMcpLimits.servers ? <Button small variant="outline" icon="plus" label="Add server" onPress={() => adding.set(true)} /> : undefined}>
      <ResourceState inline loading={resource.loading() && !data()} error={resource.error()} retry={resource.refresh}>
        <If when={data()}>
          {current => (
            <>
              <If when={!current().servers.length}>
                <EmptyState title="No remote MCP servers">{admin() ? "Add one by its https:// address to offer its tools to every session here." : "Owners and admins add the remote MCP servers this workspace's sessions use."}</EmptyState>
              </If>
              <Each of={current().servers} key={server => server.id}>
                {server => (
                  <CollapsibleRow leading={<Icon name="sparkles" size={16} color={palette().muted} />} title={`${server().name} · ${server().prefix}_`}
                    hint={server().error ? `${server().url}\n${server().oauth && !signInFailed(server()) ? "Signed in · " : ""}${server().error}` : `${server().url}\n${server().tools.length} ${server().tools.length === 1 ? "tool" : "tools"}${server().toolsLeftOut ? " (some left out)" : ""}${server().oauth ? " · signed in" : ""}${server().headerNames.length ? ` · headers: ${server().headerNames.join(", ")}` : ""}${signInAsOf(server()) !== "workspace" ? ` · ${signInAsLabel(signInAsOf(server())).toLowerCase()}` : ""}`}
                    trailing={<Badge tone={server().error ? "danger" : server().enabled ? "success" : "neutral"}>{server().error ? "Error" : server().enabled ? "On" : "Off"}</Badge>}>
                    <If when={server().error}><Banner tone="danger" title={mcpErrorTitle(server())}>{server().error!}</Banner></If>
                    <If when={server().toolsLeftOut}><Banner tone="warning" title="Some of its tools are left out">{remoteMcpLeftOutNote(server().toolsLeftOut)}</Banner></If>
                    <If when={server().oauth}><Small>{`Signed in with OAuth on ${new Date(server().oauth!.signedInAt).toLocaleString()}.`}</Small></If>
                    <Each of={server().tools} key={tool => tool.name}>
                      {(tool, index) => (
                        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 4, paddingVertical: 8, borderTopWidth: index() ? 1 : 0, borderColor: palette().border }}>
                          <View style={{ flex: 1, minWidth: 180, gap: 2 }}>
                            <Text style={{ fontFamily: monospace, fontSize: text.small, color: palette().text }}>{tool().toolName}</Text>
                            <Small>{descriptionSummary(tool().description, 200) || "No description"}</Small>
                          </View>
                          <If when={admin()} else={<Badge tone={tool().readOnly ? "success" : "warning"}>{tool().readOnly ? "Read-only" : "May write"}</Badge>}>
                            <Checkbox label="Read-only" checked={tool().readOnly} disabled={action.busy()}
                              onChange={on => void patch(server(), { readOnlyTools: on ? [...server().readOnlyTools, tool().name] : server().readOnlyTools.filter(item => item !== tool().name) },
                                on ? `${tool().toolName} now runs in Read-only messages too.` : `${tool().toolName} no longer runs in Read-only messages.`)} />
                          </If>
                        </View>
                      )}
                    </Each>
                    <If when={!server().tools.length && !server().error}><Small>It offers no tools.</Small></If>
                    <If when={server().sharedBy}>
                      {sharer => (
                        <View testID={`mcp-shared-by-${server().prefix}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                          <View style={{ flex: 1, minWidth: 180 }}>
                            <Small>{sharer().active
                              ? `${sharer().mine ? "You" : sharer().name} shared ${sharer().mine ? "your" : "their"} own connection to it with this workspace: every member's requests call it with ${sharer().mine ? "your" : `${sharer().name}'s`} account.`
                              : `${sharer().mine ? "You" : sharer().name}, who shared ${sharer().mine ? "your" : "their"} connection to it, ${sharer().mine ? "are" : "is"} no longer an owner or admin here: its tools aren't offered. Remove it.`}</Small>
                          </View>
                          <If when={sharer().mine && sharer().active}>
                            <Button small variant="outline" label="Manage sharing" onPress={() => props.go?.({ name: "settings", section: "mcp-sharing" })} />
                          </If>
                        </View>
                      )}
                    </If>
                    <If when={signInAsOf(server()) !== "workspace"}>
                      <View testID={`mcp-own-connection-${server().prefix}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                        <View style={{ flex: 1, minWidth: 180 }}>
                          <Small>{server().connection?.using
                            ? `Your requests use your own connection, ${server().connection!.name}.${server().connection!.error ? ` It needs attention: ${server().connection!.error}` : ""}`
                            : server().connection ? `You have a connection to it, ${server().connection!.name}, which this workspace doesn't use yet.`
                            : signInAsOf(server()) === "members" ? "Its tools run for you once you connect your own account to it." : "Your requests use the workspace's sign-in until you connect your own account."}</Small>
                        </View>
                        <If when={server().connection} else={<Button small variant="outline" label="Connect my account" testID={`mcp-connect-${server().prefix}`} disabled={action.busy()} onPress={() => connecting.set(server())} />}>
                          <Button small variant={server().connection!.using ? "ghost" : "outline"} label={server().connection!.using ? "Stop using mine" : "Use my connection"}
                            testID={`mcp-use-connection-${server().prefix}`} disabled={action.busy()} onPress={() => void useConnection(server(), !server().connection!.using)} />
                        </If>
                      </View>
                    </If>
                    <If when={admin() && !server().sharedBy}>
                      <Field label="Whose sign-in">
                        <Select<RemoteMcpSignInAs> label="Whose sign-in" value={signInAsOf(server())} disabled={action.busy()}
                          onChange={value => void patch(server(), { signInAs: value }, `It now calls with ${signInAsLabel(value).toLowerCase()}.`)}
                          options={remoteMcpSignInAsOptions.map(option => ({ value: option.value, label: option.label, hint: option.hint }))} />
                      </Field>
                    </If>
                    <If when={admin()}>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                        <Checkbox label="Enabled" checked={server().enabled} disabled={action.busy()}
                          onChange={on => void patch(server(), { enabled: on }, on ? "Sessions offer its tools from their next message." : "Sessions stop offering its tools from their next message.")} />
                        <View style={{ flex: 1 }} />
                        <If when={!server().sharedBy && (server().oauth || !server().headerNames.length)}>
                          <Button small variant="outline" label={server().oauth ? "Sign in again" : "Sign in"} testID={`mcp-sign-in-${server().prefix}`} disabled={action.busy()}
                            onPress={() => (opensServerPages ? signIn(server()) : void signInFromApp(server()))} />
                        </If>
                        <If when={!server().sharedBy && server().oauth}>
                          <Button small variant="ghost" label="Sign out" disabled={action.busy()} onPress={() => void signOut(server())} />
                        </If>
                        <If when={!server().sharedBy}>
                          <Button small variant="outline" label="Change sign-in" disabled={action.busy()} onPress={() => changing.set(server())} />
                        </If>
                        <Button small variant="outline" icon="refresh" label="List tools again" disabled={action.busy()} onPress={() => void patch(server(), { refresh: true }, "Listed its tools again.")} />
                        <Button small variant="ghost" icon="trash" label="Remove" disabled={action.busy()} onPress={() => void remove(server())} />
                      </View>
                    </If>
                  </CollapsibleRow>
                )}
              </Each>
            </>
          )}
        </If>
      </ResourceState>
      <If when={finishing()}>
        {current => (
          <CardBody>
            <View testID="mcp-app-sign-in" style={{ gap: 8 }}>
              <Banner tone="info" title={`Signing in to ${current().server.name}`}
                actions={<Button small variant="ghost" label="Cancel" testID="mcp-app-cancel" disabled={action.busy()} onPress={() => finishing.set(undefined)} />}>
                Finish signing in in your browser. Its last page opens Pikibun, which finishes here, or shows a code to paste below.
              </Banner>
              <Field label="Code">
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <TextField flex monospace testID="mcp-app-code" value={pasted()} onChange={value => pasted.set(value)} disabled={action.busy()}
                    placeholder="Code or pikibun:// link" autoCapitalize="none" autoCorrect={false} maxLength={512} onSubmit={() => void finish(pasted())} />
                  <Button small variant="primary" label="Finish" testID="mcp-app-finish" disabled={action.busy() || !pasted().trim()} onPress={() => void finish(pasted())} />
                </View>
              </Field>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1 }}><Small>No browser opened? Copy this link into one. It works once, for 10 minutes.</Small></View>
                <CopyButton value={current().url} label="Copy link" testID="mcp-app-copy-link" />
              </View>
            </View>
          </CardBody>
        )}
      </If>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      <If when={adding()}>
        <AddServerSheet busy={action.busy()} error={action.error()} close={() => adding.set(false)}
          save={async body => {
            if (await action.run(async () => { await session().api(path(), { method: "POST", body }); }, "Added. Sessions offer its tools from their next message.")) {
              adding.set(false);
              resource.refresh();
            }
          }} />
      </If>
      <If when={changing()}>
        {server => (
          <SignInSheet server={server()} busy={action.busy()} error={action.error()} close={() => changing.set(undefined)}
            save={(method, headers) => changeSignIn(server(), method, headers)} />
        )}
      </If>
      <If when={connecting()}>
        {server => (
          <ConnectionSheet initial={{ name: server().name, url: server().url }} busy={action.busy()} error={action.error()} close={() => connecting.set(undefined)}
            save={body => connect(body)} />
        )}
      </If>
    </Section>
  );
}

export function signInForm(initial: RemoteMcpSignInMethod) {
  const method = signal(untracked(() => initial));
  const token = signal("");
  const username = signal("");
  const password = signal("");
  const headerName = signal("");
  const headerValue = signal("");
  const touched = () => !!(token() || username() || password() || headerName() || headerValue());
  const result = (): { headers: Record<string, string> } | { error: string } => {
    try {
      const chosen = method();
      return { headers: remoteMcpSignInHeaders(chosen === "token" ? { method: chosen, token: token() }
        : chosen === "basic" ? { method: chosen, username: username(), password: password() }
        : chosen === "header" ? { method: chosen, name: headerName(), value: headerValue() }
        : { method: chosen }) };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  const headers = () => { const found = result(); return "headers" in found ? found.headers : undefined; };
  const problem = () => { const found = result(); return "error" in found && touched() ? found.error : undefined; };
  function fields(busy: () => boolean) {
    return (
      <View style={{ gap: 12 }}>
        <Field label="Sign-in" hint="Kept encrypted: nobody sees a token or password again, and no session or host ever gets it">
          <RadioGroup<RemoteMcpSignInMethod> value={method()} disabled={busy()} onChange={next => method.set(next)}
            options={remoteMcpSignInMethods.map(option => ({ value: option.value, label: option.label, hint: option.hint }))} />
        </Field>
        <If when={method() === "token"}>
          <Field label="Token" error={problem()}>
            <TextField masked value={token()} onChange={next => token.set(next)} disabled={busy()} maxLength={remoteMcpLimits.headerValue} placeholder="Token or API key" />
          </Field>
        </If>
        <If when={method() === "basic"}>
          <View style={{ gap: 12 }}>
            <Field label="Username">
              <TextField value={username()} onChange={next => username.set(next)} disabled={busy()} maxLength={256} autoCapitalize="none" autoCorrect={false} />
            </Field>
            <Field label="Password" error={problem()}>
              <TextField masked value={password()} onChange={next => password.set(next)} disabled={busy()} maxLength={1024} />
            </Field>
          </View>
        </If>
        <If when={method() === "header"}>
          <Field label="Header" error={problem()}>
            <View style={{ gap: 8 }}>
              <TextField monospace value={headerName()} onChange={next => headerName.set(next)} disabled={busy()} maxLength={remoteMcpLimits.headerName} placeholder="X-API-Key" />
              <TextField masked value={headerValue()} onChange={next => headerValue.set(next)} disabled={busy()} maxLength={remoteMcpLimits.headerValue} placeholder="Value" />
            </View>
          </Field>
        </If>
      </View>
    );
  }
  return { method, headers, fields };
}

function SignInSheet(props: { server: WorkspaceMcpServer; busy: boolean; error: string; close: () => void; save: (method: RemoteMcpSignInMethod, headers: Record<string, string>) => Promise<void> }) {
  const form = signInForm(untracked(() => remoteMcpSignInOf(props.server)));
  const ready = () => !!form.headers();
  function submit() {
    const headers = form.headers();
    if (headers) void props.save(form.method(), headers);
  }
  return (
    <FormSheet open title={`Sign-in for ${props.server.name}`} onClose={() => { if (!props.busy) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.close} />
        <Button variant="primary" label={props.busy ? "Saving…" : "Save"} disabled={props.busy || !ready()} onPress={submit} />
      </>}>
      {form.fields(() => props.busy)}
      <Note>Saving replaces the sign-in Pikibun keeps for it: a token, password or header it kept before, and an OAuth sign-in unless you keep OAuth. Pikibun then lists its tools again.</Note>
      <Feedback error={props.error} />
    </FormSheet>
  );
}

function AddServerSheet(props: { busy: boolean; error: string; close: () => void; save: (body: Record<string, unknown>) => Promise<void> }) {
  const name = signal("");
  const prefix = signal("");
  const url = signal("");
  const signInAs = signal<RemoteMcpSignInAs>("workspace");
  const form = signInForm("oauth");
  const ready = () => name().trim() && /^[a-z][a-z0-9]{0,15}$/.test(prefix()) && url().startsWith("https://") && !!form.headers();
  function submit() {
    const headers = form.headers();
    if (!ready() || !headers) return;
    void props.save({ name: name().trim(), prefix: prefix(), url: url().trim(), ...(Object.keys(headers).length ? { headers } : {}),
      ...(signInAs() !== "workspace" ? { signInAs: signInAs() } : {}) });
  }
  return (
    <FormSheet open title="Add remote MCP server" onClose={() => { if (!props.busy) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.close} />
        <Button variant="primary" label={props.busy ? "Adding…" : "Add"} disabled={props.busy || !ready()} onPress={submit} />
      </>}>
      <Field label="Name"><TextField value={name()} onChange={value => name.set(value)} disabled={props.busy} maxLength={remoteMcpLimits.name} placeholder="Linear" autoFocus /></Field>
      <Field label="Prefix" hint="Starts each of its tools' names: a lowercase letter, then up to 15 lowercase letters or digits">
        <TextField monospace value={prefix()} onChange={value => prefix.set(value)} disabled={props.busy} maxLength={16} placeholder="linear" autoCapitalize="none" autoCorrect={false} />
      </Field>
      <Field label="Address" hint="The server's Streamable HTTP endpoint. Pikibun reaches public https:// addresses only">
        <TextField monospace value={url()} onChange={value => url.set(value)} disabled={props.busy} maxLength={remoteMcpLimits.url} placeholder="https://mcp.example.com/mcp" keyboardType="url" autoCapitalize="none" autoCorrect={false} />
      </Field>
      <Field label="Whose sign-in" hint="Members connect their own account in their profile, or on this page once it's added">
        <RadioGroup<RemoteMcpSignInAs> value={signInAs()} disabled={props.busy} onChange={next => signInAs.set(next)}
          options={remoteMcpSignInAsOptions.map(option => ({ value: option.value, label: option.label, hint: option.hint }))} />
      </Field>
      {form.fields(() => props.busy)}
      <Note>Its tools may change things until you mark them read-only once they are listed.</Note>
      <Feedback error={props.error} />
    </FormSheet>
  );
}
