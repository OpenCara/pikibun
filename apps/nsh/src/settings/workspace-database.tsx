import { Picker, platform, signal, untracked, View } from "nsh";
import type { Workspace, WorkspaceDatabase, WorkspaceDatabaseTls } from "../../../../packages/shared/src/types";
import { segment } from "../shared";
import { decodeBase64, encodeBase64 } from "../lib/attachments";
import { readLocalFiles } from "../lib/local-files";
import { session } from "../lib/auth";
import { timestamp } from "../lib/format";
import { pageAvailable, pickFilesInPage, type PageFile } from "../lib/page";
import { createAction, createResource } from "../lib/resource";
import { Field, Select, TextField } from "../form";
import { palette, radius } from "../theme";
import { Badge, Banner, Button, CardBody, confirm, DropdownMenu, Feedback, FormSheet, Note, ResourceState, Row, Section, Small, type MenuAction } from "../ui";

interface ImportSummary {
  format: "session" | "workspace";
  exportedAt: string;
  sessions: number;
  sessionDetails: number;
  auditEntries: number;
  workspaceSettings: boolean;
}

const maxUploadBytes = 32 * 1024 * 1024;

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
  const importing = signal(false);
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
      pageAvailable() || platform.desktop
        ? { label: "Import dump", icon: "folder" as const, hint: "A session or workspace export", disabled: action.busy(), onSelect: () => importing.set(true) }
        : { label: "Import dump", icon: "folder" as const, hint: "From Pikibun on the web or a computer: this phone can't pick files yet", disabled: true, onSelect: () => undefined },
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
      <If when={props.owner && importing() && data()?.available ? database() : null}>
        {current => <ImportSheet path={path()} database={current()} close={() => importing.set(false)} />}
      </If>
    </Section>
  );
}

function ImportSheet(props: { path: string; database: WorkspaceDatabase; close: () => void }) {
  const file = signal<PageFile | null>(null);
  const imported = signal<ImportSummary | null>(null);
  const dragging = signal(false);
  const action = createAction();
  const dismiss = () => { if (!action.busy()) props.close(); };
  const tooLarge = "This dump is larger than 32 MiB. The server's operator can import it with the --import-dump option.";
  function dropped(uris: readonly string[]) {
    dragging.set(false);
    if (!uris.length || action.busy()) return;
    void action.run(async () => {
      const read = await readLocalFiles(uris.slice(0, 1), maxUploadBytes);
      if (read.tooLarge) throw new Error(tooLarge);
      const [chosen] = read.files;
      if (!chosen) throw new Error(read.problem || "Couldn't read that file.");
      imported.set(null);
      file.set({ name: chosen.name, type: chosen.type, size: chosen.size, data: encodeBase64(new Uint8Array(await chosen.arrayBuffer())) });
    });
  }
  function choose() {
    void action.run(async () => {
      const [picked] = pageAvailable()
        ? await pickFilesInPage({ accept: "application/json,.json", maxBytes: maxUploadBytes })
        : await Promise.all((await Picker.pickFiles({ filters: [{ name: "JSON dump", extensions: ["json"] }] })).map(async ({ file: chosen }) => ({
          name: chosen.name, type: chosen.type, size: chosen.size,
          ...(chosen.size <= maxUploadBytes ? { data: encodeBase64(new Uint8Array(await chosen.arrayBuffer())) } : {}),
        })));
      if (!picked) return;
      imported.set(null);
      file.set(picked);
      if (picked.data === undefined) throw new Error(tooLarge);
    });
  }
  function submit() {
    const picked = file();
    if (!picked?.data || action.busy()) return;
    imported.set(null);
    void action.run(async () => {
      let document: unknown;
      try {
        document = JSON.parse(new TextDecoder().decode(decodeBase64(picked.data!)));
      } catch {
        throw new Error("This file is not a JSON dump.");
      }
      const result = await session().api<{ imported: ImportSummary }>(`${props.path}/import`, { method: "POST", body: document });
      imported.set(result.imported);
    });
  }
  return (
    <FormSheet open title="Import a dump" onClose={dismiss} testID="database-import"
      footer={<>
        <Button label={imported() ? "Done" : "Cancel"} disabled={action.busy()} onPress={dismiss} />
        <If when={!imported()}>
          <Button variant="primary" label={action.busy() ? "Importing…" : "Import"} disabled={!file()?.data || action.busy()} onPress={submit} />
        </If>
      </>}>
      <Note>{`Adds an export of this workspace, or of one of its sessions, to ${databaseLabel(props.database)}: session records and details (grants, pushes, backups and restores), their activity and the workspace's settings. A record replaces an older one of the same session; activity is added once, so importing a dump again changes nothing. Pikibun itself is unchanged.`}</Note>
      <Field label="Dump file" hint="A JSON export from Pikibun, up to 32 MiB">
        <If when={pageAvailable()}
          else={
            <View testID="database-import-drop" onFileDragEnter={() => dragging.set(true)} onFileDragLeave={() => dragging.set(false)} onFileDrop={event => dropped(event.uris)}
              style={{ alignItems: "center", gap: 4, padding: 16, borderRadius: radius.medium, borderWidth: 1, borderStyle: "dashed",
                borderColor: dragging() ? palette().accent : palette().borderStrong }}>
              <Small>{file()?.name ?? "Drop the dump file here, or"}</Small>
              <If when={file()}><Small>Drop another to replace it, or</Small></If>
              <Button small variant="outline" icon="folder" testID="database-import-choose" label={file() ? "Choose another" : "Choose file"} disabled={action.busy()} onPress={choose} />
            </View>
          }>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Button small variant="outline" icon="folder" label={file() ? "Choose another" : "Choose file"} disabled={action.busy()} onPress={choose} />
            <Small>{file()?.name ?? "No file chosen"}</Small>
          </View>
        </If>
      </Field>
      <If when={imported()}>
        {summary => (
          <Banner tone="success" title="Imported">
            {`${summary().sessions} session record${summary().sessions === 1 ? "" : "s"} (${summary().sessionDetails} with details) and ${summary().auditEntries} activity entr${summary().auditEntries === 1 ? "y" : "ies"}${summary().workspaceSettings ? ", with the workspace's settings," : ""} from the ${summary().format} export of ${timestamp(summary().exportedAt)}.`}
          </Banner>
        )}
      </If>
      <Feedback error={action.error()} />
    </FormSheet>
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
