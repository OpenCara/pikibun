import { signal, Text, untracked, View } from "nsh";
import {
  remoteMcpLimits, remoteMcpSignInHeaders, remoteMcpSignInMethods, remoteMcpSignInOf, type RemoteMcpSignInMethod, type WorkspaceMcpServer,
} from "../../../../packages/shared/src/remote-mcp";
import { descriptionSummary } from "../../../../packages/shared/src/workspace-tools";
import { segment, type Workspace } from "../shared";
import { session } from "../lib/auth";
import { openServerLink, opensServerPages } from "../lib/links";
import { createAction, createResource } from "../lib/resource";
import { Icon } from "../icons";
import { monospace, palette, text } from "../theme";
import { Checkbox, Field, RadioGroup, TextField } from "../form";
import { Badge, Banner, Button, CardBody, CollapsibleRow, confirm, EmptyState, Feedback, FormSheet, Note, ResourceState, Section, Small } from "../ui";

interface McpServersResponse { servers: WorkspaceMcpServer[]; admin: boolean }

export function WorkspaceMcpServers(props: { workspace: Workspace }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/mcp-servers`;
  const resource = createResource<McpServersResponse>(path);
  const action = createAction();
  const adding = signal(false);
  const changing = signal<WorkspaceMcpServer | undefined>(undefined);
  const data = () => resource.data();
  const admin = () => data()?.admin === true;
  async function patch(server: WorkspaceMcpServer, body: Record<string, unknown>, notice: string) {
    if (await action.run(async () => { await session().api(`${path()}/${segment(server.id)}`, { method: "PATCH", body }); }, notice)) resource.refresh();
  }
  async function remove(server: WorkspaceMcpServer) {
    if (!await confirm({ title: `Remove ${server.name}?`, confirmLabel: "Remove", destructive: true,
      message: "Sessions stop offering its tools from their next message, and Pikibun deletes the headers it kept for it." })) return;
    if (await action.run(async () => { await session().api(`${path()}/${segment(server.id)}`, { method: "DELETE" }); }, "Removed.")) resource.refresh();
  }
  async function signOut(server: WorkspaceMcpServer) {
    if (!await confirm({ title: `Sign out of ${server.name}?`, confirmLabel: "Sign out", destructive: true,
      message: "Pikibun deletes the sign-in it kept for it. Its tools stay listed but fail until an owner or admin signs in again." })) return;
    if (await action.run(async () => { await session().api(`${path()}/${segment(server.id)}/oauth`, { method: "DELETE" }); }, "Signed out.")) resource.refresh();
  }
  const signIn = (server: WorkspaceMcpServer) => openServerLink(`${path()}/${segment(server.id)}/oauth/start`);
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
                    hint={server().error ? `${server().url}\n${server().error}` : `${server().url}\n${server().tools.length} ${server().tools.length === 1 ? "tool" : "tools"}${server().oauth ? " · signed in" : ""}${server().headerNames.length ? ` · headers: ${server().headerNames.join(", ")}` : ""}`}
                    trailing={<Badge tone={server().error ? "danger" : server().enabled ? "success" : "neutral"}>{server().error ? "Error" : server().enabled ? "On" : "Off"}</Badge>}>
                    <If when={server().error}><Banner tone="danger" title={server().error!.startsWith("Signing in failed") ? "It couldn't be signed in to" : "Its tools couldn't be listed"}>{server().error!}</Banner></If>
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
                    <If when={admin()}>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                        <Checkbox label="Enabled" checked={server().enabled} disabled={action.busy()}
                          onChange={on => void patch(server(), { enabled: on }, on ? "Sessions offer its tools from their next message." : "Sessions stop offering its tools from their next message.")} />
                        <View style={{ flex: 1 }} />
                        <If when={server().oauth || !server().headerNames.length}>
                          <If when={opensServerPages} else={<Small>Sign in to it from Pikibun on the web.</Small>}>
                            <Button small variant="outline" label={server().oauth ? "Sign in again" : "Sign in"} disabled={action.busy()} onPress={() => signIn(server())} />
                          </If>
                        </If>
                        <If when={server().oauth}>
                          <Button small variant="ghost" label="Sign out" disabled={action.busy()} onPress={() => void signOut(server())} />
                        </If>
                        <Button small variant="outline" label="Change sign-in" disabled={action.busy()} onPress={() => changing.set(server())} />
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
    </Section>
  );
}

function signInForm(initial: RemoteMcpSignInMethod) {
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
  const form = signInForm("oauth");
  const ready = () => name().trim() && /^[a-z][a-z0-9]{0,15}$/.test(prefix()) && url().startsWith("https://") && !!form.headers();
  function submit() {
    const headers = form.headers();
    if (!ready() || !headers) return;
    void props.save({ name: name().trim(), prefix: prefix(), url: url().trim(), ...(Object.keys(headers).length ? { headers } : {}) });
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
      {form.fields(() => props.busy)}
      <Note>Its tools may change things until you mark them read-only once they are listed.</Note>
      <Feedback error={props.error} />
    </FormSheet>
  );
}
