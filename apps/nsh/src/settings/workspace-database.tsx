import { signal, untracked, View } from "nsh";
import type { Workspace, WorkspaceDatabase, WorkspaceDatabaseTls } from "../../../../packages/shared/src/types";
import { segment } from "../shared";
import { session } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { Field, Select, TextField } from "../form";
import { Badge, Banner, Button, CardBody, confirm, DropdownMenu, Feedback, FormSheet, Note, ResourceState, Row, Section, Small, type MenuAction } from "../ui";

// A workspace's session database, as the web app's (settings/WorkspaceDatabase.tsx).

interface WorkspaceDatabaseResponse {
  available: boolean;
  privateHosts: boolean;
  backupStorage: boolean;
  database: WorkspaceDatabase | null;
  automaticBackups: { minutes: number | null; consented: boolean } | null;
}

const automaticIntervals: { minutes: number | null; label: string }[] = [
  { minutes: null, label: "Off" }, { minutes: 15, label: "Every 15 minutes" }, { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" }, { minutes: 1440, label: "Every day" },
];
const intervalLabel = (minutes: number | null) => automaticIntervals.find(interval => interval.minutes === minutes)?.label ?? `Every ${minutes} minutes`;
const withoutDatabase = (backupStorage: boolean) => (backupStorage ? "session backups are kept in the server's backup storage"
  : "this server keeps no session backups, as it has no backup storage of its own (STORAGE_URL)");
const tlsLabel: Record<WorkspaceDatabaseTls, string> = { "verify-full": "TLS, server certificate verified", require: "TLS, server certificate not verified", disable: "Unencrypted" };
const databaseLabel = (database: WorkspaceDatabase) => `${database.host.includes(":") ? `[${database.host}]` : database.host}:${database.port}/${database.database}`;

/** Splits a postgres:// connection URL into the form's fields; the server only ever receives the fields. */
function connectionUrl(value: string) {
  const textValue = value.trim();
  const scheme = /^postgres(?:ql)?:\/\//i.exec(textValue);
  if (!scheme) throw new Error("Use a postgres:// or postgresql:// URL.");
  const url = new URL(`http://${textValue.slice(scheme[0].length)}`);
  if (!url.hostname) throw new Error("The URL has no host.");
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: url.port || "5432", database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), unencrypted: url.searchParams.get("sslmode") === "disable",
  };
}

export function WorkspaceDatabaseSection(props: { workspace: Workspace; owner: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/database`;
  const resource = createResource<WorkspaceDatabaseResponse>(path);
  const action = createAction();
  const editing = signal(false);
  const data = () => resource.data();
  const database = () => data()?.database ?? null;
  async function disconnect() {
    const current = database();
    if (!current || action.busy()) return;
    if (!await confirm({ title: "Disconnect database", confirmLabel: "Disconnect", destructive: true,
      message: `Disconnect ${databaseLabel(current)}? ${data()?.backupStorage ? "New session backups go to the server's backup storage again." : "This server has no backup storage of its own, so no new session backups can be saved."} Backups already saved in that database stay there, but can't be downloaded or restored until it is connected again.` })) return;
    void action.run(async () => {
      await session().api(path(), { method: "DELETE" });
      resource.refresh();
    }, data()?.backupStorage ? "Database disconnected. New session backups go to the server's backup storage." : "Database disconnected. This server keeps no session backups without one.");
  }
  const items = (): MenuAction[] => [
    ...(data()?.available ? [
      { label: "Import dump", icon: "folder" as const, hint: "From Pikibun on the web: this app can't pick files yet", disabled: true, onSelect: () => undefined },
      { label: "Replace", icon: "refresh" as const, disabled: action.busy(), onSelect: () => editing.set(true) },
    ] : []),
    { label: "Disconnect", icon: "trash", destructive: true, disabled: action.busy(), onSelect: () => void disconnect() },
  ];
  const empty = () => {
    const fallback = withoutDatabase(data()?.backupStorage ?? false);
    return !data()?.available ? `Session databases are turned off on this server, so ${fallback}. The server's operator can turn them on with WORKSPACE_DATABASES=true`
      : props.owner ? `No database connected, so ${fallback}` : `No database connected, so ${fallback}. Only the workspace owner can connect one`;
  };
  return (
    <Section title="Session database" testID="workspace-database" info={<View style={{ gap: 8 }}>
      <Note>The workspace owner can connect a Postgres database of their own. Backups of this workspace's sessions are then saved there, with each session's details, instead of in the server's own backup storage (if it has any), and downloads and restores read them back from it.</Note>
      <Note>Whoever can read that database can read the sessions saved there, private ones and their owners' personal environment values included. Other members confirm the database before each of their backups goes there, and again after it is pointed at another database.</Note>
      <Note>The owner can also have changed sessions backed up there on their own, once they're idle, on a schedule. The password is write-only: it is never shown again after saving.</Note>
    </View>} action={props.owner && data()?.available && !database() ? <Button small variant="outline" icon="plus" label="Connect database" onPress={() => editing.set(true)} /> : undefined}>
      <ResourceState inline loading={resource.loading() && !data()} error={resource.error()} retry={resource.refresh}>
        <If when={database()} else={<CardBody><Small>{empty()}</Small></CardBody>}>
          {current => (
            <Row title={databaseLabel(current())} hint={`User ${current().user} · ${tlsLabel[current().tls]}${current().customCa ? " with a custom CA" : ""}`} trailing={<>
              <Badge tone={data()?.available ? "success" : "warning"}>{data()?.available ? "Connected" : "Unavailable"}</Badge>
              <If when={props.owner}><DropdownMenu label="Actions for the session database" items={items()} /></If>
            </>} />
          )}
        </If>
        <If when={database() && data()?.available && data()?.automaticBackups}>
          <AutomaticBackups path={path()} database={database()!} owner={props.owner} state={data()!.automaticBackups!} saved={resource.refresh} />
        </If>
        <If when={database() && data() && !data()!.available}>
          <CardBody>
            <Banner tone="warning" title="Workspace databases are turned off">
              {`This server no longer connects to workspace databases, so backups of this workspace's sessions can't be created, downloaded or restored. ${!data()?.backupStorage ? "The server's operator can turn them on again with WORKSPACE_DATABASES=true."
                : props.owner ? "Disconnect the database to use the server's backup storage again, or ask the server's operator to turn workspace databases on again."
                : "The workspace owner can disconnect it to use the server's backup storage again."}`}
            </Banner>
          </CardBody>
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      <If when={props.owner && editing() && data()?.available}>
        <DatabaseSheet path={path()} privateHosts={Boolean(data()?.privateHosts)} existing={database()} close={() => editing.set(false)} saved={resource.refresh} />
      </If>
    </Section>
  );
}

function AutomaticBackups(props: { path: string; database: WorkspaceDatabase; owner: boolean; state: { minutes: number | null; consented: boolean }; saved: () => void }) {
  const action = createAction();
  function schedule(minutes: number | null) {
    void action.run(async () => {
      await session().api(`${props.path}/automatic-backups`, { method: "PUT", body: { minutes } });
      props.saved();
    }, minutes === null ? "Automatic backups turned off." : `Changed sessions are now backed up ${intervalLabel(minutes).toLowerCase()} at most.`);
  }
  async function consent(next: boolean) {
    if (next && !await confirm({ title: "Confirm this database", confirmLabel: "Confirm database",
      message: `Back up your sessions in ${databaseLabel(props.database)} without asking each time, automatic backups included? Whoever can read it can read them, including your personal environment values. Pikibun asks again if the owner points the connection at another database.` })) return;
    void action.run(async () => {
      await session().api(`${props.path}/consent`, next ? { method: "PUT", body: { databaseId: props.database.id } } : { method: "DELETE" });
      props.saved();
    }, next ? "Database confirmed for your sessions' backups." : "Confirmation withdrawn. Backups of your sessions ask first again, and aren't taken automatically.");
  }
  return (
    <>
      <Row title="Automatic backups" hint={props.owner
        ? "Backs up sessions that changed since their last automatic backup, once they're idle. Members' sessions only once they confirm this database"
        : props.state.minutes === null ? "Off. The workspace owner chooses the schedule" : `${intervalLabel(props.state.minutes)}, for sessions that changed, once they're idle`}
        trailing={props.owner ? <Select<number | null> compact label="Automatic backup schedule" value={props.state.minutes} disabled={action.busy()} onChange={schedule}
          options={automaticIntervals.map(interval => ({ value: interval.minutes, label: interval.label }))} /> : undefined} />
      <If when={!props.owner}>
        <Row title="Your sessions" hint={props.state.consented ? "You confirmed this database: your backups go there without asking, automatic ones included"
          : "You confirm this database before each backup, and your sessions aren't backed up automatically"}
          trailing={<Button small variant="outline" label={props.state.consented ? "Withdraw" : "Confirm database"} disabled={action.busy()} onPress={() => void consent(!props.state.consented)} />} />
      </If>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </>
  );
}

function DatabaseSheet(props: { path: string; privateHosts: boolean; existing: WorkspaceDatabase | null; close: () => void; saved: () => void }) {
  const existing = untracked(() => props.existing);
  const url = signal("");
  const urlError = signal("");
  const host = signal(existing?.host ?? "");
  const port = signal(String(existing?.port ?? 5432));
  const database = signal(existing?.database ?? "");
  const user = signal(existing?.user ?? "");
  const password = signal("");
  const tls = signal<WorkspaceDatabaseTls>(existing && (existing.tls !== "disable" || props.privateHosts) ? existing.tls : "verify-full");
  const ca = signal("");
  const action = createAction();
  const ready = () => {
    const portNumber = Number(port());
    return Boolean(host().trim() && database().trim() && user().trim() && password()) && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  };
  const dismiss = () => { if (!action.busy()) props.close(); };
  function fill() {
    try {
      const parsed = connectionUrl(url());
      host.set(parsed.host); port.set(parsed.port);
      if (parsed.database) database.set(parsed.database);
      if (parsed.user) user.set(parsed.user);
      if (parsed.password) password.set(parsed.password);
      if (parsed.unencrypted && props.privateHosts) tls.set("disable");
      url.set(""); urlError.set("");
    } catch (reason) {
      urlError.set(reason instanceof Error ? reason.message : "The connection URL could not be read.");
    }
  }
  function save() {
    if (!ready() || action.busy()) return;
    const body = { host: host().trim(), port: Number(port()), database: database().trim(), user: user().trim(), password: password(), tls: tls(),
      ...(tls() === "verify-full" && ca().trim() ? { caCertificate: ca().trim() } : {}) };
    void action.run(async () => {
      await session().api(props.path, { method: "PUT", body });
      password.set("");
      props.saved();
      props.close();
    });
  }
  return (
    <FormSheet open title={existing ? "Replace session database" : "Connect session database"} onClose={dismiss}
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={dismiss} />
        <Button variant="primary" label={action.busy() ? "Connecting…" : "Save"} disabled={!ready() || action.busy()} onPress={save} />
      </>}>
      <Note>{`Pikibun connects when you save, to check the settings and create its tables. From then on, backups of this workspace's sessions are saved in this database${existing ? "; backups saved before stay where they are" : ""}.`}</Note>
      <Field label="Connection URL" hint="Optional. Paste a postgres:// URL and fill in the fields below from it; the URL itself isn't sent">
        <TextField monospace value={url()} onChange={value => url.set(value)} placeholder="postgres://user:password@db.example.com:5432/pikibun" />
      </Field>
      <View style={{ flexDirection: "row" }}><Button small variant="outline" label="Fill in from URL" disabled={!url().trim() || action.busy()} onPress={fill} /></View>
      <Feedback error={urlError()} />
      <Field label="Host" hint="Host name or IP address, without a scheme or port"><TextField monospace value={host()} onChange={value => host.set(value)} placeholder="db.example.com" /></Field>
      <Field label="Port"><TextField monospace keyboardType="number-pad" value={port()} onChange={value => port.set(value)} /></Field>
      <Field label="Database"><TextField monospace value={database()} onChange={value => database.set(value)} /></Field>
      <Field label="User" hint="Needs to create Pikibun's tables, or SELECT, INSERT and UPDATE on them if you create them yourself"><TextField monospace value={user()} onChange={value => user.set(value)} /></Field>
      <Field label="Password" hint="Write-only. Needed every time the connection is saved"><TextField masked value={password()} onChange={value => password.set(value)} /></Field>
      <Field label="Encryption" hint={props.privateHosts ? undefined : "This server only connects to databases on the public internet, always encrypted"}>
        <Select<WorkspaceDatabaseTls> label="Encryption" value={tls()} onChange={value => tls.set(value)} options={[
          { value: "verify-full", label: "TLS, verify the server certificate (recommended)" },
          { value: "require", label: "TLS, don't verify the server certificate" },
          ...(props.privateHosts ? [{ value: "disable" as const, label: "Unencrypted, private networks only" }] : []),
        ]} />
      </Field>
      <If when={tls() === "verify-full"}>
        <Field label="CA certificate" hint={existing?.customCa ? "Paste it again to keep verifying with it: saving replaces the connection's CA certificate"
          : "Optional. PEM certificates of a private CA, such as your cloud provider's bundle. The public roots are used otherwise"}>
          <TextField multiline monospace value={ca()} onChange={value => ca.set(value)} placeholder="-----BEGIN CERTIFICATE-----" />
        </Field>
      </If>
      <If when={tls() === "require"}><Banner tone="warning" title="Certificate not verified">The connection is encrypted, but whoever can intercept it could pose as the database and read the password and the sessions saved there.</Banner></If>
      <If when={tls() === "disable"}><Banner tone="warning" title="Unencrypted">The password and the sessions cross the network in the clear. Use this only on a network you trust.</Banner></If>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}
