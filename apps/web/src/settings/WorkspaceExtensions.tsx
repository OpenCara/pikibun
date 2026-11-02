import { useState, type FormEvent } from "react";
import type { Workspace } from "../../../../packages/shared/src/types";
import { extensionLimits, normalizeExtensionSource, type ExtensionAvailability, type ExtensionFlag, type ExtensionSettings, type ExtensionToolMode,
  type HostExtensionsReport, type InstalledExtension, type WorkspaceExtension } from "../../../../packages/shared/src/host-extensions";
import { api, segment } from "../api";
import { Icon } from "../icons";
import { Alert, Button, CardBody, Collapsible, confirmDialog, EmptyState, Feedback, Field, ResourceState, Row, Section, SegmentedControl, Sheet, StatusBadge,
  useAction, useResource } from "../ui";

/*
 * A workspace's extensions (docs/design/host-extensions.md): the Pi extensions its sessions use, each pinned to one
 * version, and where each of its hosts stands with them. Owners and admins add, change and remove them; every member sees
 * them. Hosts install them: their owners do, on the host's page.
 */

interface ExtensionHost {
  id: string; name: string; ownerId: string; ownerName: string;
  report?: HostExtensionsReport; reportedAt?: string; availability?: Record<string, ExtensionAvailability>;
}
interface ExtensionsResponse { extensions: WorkspaceExtension[]; hosts: ExtensionHost[]; admin: boolean }

const toolsLabel: Record<ExtensionToolMode, string> = { approval: "Approval", automatic: "Automatic" };

const info = <div className="stack">
  <p>Pi extensions add tools, prompt text and hooks to this workspace's sessions. A session runs those enabled here that its host has installed at the same version: its host's owner installs them there, from the host's page or with <code>pikibun extensions</code>.</p>
  <p>Extensions run on the host, as its owner's OS user, outside the sandbox and the network access above. Their tool calls are approved like host commands, by the host's owner or a member granted host commands, unless you set their tools to run automatically and the host's owner allows that on their host.</p>
  <p>Settings are the extension's own options. Never put secrets in them: an extension reads keys on its host, which its owner sets up.</p>
</div>;

/** The extension's flags, as the first host that has it reports them. */
function flagsOf(source: string, hosts: readonly ExtensionHost[]): ExtensionFlag[] | undefined {
  for (const host of hosts) {
    const installed = host.report?.installed.find(item => item.source === source);
    if (installed) return installed.modules.flatMap(module => module.flags);
  }
  return undefined;
}

function toolsOf(installed: InstalledExtension | undefined): string[] {
  return installed?.modules.flatMap(module => module.tools.map(tool => tool.name)) ?? [];
}

/** Tools two enabled extensions both offer, as hosts report them: sessions keep the first one's. */
function clashes(extensions: readonly WorkspaceExtension[], hosts: readonly ExtensionHost[]): { tool: string; sources: string[] }[] {
  const owners = new Map<string, string[]>();
  for (const extension of extensions.filter(item => item.enabled)) {
    const installed = hosts.flatMap(host => host.report?.installed ?? []).find(item => item.source === extension.source);
    for (const tool of new Set(toolsOf(installed))) owners.set(tool, [...(owners.get(tool) ?? []), extension.source]);
  }
  return [...owners].filter(([, sources]) => sources.length > 1).map(([tool, sources]) => ({ tool, sources }));
}

function availabilityBadge(availability: ExtensionAvailability | undefined) {
  if (!availability) return <StatusBadge tone="neutral">Not reported</StatusBadge>;
  if (availability.status === "installed") return <StatusBadge tone="success">Installed</StatusBadge>;
  if (availability.status === "other-version") return <StatusBadge tone="warning">{availability.installed.slice(availability.installed.lastIndexOf("@") + 1)} installed</StatusBadge>;
  return <StatusBadge tone="neutral">Missing</StatusBadge>;
}

export function WorkspaceExtensions({ workspace, userId }: { workspace: Workspace; userId: string }) {
  const path = `/api/workspaces/${segment(workspace.id)}/extensions`;
  const resource = useResource<ExtensionsResponse>(path);
  const action = useAction();
  const [editing, setEditing] = useState<WorkspaceExtension | "new" | null>(null);
  const data = resource.data;
  const admin = data?.admin === true;

  /** Saves `extension`; true once it is. */
  async function save(extension: WorkspaceExtension, notice = "Extension saved. Sessions pick it up from their next message."): Promise<boolean> {
    let done = false;
    await action.run(async () => {
      const saved = await api<{ extensions: WorkspaceExtension[] }>(path, { method: "PUT", body: extension });
      resource.setData(current => current && { ...current, ...saved });
      done = true;
    }, notice);
    if (done) resource.refresh();
    return done;
  }
  /** The host's owner installs a missing extension on their host from here too. */
  function install(host: ExtensionHost, source: string) {
    void action.run(async () => {
      await api(`/api/connectors/${segment(host.id)}/extensions/requests`, { method: "POST", body: { action: "install", source } });
    }, `Asked ${host.name} to install it: it does within half a minute while it is online. Its page shows how it went.`);
  }
  function remove(extension: WorkspaceExtension) {
    void (async () => {
      if (!await confirmDialog({ title: "Remove this extension?", message: <>Sessions stop running <code>{extension.source}</code> from their next message. Hosts keep it installed until their owners remove it.</>, confirmLabel: "Remove", destructive: true })) return;
      await action.run(async () => {
        const saved = await api<{ extensions: WorkspaceExtension[] }>(`${path}?source=${encodeURIComponent(extension.source)}`, { method: "DELETE" });
        resource.setData(current => current && { ...current, ...saved });
      }, "Extension removed.");
    })();
  }
  const conflicts = data ? clashes(data.extensions, data.hosts) : [];
  return <Section title="Extensions" bare info={info} action={admin && (data?.extensions.length ?? 0) < extensionLimits.workspace
    ? <Button variant="outline" size="sm" icon="plus" onClick={() => setEditing("new")}>Add extension</Button> : undefined}>
    <ResourceState loading={resource.loading && !data} error={resource.error} retry={resource.refresh}>
      {data && <div className="card">
        {!data.extensions.length && <EmptyState title="No extensions">{admin ? "Add a Pi extension, such as npm:cc-safety-net@2.7.2, to run it in this workspace's sessions." : "Owners and admins add the Pi extensions this workspace's sessions run."}</EmptyState>}
        {data.extensions.map(extension => {
          const installedOn = data.hosts.filter(host => host.availability?.[extension.source]?.status === "installed").length;
          return <Collapsible key={extension.source} leading={<Icon name="tool" size={16} />} title={<code>{extension.source}</code>}
            hint={`Tools: ${toolsLabel[extension.tools].toLowerCase()} · installed on ${installedOn} of ${data.hosts.length} ${data.hosts.length === 1 ? "host" : "hosts"}`}
            trailing={extension.enabled ? <StatusBadge tone="success">On</StatusBadge> : <StatusBadge tone="neutral">Off</StatusBadge>}>
            {data.hosts.map(host => {
              const availability = host.availability?.[extension.source];
              const installable = host.ownerId === userId && host.report?.remoteInstalls === true && availability && availability.status !== "installed";
              return <Row key={host.id} leading={<Icon name="server" size={16} />} title={host.name} hint={`Hosted by ${host.ownerId === userId ? "you" : host.ownerName}`}
                trailing={<span className="inline">{availabilityBadge(availability)}{installable && <Button variant="outline" size="sm" disabled={action.busy}
                  onClick={() => install(host, extension.source)}>{availability.status === "other-version" ? "Update" : "Install"}</Button>}</span>} />;
            })}
            {!data.hosts.length && <Row title="No hosts" hint="No host is connected to this workspace yet" />}
            {admin && <CardBody><div className="inline">
              <label className="check-row small"><input type="checkbox" className="checkbox" checked={extension.enabled} disabled={action.busy}
                onChange={event => void save({ ...extension, enabled: event.target.checked }, event.target.checked ? "Extension on." : "Extension off.")} /><span>Enabled</span></label>
              <span className="spacer" />
              <Button variant="outline" size="sm" icon="pencil" disabled={action.busy} onClick={() => setEditing(extension)}>Edit</Button>
              <Button variant="ghost" size="sm" icon="trash" disabled={action.busy} onClick={() => remove(extension)}>Remove</Button>
            </div></CardBody>}
          </Collapsible>;
        })}
        {conflicts.map(conflict => <CardBody key={conflict.tool}><Alert variant="warning" title={`Two extensions offer ${conflict.tool}`}>
          {conflict.sources.join(" and ")} both register a tool named <code>{conflict.tool}</code>. Sessions keep the first one's, in this list's order, and leave out the other's.
        </Alert></CardBody>)}
        {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
      </div>}
    </ResourceState>
    {editing && data && <ExtensionSheet extension={editing === "new" ? undefined : editing} taken={data.extensions} flags={editing === "new" ? undefined : flagsOf(editing.source, data.hosts)}
      close={() => setEditing(null)} save={async extension => { if (await save(extension)) setEditing(null); }} busy={action.busy} error={action.error} />}
  </Section>;
}

function ExtensionSheet({ extension, taken, flags, close, save, busy, error }: { extension?: WorkspaceExtension; taken: readonly WorkspaceExtension[];
  flags?: ExtensionFlag[]; close: () => void; save: (extension: WorkspaceExtension) => Promise<void>; busy: boolean; error: string }) {
  const [source, setSource] = useState(extension?.source ?? "");
  const [tools, setTools] = useState<ExtensionToolMode>(extension?.tools ?? "approval");
  const [settings, setSettings] = useState<ExtensionSettings>(extension?.settings ?? {});
  let normalized: string | undefined;
  let invalid = "";
  try { normalized = source.trim() ? normalizeExtensionSource(source.trim()) : undefined; }
  catch (reason) { invalid = reason instanceof Error ? reason.message : "Invalid source"; }
  const replacing = !extension && normalized ? taken.find(item => item.source.slice(0, item.source.lastIndexOf("@")) === normalized!.slice(0, normalized!.lastIndexOf("@"))) : undefined;
  // Settings the extension no longer declares are kept, shown as they are.
  const known = new Set(flags?.map(flag => flag.name));
  const extra = Object.keys(settings).filter(name => !known.has(name));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!normalized) return;
    void save({ source: normalized, enabled: extension?.enabled ?? true, tools, settings });
  }
  return <Sheet open title={extension ? "Edit extension" : "Add extension"} onClose={() => { if (!busy) close(); }} footer={<>
    <Button disabled={busy} onClick={close}>Cancel</Button>
    <Button variant="default" type="submit" form="extension-form" disabled={busy || !normalized}>{busy ? "Saving..." : "Save"}</Button>
  </>}>
    <form id="extension-form" className="stack" onSubmit={submit}>
      <Field label="Source" hint={extension ? "Change the version to move every host to it: until a host's owner installs it there, sessions on that host run without it"
        : "npm:<package>@<exact version>, or git:<https URL>@<full commit>. A Pi extension package, pinned"} error={invalid}>
        <input className="input mono" value={source} onChange={event => setSource(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false}
          maxLength={512} placeholder="npm:cc-safety-net@2.7.2" autoFocus={!extension} />
      </Field>
      {replacing && <p className="muted small">The workspace uses {replacing.source}: this replaces it, in its place.</p>}
      <div className="field"><span className="field-label">Tools</span>
        <SegmentedControl label="Tools" value={tools} onChange={setTools} options={(["approval", "automatic"] as const).map(value => ({ value, label: toolsLabel[value] }))} />
        <span className="field-hint">{tools === "approval" ? "Each tool call waits for the host's owner, or a member granted host commands, to approve it."
          : "Tool calls run at once, outside the sandbox, on hosts whose owner lets workspaces do that; elsewhere they still wait for approval."}</span>
      </div>
      {extension && (flags === undefined
        ? <p className="muted small">Its settings show here once a host that has it installed reports them.</p>
        : !flags.length && !extra.length ? <p className="muted small">This extension has no settings.</p>
        : <div className="stack">
          {flags.map(flag => <Field key={flag.name} label={flag.name} hint={flag.description ?? (flag.default !== undefined ? `Default: ${String(flag.default)}` : undefined)}>
            {flag.type === "boolean"
              ? <label className="check-row small"><input type="checkbox" className="checkbox" disabled={busy}
                checked={(settings[flag.name] ?? flag.default) === true} onChange={event => setSettings(value => ({ ...value, [flag.name]: event.target.checked }))} /><span>On</span></label>
              : <input className="input" disabled={busy} autoComplete="off" spellCheck={false} maxLength={4096} placeholder={typeof flag.default === "string" ? flag.default : ""}
                value={typeof settings[flag.name] === "string" ? settings[flag.name] as string : ""}
                onChange={event => setSettings(value => {
                  const next = { ...value };
                  if (event.target.value) next[flag.name] = event.target.value; else delete next[flag.name];
                  return next;
                })} />}
          </Field>)}
          {extra.map(name => <Row key={name} title={name} hint={`Kept: ${String(settings[name])}. The installed version doesn't declare it`}
            trailing={<Button variant="ghost" size="sm" disabled={busy} onClick={() => setSettings(value => { const next = { ...value }; delete next[name]; return next; })}>Clear</Button>} />)}
          <p className="muted small">Never put secrets here: every member of the workspace can read these, and they are in its audit log.</p>
        </div>)}
      <Feedback error={error} />
    </form>
  </Sheet>;
}
