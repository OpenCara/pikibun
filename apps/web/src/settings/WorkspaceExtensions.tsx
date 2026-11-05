import { useState, type FormEvent, type ReactNode } from "react";
import type { Workspace } from "../../../../packages/shared/src/types";
import { pikiCommandExtensions, pikiExtension, pikiSessionToolExtensions } from "../../../../packages/shared/src/piki-extensions";
import { descriptionSummary, extensionLabel, extensionOffer, workspaceTools, type ExtensionOffer, type WorkspaceTool,
  type WorkspaceTools } from "../../../../packages/shared/src/workspace-tools";
import { ExtensionSettingsFields } from "./ExtensionSettingsFields";
import { extensionLimits, extensionPackageKey, isPikiExtensionSource, normalizeExtensionSource, type ExtensionAvailability, type ExtensionFlag, type ExtensionSettings, type ExtensionToolMode,
  type HostExtensionsReport, type InstalledExtension, type WorkspaceExtension } from "../../../../packages/shared/src/host-extensions";
import { api, segment } from "../api";
import { Icon } from "../icons";
import { Alert, Button, CardBody, Collapsible, confirmDialog, EmptyState, Feedback, Field, ResourceState, Row, Section, SegmentedControl, Sheet, StatusBadge,
  useAction, useResource } from "../ui";
import "./settings.css";

/*
 * A workspace's extensions (docs/design/host-extensions.md): the Pi extensions its sessions use, each pinned to one
 * version, with what each is and the tools it offers, and where each of its hosts stands with them; above them, every
 * tool its sessions can use (workspace-tools.ts). Owners and admins add, change and remove them; every member sees them.
 * Hosts install them: their owners do, on the host's page.
 */

interface ExtensionHost {
  id: string; name: string; ownerId: string; ownerName: string;
  report?: HostExtensionsReport; reportedAt?: string; availability?: Record<string, ExtensionAvailability>;
}
interface ExtensionsResponse { extensions: WorkspaceExtension[]; hosts: ExtensionHost[]; admin: boolean }

const toolsLabel: Record<ExtensionToolMode, string> = { approval: "Approval", automatic: "Automatic" };

const info = <div className="stack">
  <p>Pi extensions add tools, prompt text and hooks to this workspace's sessions. A session runs those enabled here that its host has installed at the same version: its host's owner installs them there, from the host's page or with <code>pikibun extensions</code>.</p>
  <p><strong>Tools sessions can use</strong> lists every tool they get: Pikibun's own, which the session-tool extensions below turn on or off, the built-in code mode, and those of the extensions enabled here, as hosts that have them report them. Each extension shows what it is and the tools it offers.</p>
  <p>Pikibun's built-in extensions come with every host's connector: <code>piki:gh</code>, <code>piki:glab</code> and <code>piki:azure-cli</code> run the GitHub, GitLab or Azure CLI the host has installed and signed in. The workspace gets the one for a forge when it binds its first repository there.</p>
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

/** Every host's report of what it has installed, in the hosts' order: the first that has an extension describes it. */
function installedOn(hosts: readonly ExtensionHost[]): InstalledExtension[] {
  return hosts.flatMap(host => host.report?.installed ?? []);
}

function availabilityBadge(availability: ExtensionAvailability | undefined, source: string) {
  if (!availability) return <StatusBadge tone="neutral">Not reported</StatusBadge>;
  if (availability.status === "installed") return <StatusBadge tone="success">{isPikiExtensionSource(source) ? "Available" : "Installed"}</StatusBadge>;
  if (isPikiExtensionSource(source)) return <StatusBadge tone="warning">Update its connector</StatusBadge>;
  if (availability.status === "other-version") return <StatusBadge tone="warning">{availability.installed.slice(availability.installed.lastIndexOf("@") + 1)} installed</StatusBadge>;
  return <StatusBadge tone="neutral">Missing</StatusBadge>;
}

/** An extension's tools by name, beside it; those sessions leave out (`shadowed`: name → who keeps it) struck through. */
function ToolNames({ tools, shadowed }: { tools: readonly string[]; shadowed?: ReadonlyMap<string, string> }) {
  if (!tools.length) return <span className="tool-names">No tools: prompt text or hooks only</span>;
  return <span className="tool-names">{tools.length === 1 ? "Tool" : "Tools"}: {tools.map(name => {
    const by = shadowed?.get(name);
    return by ? <code key={name} className="tool-shadowed" title={`Left out: sessions keep ${by}'s ${name}`}>{name}</code> : <code key={name}>{name}</code>;
  })}</span>;
}

/**
 * Tools, one per line, with what each does and, with `sources`, the extension it comes with; those sessions leave out
 * (`shadowed`: name → who keeps it) say so.
 */
function ToolList({ tools, sources, shadowed }: { tools: readonly Pick<WorkspaceTool, "name" | "description" | "source" | "mode">[]; sources?: boolean;
  shadowed?: ReadonlyMap<string, string> }) {
  return <ul className="tool-list">{tools.map(tool => {
    const by = shadowed?.get(tool.name);
    return <li key={`${tool.source} ${tool.name}`}>
      <code className={by ? "tool-list-name tool-shadowed" : "tool-list-name"}>{tool.name}</code>
      <span className="tool-list-description" title={tool.description}>{descriptionSummary(tool.description) || <span className="muted">No description</span>}</span>
      {by ? <span className="tool-list-source" title={`Sessions keep ${by}'s ${tool.name}`}>Left out: {extensionLabel(by)} has it</span>
        : sources && <span className="tool-list-source" title={tool.source}>{extensionLabel(tool.source)}{tool.mode && <> · {toolsLabel[tool.mode]}</>}</span>}
    </li>;
  })}</ul>;
}

/** Every tool the workspace's sessions can use, by where it comes from and how it runs. */
function ToolsOverview({ usable }: { usable: WorkspaceTools }) {
  const own = usable.tools.filter(tool => tool.origin !== "extension");
  const offered = usable.tools.filter(tool => tool.origin === "extension");
  return <Collapsible leading={<Icon name="terminal" size={16} />} title="Tools sessions can use"
    hint={`${usable.tools.length} tools: ${own.length} of Pikibun's own, ${offered.length} from extensions${usable.off.length ? ` · ${usable.off.length} turned off` : ""}`}>
    <div className="tool-group">
      <div className="tool-group-title"><strong>Pikibun's own</strong><span className="muted small">In the session's sandbox or through Pikibun, with the session's permissions, approval cards and Read-only rules</span></div>
      <ToolList tools={own} sources />
    </div>
    <div className="tool-group">
      <div className="tool-group-title"><strong>From extensions</strong><span className="muted small">On the host, outside the sandbox: each call is approved like a host command, unless it runs automatically where the workspace and the host's owner allow that</span></div>
      {offered.length ? <ToolList tools={offered} sources /> : <p className="muted small">None: no extension enabled here offers a tool{usable.unreported.length ? " that hosts have reported" : ""}.</p>}
    </div>
    {!!usable.off.length && <p className="muted small">Turned off here: {usable.off.map((tool, index) => <span key={tool.name}>{index ? ", " : ""}<code>{tool.name}</code></span>)}.</p>}
    {!!usable.unreported.length && <p className="muted small">Not listed yet: the tools of {usable.unreported.map((source, index) => <span key={source}>{index ? ", " : ""}<code>{source}</code></span>)}, which no host that has {usable.unreported.length === 1 ? "it" : "them"} installed has reported.</p>}
    <p className="muted small">Each host offers what it can of these: the browser only with Chromium there, an extension only once it is installed there at this version. A host's owner may add extensions they require of every session on their host.</p>
  </Collapsible>;
}

/**
 * What an extension is (its description, cut to `limit` characters, and `note`), the tools it offers and, below, how the
 * workspace runs it: its row's hint.
 */
function ExtensionHint({ offer, shadowed, limit = 300, note, children }: { offer?: ExtensionOffer; shadowed?: ReadonlyMap<string, string>; limit?: number; note?: string;
  children?: ReactNode }) {
  return <span className="extension-hint">
    {offer?.description && <span>{descriptionSummary(offer.description, limit)}{note && ` ${note}`}</span>}
    {offer ? <ToolNames tools={offer.tools.map(tool => tool.name)} shadowed={shadowed} />
      : <span>What it is and its tools show here once a host that has it installed reports them.</span>}
    {children && <span>{children}</span>}
  </span>;
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
  /** Turns a session-tool extension's tools on or off: off is a disabled entry, on removes it (on is what a workspace that never chose has). */
  function switchSessionTools(source: string, on: boolean) {
    void action.run(async () => {
      const saved = on
        ? await api<{ extensions: WorkspaceExtension[] }>(`${path}?source=${encodeURIComponent(source)}`, { method: "DELETE" })
        : await api<{ extensions: WorkspaceExtension[] }>(path, { method: "PUT", body: { source, enabled: false, tools: "approval", settings: {} } });
      resource.setData(current => current && { ...current, ...saved });
    }, on ? "Tool on. Sessions offer it from their next message." : "Tool off. Sessions stop offering it from their next message.");
  }
  const sessionToolSources = new Set<string>(pikiSessionToolExtensions().map(item => item.source));
  const listed = data ? data.extensions.filter(extension => !sessionToolSources.has(extension.source)) : [];
  const installed = data ? installedOn(data.hosts) : [];
  const usable = data ? workspaceTools(data.extensions, installed) : undefined;
  /** The tools sessions leave out, by extension: name → whose they keep. */
  const shadowedOf = (source: string) => new Map((usable?.shadowed ?? []).filter(item => item.source === source).map(item => [item.name, item.by]));
  // One warning per name an extension of this workspace can't have: who keeps it, and whose sessions leave out.
  const conflicts: { tool: string; by: string; sources: string[] }[] = [];
  for (const item of usable?.shadowed ?? []) {
    const conflict = conflicts.find(other => other.tool === item.name && other.by === item.by);
    if (conflict) conflict.sources.push(item.source);
    else conflicts.push({ tool: item.name, by: item.by, sources: [item.source] });
  }
  return <Section title="Extensions" bare info={info} action={admin && listed.length < extensionLimits.workspace
    ? <Button variant="outline" size="sm" icon="plus" onClick={() => setEditing("new")}>Add extension</Button> : undefined}>
    <ResourceState loading={resource.loading && !data} error={resource.error} retry={resource.refresh}>
      {data && <div className="card">
        {usable && <ToolsOverview usable={usable} />}
        {pikiSessionToolExtensions().filter(item => !item.retired).map(item => {
          const on = !data.extensions.some(extension => extension.source === item.source && !extension.enabled);
          return <Row key={item.source} leading={<Icon name="tool" size={16} />} title={<>{item.title} <code>{item.source}</code></>}
            hint={<ExtensionHint offer={extensionOffer(item.source, installed)} limit={Infinity}
              note={item.core ? undefined : "Hosts on older connectors offer its tools whatever is chosen here."} />}
            trailing={item.core ? <StatusBadge tone="neutral">Always on</StatusBadge> : admin
              ? <label className="check-row small"><input type="checkbox" className="checkbox" checked={on} disabled={action.busy}
                onChange={event => switchSessionTools(item.source, event.target.checked)} /><span>On</span></label>
              : on ? <StatusBadge tone="success">On</StatusBadge> : <StatusBadge tone="neutral">Off</StatusBadge>} />;
        })}
        {!listed.length && <EmptyState title="No extensions">{admin ? "Add a Pi extension, such as npm:cc-safety-net@2.7.2 or piki:gh (the GitHub CLI), to run it in this workspace's sessions." : "Owners and admins add the Pi extensions this workspace's sessions run."}</EmptyState>}
        {listed.map(extension => {
          const hostsWithIt = data.hosts.filter(host => host.availability?.[extension.source]?.status === "installed").length;
          const cli = pikiExtension(extension.source);
          const offer = extensionOffer(extension.source, installed);
          const summary = offer?.description ? descriptionSummary(offer.description, 300) : "";
          return <Collapsible key={extension.source} leading={<Icon name="tool" size={16} />} title={cli ? <>{cli.title} <code>{extension.source}</code></> : <code>{extension.source}</code>}
            hint={<ExtensionHint offer={offer} shadowed={extension.enabled ? shadowedOf(extension.source) : undefined}>
              {`Tool calls: ${toolsLabel[extension.tools].toLowerCase()} · ${cli ? "on" : "installed on"} ${hostsWithIt} of ${data.hosts.length} ${data.hosts.length === 1 ? "host" : "hosts"}`}</ExtensionHint>}
            trailing={extension.enabled ? <StatusBadge tone="success">On</StatusBadge> : <StatusBadge tone="neutral">Off</StatusBadge>}>
            {offer?.description && summary !== offer.description.trim() && <CardBody><p className="muted small pre-wrap">{offer.description.trim()}</p></CardBody>}
            {!!offer?.tools.length && <CardBody><ToolList tools={offer.tools.map(tool => ({ ...tool, source: extension.source }))}
              shadowed={extension.enabled ? shadowedOf(extension.source) : undefined} /></CardBody>}
            {data.hosts.map(host => {
              const availability = host.availability?.[extension.source];
              const installable = !cli && host.ownerId === userId && host.report?.remoteInstalls === true && availability && availability.status !== "installed";
              return <Row key={host.id} leading={<Icon name="server" size={16} />} title={host.name} hint={`Hosted by ${host.ownerId === userId ? "you" : host.ownerName}`}
                trailing={<span className="inline">{availabilityBadge(availability, extension.source)}{installable && <Button variant="outline" size="sm" disabled={action.busy}
                  onClick={() => install(host, extension.source)}>{availability.status === "other-version" ? "Update" : "Install"}</Button>}</span>} />;
            })}
            {!data.hosts.length && <Row title="No hosts" hint="No host is connected to this workspace yet" />}
            {cli?.tool && cli.install && cli.account && <CardBody><p className="muted small">Each host needs <code>{cli.tool}</code> installed (<a href={cli.install} target="_blank" rel="noreferrer">{cli.install}</a>) where its sandbox finds it. It acts as the session's owner, with {cli.account} in Pikibun: it reads the workspace's repositories, and writes only in a call a person approved, on the session owner's own host. Turn on <strong>read-only</strong> under Edit before running its tools automatically.</p></CardBody>}
            {admin && <CardBody><div className="inline">
              <label className="check-row small"><input type="checkbox" className="checkbox" checked={extension.enabled} disabled={action.busy}
                onChange={event => void save({ ...extension, enabled: event.target.checked }, event.target.checked ? "Extension on." : "Extension off.")} /><span>Enabled</span></label>
              <span className="spacer" />
              <Button variant="outline" size="sm" icon="pencil" disabled={action.busy} onClick={() => setEditing(extension)}>Edit</Button>
              <Button variant="ghost" size="sm" icon="trash" disabled={action.busy} onClick={() => remove(extension)}>Remove</Button>
            </div></CardBody>}
          </Collapsible>;
        })}
        {conflicts.map(conflict => sessionToolSources.has(conflict.by)
          ? <CardBody key={`${conflict.tool} ${conflict.by}`}><Alert variant="warning" title={`${conflict.tool} is one of Pikibun's own tools`}>
            {conflict.sources.join(" and ")} {conflict.sources.length === 1 ? "registers" : "register"} a tool named <code>{conflict.tool}</code>, like {conflict.by}. Sessions keep Pikibun's own, even while it is turned off here, and leave out the extension's.
          </Alert></CardBody>
          : conflict.sources.every(source => !source.startsWith("pi:"))
          ? <CardBody key={`${conflict.tool} ${conflict.by}`}><Alert variant="warning" title={`Two extensions offer ${conflict.tool}`}>
            {[conflict.by, ...conflict.sources].join(" and ")} {conflict.sources.length === 1 ? "both" : "all"} register a tool named <code>{conflict.tool}</code>. Sessions keep the first one's, in this list's order, and leave out the {conflict.sources.length === 1 ? "other's" : "others'"}.
          </Alert></CardBody>
          : <CardBody key={`${conflict.tool} ${conflict.by}`}><Alert variant="info" title={`${conflict.by} replaces the built-in ${conflict.tool}`}>
            It registers a tool named <code>{conflict.tool}</code>, like {conflict.sources.join(" and ")}: sessions use the extension's instead of the built-in.
          </Alert></CardBody>)}
        {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
      </div>}
    </ResourceState>
    {editing && data && <ExtensionSheet extension={editing === "new" ? undefined : editing} taken={data.extensions} installed={installed}
      flags={editing === "new" ? undefined : flagsOf(editing.source, data.hosts)}
      close={() => setEditing(null)} save={async extension => { if (await save(extension)) setEditing(null); }} busy={action.busy} error={action.error} />}
  </Section>;
}

function ExtensionSheet({ extension, taken, installed, flags, close, save, busy, error }: { extension?: WorkspaceExtension; taken: readonly WorkspaceExtension[];
  installed: readonly InstalledExtension[]; flags?: ExtensionFlag[]; close: () => void; save: (extension: WorkspaceExtension) => Promise<void>; busy: boolean; error: string }) {
  const [source, setSource] = useState(extension?.source ?? "");
  const [tools, setTools] = useState<ExtensionToolMode>(extension?.tools ?? "approval");
  const [settings, setSettings] = useState<ExtensionSettings>(extension?.settings ?? {});
  let normalized: string | undefined;
  let invalid = "";
  try { normalized = source.trim() ? normalizeExtensionSource(source.trim()) : undefined; }
  catch (reason) { invalid = reason instanceof Error ? reason.message : "Invalid source"; }
  const replacing = !extension && normalized ? taken.find(item => extensionPackageKey(item.source) === extensionPackageKey(normalized!)) : undefined;
  const cli = normalized ? pikiExtension(normalized) : undefined;
  // What it is and its tools, as a host that has it reports them (or, for Pikibun's own, as this version knows them).
  const offer = normalized ? extensionOffer(normalized, installed) : undefined;
  const offered = pikiCommandExtensions().filter(item => !taken.some(used => used.source === item.source));
  const editingCli = !!extension && isPikiExtensionSource(extension.source);
  const extra = Object.keys(settings).filter(name => !flags?.some(flag => flag.name === name));
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
      {!extension && !!offered.length && <div className="field"><span className="field-label">Command-line tools</span>
        <div className="inline">{offered.map(item => <Button key={item.source} variant={normalized === item.source ? "default" : "outline"} size="sm" disabled={busy}
          onClick={() => setSource(item.source)}>{item.title}</Button>)}</div>
        <span className="field-hint">These come with every host's connector: each host needs only the command itself, signed in by its owner.</span>
      </div>}
      <Field label="Source" hint={editingCli ? "Built into the connector: its version is each host's connector's"
        : extension ? "Change the version to move every host to it: until a host's owner installs it there, sessions on that host run without it"
        : "npm:<package>@<exact version>, git:<https URL>@<full commit>, or piki:<name>. A Pi extension package, pinned"} error={invalid}>
        <input className="input mono" value={source} onChange={event => setSource(event.target.value)} disabled={busy || editingCli} autoComplete="off" spellCheck={false}
          maxLength={512} placeholder="npm:cc-safety-net@2.7.2" autoFocus={!extension} />
      </Field>
      {offer ? <div className="stack extension-offer">
        {offer.description && <p className="muted small pre-wrap">{offer.description.trim()}{cli?.tool && <> It runs <code>{cli.tool}</code> as the host's owner is signed in to it.</>}</p>}
        {offer.tools.length ? <ToolList tools={offer.tools.map(tool => ({ ...tool, source: normalized! }))} /> : <p className="muted small">No tools: it adds prompt text or hooks only.</p>}
      </div> : normalized && <p className="muted small">What it is and its tools show here once a host that has it installed at this version reports them.</p>}
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
          <ExtensionSettingsFields flags={flags} settings={settings} onChange={setSettings} busy={busy} />
          <p className="muted small">Never put secrets here: every member of the workspace can read these, and they are in its audit log.</p>
        </div>)}
      <Feedback error={error} />
    </form>
  </Sheet>;
}
