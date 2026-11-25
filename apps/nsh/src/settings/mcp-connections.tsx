import { cleanup, openUrl, signal, untracked, UrlScheme, View } from "nsh";
import {
  parseRemoteMcpAppCode, REMOTE_MCP_APP_LINK, remoteMcpLimits, remoteMcpSignInOf, type McpConnection, type RemoteMcpSignInMethod,
} from "../../../../packages/shared/src/remote-mcp";
import { segment } from "../shared";
import { session } from "../lib/auth";
import { openServerLink, opensServerPages } from "../lib/links";
import { currentOrigin, displayOrigin } from "../lib/server";
import { createAction, createResource } from "../lib/resource";
import { Icon } from "../icons";
import { palette } from "../theme";
import { Field, TextField } from "../form";
import { Badge, Banner, Button, CardBody, CollapsibleRow, confirm, CopyButton, Feedback, FormSheet, Note, ResourceState, Row, Small } from "../ui";
import { Card, GroupTitle } from "./accounts";
import { signInForm } from "./workspace-mcp-servers";

const base = "/api/mcp-connections";

function connectionHint(connection: McpConnection): string {
  const how = connection.oauth ? "signed in with OAuth" : connection.headerNames.length ? `headers: ${connection.headerNames.join(", ")}` : "no sign-in";
  const used = connection.workspaces.length ? `used in ${connection.workspaces.map(item => item.name).join(", ")}` : "used in no workspace";
  return `${connection.url}\n${connection.error ? connection.error : `${how} · ${used}`}`;
}

export function appSignInFinisher(done: () => void) {
  const finishing = signal<{ name: string; url: string } | undefined>(undefined);
  const pasted = signal("");
  const action = createAction();
  async function finish(input: string) {
    const parsed = parseRemoteMcpAppCode(input);
    let listed: McpConnection | undefined;
    const ok = await action.run(async () => {
      if (!parsed) throw new Error("That isn't a sign-in code: copy the code, or the whole pikibun:// link, from the page your browser ended on.");
      if (parsed.server !== null && currentOrigin(parsed.server) !== session().origin) {
        throw new Error(`That code is for another Pikibun server (${displayOrigin(parsed.server)}): finish it in the app signed in there.`);
      }
      listed = (await session().api<{ connection?: McpConnection }>("/api/mcp-servers/oauth/app/finish", { method: "POST", body: { code: parsed.code } })).connection;
    }, () => listed?.error ? `Signed in, but the server answered: ${listed.error}` : "Signed in.");
    if (ok) {
      finishing.set(undefined);
      pasted.set("");
    }
    done();
  }
  if (!opensServerPages) {
    cleanup(UrlScheme.on("open", ({ url }) => {
      if (url.startsWith(REMOTE_MCP_APP_LINK) && untracked(finishing)) void finish(url);
    }));
  }
  async function start(name: string, path: string) {
    await action.run(async () => {
      const { url } = await session().api<{ url: string }>(path, { method: "POST" });
      pasted.set("");
      finishing.set({ name, url });
      await openUrl(url).catch(() => undefined);
    });
  }
  function Panel() {
    return (
      <If when={finishing()}>
        {current => (
          <CardBody>
            <View testID="mcp-connection-app-sign-in" style={{ gap: 8 }}>
              <Banner tone="info" title={`Signing in to ${current().name}`}
                actions={<Button small variant="ghost" label="Cancel" disabled={action.busy()} onPress={() => finishing.set(undefined)} />}>
                Finish signing in in your browser. Its last page opens Pikibun, which finishes here, or shows a code to paste below.
              </Banner>
              <Field label="Code">
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <TextField flex monospace value={pasted()} onChange={value => pasted.set(value)} disabled={action.busy()}
                    placeholder="Code or pikibun:// link" autoCapitalize="none" autoCorrect={false} maxLength={512} onSubmit={() => void finish(pasted())} />
                  <Button small variant="primary" label="Finish" disabled={action.busy() || !pasted().trim()} onPress={() => void finish(pasted())} />
                </View>
              </Field>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1 }}><Small>No browser opened? Copy this link into one. It works once, for 10 minutes.</Small></View>
                <CopyButton value={current().url} label="Copy link" />
              </View>
            </View>
          </CardBody>
        )}
      </If>
    );
  }
  return { start, Panel, action };
}

export function McpConnectionsGroup() {
  const resource = createResource<{ connections: McpConnection[] }>(() => base);
  const action = createAction();
  const adding = signal(false);
  const changing = signal<McpConnection | undefined>(undefined);
  const connections = () => resource.data()?.connections ?? [];
  const app = appSignInFinisher(() => resource.refresh());
  const AppPanel = app.Panel;
  async function run(work: () => Promise<unknown>, notice: string) {
    if (await action.run(async () => { await work(); }, notice)) resource.refresh();
  }
  const signIn = (connection: McpConnection) => (opensServerPages
    ? openServerLink(`${base}/${segment(connection.id)}/oauth/start`)
    : void app.start(connection.name, `${base}/${segment(connection.id)}/oauth/app`));
  async function remove(connection: McpConnection) {
    if (!await confirm({ title: `Remove ${connection.name}?`, confirmLabel: "Remove", destructive: true,
      message: `Pikibun deletes its sign-in, and ${connection.workspaces.length ? `${connection.workspaces.map(item => item.name).join(", ")} stop using it at once` : "no workspace uses it"}.` })) return;
    await run(() => session().api(`${base}/${segment(connection.id)}`, { method: "DELETE" }), "Connection removed.");
  }
  async function signOut(connection: McpConnection) {
    if (!await confirm({ title: `Sign out of ${connection.name}?`, confirmLabel: "Sign out", destructive: true,
      message: "Pikibun deletes the OAuth sign-in it kept for it, in every workspace that uses it." })) return;
    await run(() => session().api(`${base}/${segment(connection.id)}/oauth`, { method: "DELETE" }), "Signed out.");
  }
  async function changeSignIn(connection: McpConnection, method: RemoteMcpSignInMethod, headers: Record<string, string>) {
    const done = await action.run(async () => {
      if (method !== "oauth" || connection.headerNames.length) {
        await session().api(`${base}/${segment(connection.id)}`, { method: "PATCH", body: { headers: Object.keys(headers).length ? headers : null } });
      }
      if (method !== "oauth" && connection.oauth) await session().api(`${base}/${segment(connection.id)}/oauth`, { method: "DELETE" });
    }, method === "oauth" && !connection.oauth ? "Now sign in to it with Sign in." : "Its new sign-in is kept encrypted.");
    if (done) {
      changing.set(undefined);
      resource.refresh();
    }
  }
  return (
    <View testID="mcp-connections" style={{ gap: 8 }}>
      <GroupTitle action={connections().length < remoteMcpLimits.connections
        ? <Button small variant="ghost" icon="plus" label="Add" testID="mcp-connection-add" onPress={() => adding.set(true)} /> : undefined}>Remote MCP servers</GroupTitle>
      <Card>
        <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
          <If when={connections().length} else={<Row title="No connections" hint="Sign in to a remote MCP server once, then use it in the workspaces whose servers sign in with each member's own account" />}>
            <Each of={connections()} key={connection => connection.id}>
              {connection => (
                <CollapsibleRow testID={`mcp-connection-${connection().id}`} leading={<Icon name="sparkles" size={16} color={palette().muted} />} title={connection().name}
                  hint={connectionHint(connection())}
                  trailing={<Badge tone={connection().error ? "danger" : connection().workspaces.length ? "success" : "neutral"}>
                    {connection().error ? "Error" : connection().workspaces.length ? "In use" : "Connected"}</Badge>}>
                  <If when={connection().error}><Banner tone="danger" title="The server didn't take its sign-in">{connection().error!}</Banner></If>
                  <Each of={connection().workspaces} key={item => item.id}>
                    {item => (
                      <Row title={item().name} hint="Its servers at this address that sign in with each member's own account use this connection for your requests"
                        trailing={<Button small variant="ghost" label="Stop using" disabled={action.busy()}
                          onPress={() => void run(() => session().api(`${base}/${segment(connection().id)}/workspaces/${segment(item().id)}`, { method: "DELETE" }), `${item().name} no longer uses it.`)} />} />
                    )}
                  </Each>
                  <Each of={connection().offeredIn} key={item => item.id}>
                    {item => (
                      <Row title={item().name} hint="Has a server at this address that signs in with each member's own account"
                        trailing={<Button small variant="outline" label="Use here" testID={`mcp-connection-use-${item().id}`} disabled={action.busy()}
                          onPress={() => void run(() => session().api(`${base}/${segment(connection().id)}/workspaces/${segment(item().id)}`, { method: "PUT" }), `${item().name} uses it for your requests from your next message.`)} />} />
                    )}
                  </Each>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <View style={{ flex: 1 }} />
                    <If when={connection().oauth || !connection().headerNames.length}>
                      <Button small variant="outline" label={connection().oauth ? "Sign in again" : "Sign in"} disabled={action.busy() || app.action.busy()} onPress={() => signIn(connection())} />
                    </If>
                    <If when={connection().oauth}><Button small variant="ghost" label="Sign out" disabled={action.busy()} onPress={() => void signOut(connection())} /></If>
                    <Button small variant="outline" label="Change sign-in" disabled={action.busy()} onPress={() => changing.set(connection())} />
                    <Button small variant="outline" icon="refresh" label="Check again" disabled={action.busy()}
                      onPress={() => void run(() => session().api(`${base}/${segment(connection().id)}`, { method: "PATCH", body: { refresh: true } }), "Checked it again.")} />
                    <Button small variant="ghost" icon="trash" label="Remove" disabled={action.busy()} onPress={() => void remove(connection())} />
                  </View>
                </CollapsibleRow>
              )}
            </Each>
          </If>
        </ResourceState>
        <AppPanel />
        <If when={action.error() || action.notice() || app.action.error() || app.action.notice()}>
          <CardBody><Feedback error={action.error() || app.action.error()} notice={action.notice() || app.action.notice()} /></CardBody>
        </If>
      </Card>
      <If when={adding()}>
        <ConnectionSheet busy={action.busy()} error={action.error()} close={() => adding.set(false)}
          save={async body => {
            let added: McpConnection | undefined;
            const done = await action.run(async () => { added = (await session().api<{ connection: McpConnection }>(base, { method: "POST", body })).connection; },
              () => added && !added.headerNames.length && added.error ? "Added. Now sign in to it with Sign in." : "Added.");
            if (done) {
              adding.set(false);
              resource.refresh();
            }
          }} />
      </If>
      <If when={changing()}>
        {connection => (
          <ChangeSignInSheet connection={connection()} busy={action.busy()} error={action.error()} close={() => changing.set(undefined)}
            save={(method, headers) => changeSignIn(connection(), method, headers)} />
        )}
      </If>
    </View>
  );
}

function ChangeSignInSheet(props: { connection: McpConnection; busy: boolean; error: string; close: () => void; save: (method: RemoteMcpSignInMethod, headers: Record<string, string>) => Promise<void> }) {
  const form = signInForm(untracked(() => remoteMcpSignInOf(props.connection)));
  function submit() {
    const headers = form.headers();
    if (headers) void props.save(form.method(), headers);
  }
  return (
    <FormSheet open title={`Sign-in for ${props.connection.name}`} onClose={() => { if (!props.busy) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.close} />
        <Button variant="primary" label={props.busy ? "Saving…" : "Save"} disabled={props.busy || !form.headers()} onPress={submit} />
      </>}>
      {form.fields(() => props.busy)}
      <Note>Saving replaces the sign-in Pikibun keeps for it, in every workspace that uses it.</Note>
      <Feedback error={props.error} />
    </FormSheet>
  );
}

export function ConnectionSheet(props: {
  busy: boolean; error: string; close: () => void; save: (body: Record<string, unknown>) => Promise<void>; initial?: { name: string; url: string };
}) {
  const name = signal(untracked(() => props.initial?.name ?? ""));
  const url = signal(untracked(() => props.initial?.url ?? ""));
  const form = signInForm("oauth");
  const ready = () => name().trim() && url().startsWith("https://") && !!form.headers();
  function submit() {
    const headers = form.headers();
    if (!ready() || !headers) return;
    void props.save({ name: name().trim(), url: url().trim(), ...(Object.keys(headers).length ? { headers } : {}) });
  }
  return (
    <FormSheet open title="Connect a remote MCP server" onClose={() => { if (!props.busy) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.close} />
        <Button testID="mcp-connection-connect" variant="primary" label={props.busy ? "Connecting…" : "Connect"} disabled={props.busy || !ready()} onPress={submit} />
      </>}>
      <Note>Your own account on a remote MCP server, kept encrypted on this Pikibun server. Workspaces use it only once you choose to use it there, and only for your own requests.</Note>
      <Field label="Name"><TextField testID="mcp-connection-name" value={name()} onChange={value => name.set(value)} disabled={props.busy} maxLength={remoteMcpLimits.name} placeholder="Linear" autoFocus /></Field>
      <Field label="Address" hint="The server's https:// address, the same one the workspace's server has">
        <TextField testID="mcp-connection-url" monospace value={url()} onChange={value => url.set(value)} disabled={props.busy || !!props.initial} maxLength={remoteMcpLimits.url}
          placeholder="https://mcp.example.com/mcp" keyboardType="url" autoCapitalize="none" autoCorrect={false} />
      </Field>
      {form.fields(() => props.busy)}
      <Feedback error={props.error} />
    </FormSheet>
  );
}
