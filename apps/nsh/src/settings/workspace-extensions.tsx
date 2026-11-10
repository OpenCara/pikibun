import { signal, Text, untracked, View } from "nsh";
import { pikiCommandExtensions, pikiExtension, pikiSessionToolExtensions, pikiWorkflowExtensions, sessionToolExtensionOn } from "../../../../packages/shared/src/piki-extensions";
import {
  descriptionSummary, extensionLabel, extensionOffer, PIKIBUN, workspaceTools, type ExtensionOffer, type ShadowKind, type WorkspaceTool, type WorkspaceTools,
} from "../../../../packages/shared/src/workspace-tools";
import {
  extensionLimits, extensionPackageKey, isPikiExtensionSource, normalizeExtensionSource, type ExtensionAvailability, type ExtensionFlag, type ExtensionSettings,
  type ExtensionToolMode, type HostExtensionsReport, type InstalledExtension, type WorkspaceExtension,
} from "../../../../packages/shared/src/host-extensions";
import { segment, type Workspace } from "../shared";
import { session } from "../lib/auth";
import { openExternal } from "../lib/links";
import { createAction, createResource } from "../lib/resource";
import { Icon } from "../icons";
import { monospace, palette, text } from "../theme";
import { Checkbox, Field, TextField } from "../form";
import { Badge, Banner, Button, CardBody, CollapsibleRow, confirm, EmptyState, Feedback, FormSheet, Note, ResourceState, Row, Section, Segmented, Small } from "../ui";
import { ExtensionSettingsFields } from "./extension-fields";

interface ExtensionHost {
  id: string; name: string; ownerId: string; ownerName: string;
  report?: HostExtensionsReport; reportedAt?: string; availability?: Record<string, ExtensionAvailability>;
}
interface ExtensionsResponse { extensions: WorkspaceExtension[]; hosts: ExtensionHost[]; admin: boolean }

const toolsLabel: Record<ExtensionToolMode, string> = { approval: "Approval", automatic: "Automatic" };

function flagsOf(source: string, hosts: readonly ExtensionHost[]): ExtensionFlag[] | undefined {
  for (const host of hosts) {
    const installed = host.report?.installed.find(item => item.source === source);
    if (installed) return installed.modules.flatMap(module => module.flags);
  }
  return undefined;
}
const installedOn = (hosts: readonly ExtensionHost[]): InstalledExtension[] => hosts.flatMap(host => host.report?.installed ?? []);

function AvailabilityBadge(props: { availability?: ExtensionAvailability; source: string }) {
  return (
    <If when={props.availability} else={<Badge>Not reported</Badge>}>
      {availability => availability().status === "installed" ? <Badge tone="success">{isPikiExtensionSource(props.source) ? "Available" : "Installed"}</Badge>
        : isPikiExtensionSource(props.source) ? <Badge tone="warning">Update its connector</Badge>
        : availability().status === "other-version" ? <Badge tone="warning">{`${(availability() as { installed: string }).installed.slice((availability() as { installed: string }).installed.lastIndexOf("@") + 1)} installed`}</Badge>
        : <Badge>Missing</Badge>}
    </If>
  );
}

function ToolList(props: { tools: readonly Pick<WorkspaceTool, "name" | "description" | "source" | "mode">[]; sources?: boolean; shadowed?: ReadonlyMap<string, string> }) {
  return (
    <View>
      <Each of={props.tools} key={tool => `${tool.source} ${tool.name}`}>
        {(tool, index) => {
          const by = () => props.shadowed?.get(tool().name);
          return (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 12, rowGap: 2, paddingVertical: 8, borderTopWidth: index() ? 1 : 0, borderColor: palette().border }}>
              <Text style={{ fontFamily: monospace, fontSize: text.small, color: by() ? palette().muted : palette().text, textDecorationLine: by() ? "line-through" : "none" }}>{tool().name}</Text>
              <Text style={{ flex: 1, minWidth: 160, fontSize: text.small, color: palette().muted }}>{descriptionSummary(tool().description) || (by() ? "" : "No description")}</Text>
              <If when={by() || props.sources}>
                <Text style={{ fontSize: text.small, color: palette().muted, numberOfLines: 1 }}>
                  {by() ? `Left out: ${extensionLabel(by()!)} has it` : `${extensionLabel(tool().source)}${tool().mode ? ` · ${toolsLabel[tool().mode!]}` : ""}`}
                </Text>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

function ToolsOverview(props: { usable: WorkspaceTools }) {
  const own = () => props.usable.tools.filter(tool => tool.origin !== "extension");
  const offered = () => props.usable.tools.filter(tool => tool.origin === "extension");
  return (
    <CollapsibleRow leading={<Icon name="terminal" size={16} color={palette().muted} />} title="Tools sessions can use"
      hint={`${props.usable.tools.length} tools: ${own().length} of Pikibun's own, ${offered().length} from extensions${props.usable.off.length ? ` · ${props.usable.off.length} turned off` : ""}`}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: text.body, fontWeight: "500", color: palette().text }}>Pikibun's own</Text>
        <Small>In the session's sandbox or through Pikibun, with the session's permissions, approval cards and Read-only rules</Small>
        <ToolList tools={own()} sources />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: text.body, fontWeight: "500", color: palette().text }}>From extensions</Text>
        <Small>On the host, outside the sandbox: each call is approved like a host command, unless it runs automatically where the workspace and the host's owner allow that</Small>
        <If when={offered().length} else={<Small>{`None: no extension enabled here offers a tool${props.usable.unreported.length ? " that hosts have reported" : ""}.`}</Small>}>
          <ToolList tools={offered()} sources />
        </If>
      </View>
      <If when={props.usable.off.length}><Small>{`Turned off here: ${props.usable.off.map(tool => tool.name).join(", ")}.`}</Small></If>
      <If when={props.usable.unreported.length}>
        <Small>{`Not listed yet: the tools of ${props.usable.unreported.join(", ")}, which no host that has ${props.usable.unreported.length === 1 ? "it" : "them"} installed has reported.`}</Small>
      </If>
      <Small>Each host offers what it can of these: the browser only with Chromium there, an extension only once it is installed there at this version. A host's owner may add extensions they require of every session on their host.</Small>
    </CollapsibleRow>
  );
}

function extensionHint(offer: ExtensionOffer | undefined, shadowed?: ReadonlyMap<string, string>, limit = 300, note?: string, extra?: string): string {
  const parts: string[] = [];
  if (offer?.description) parts.push(`${descriptionSummary(offer.description, limit)}${note ? ` ${note}` : ""}`);
  if (offer) {
    const names = offer.tools.map(tool => (shadowed?.has(tool.name) ? `${tool.name} (left out)` : tool.name));
    parts.push(names.length ? `${names.length === 1 ? "Tool" : "Tools"}: ${names.join(", ")}` : "No tools: prompt text or hooks only");
  } else parts.push("What it is and its tools show here once a host that has it installed reports them.");
  if (extra) parts.push(extra);
  return parts.join("\n");
}

export function WorkspaceExtensions(props: { workspace: Workspace }) {
  const { user } = untracked(session);
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/extensions`;
  const resource = createResource<ExtensionsResponse>(path);
  const action = createAction();
  const editing = signal<WorkspaceExtension | "new" | null>(null);
  const data = () => resource.data();
  const admin = () => data()?.admin === true;
  async function save(extension: WorkspaceExtension, notice = "Extension saved. Sessions pick it up from their next message."): Promise<boolean> {
    const done = await action.run(async () => { await session().api(path(), { method: "PUT", body: extension }); }, notice);
    if (done) resource.refresh();
    return done;
  }
  function install(host: ExtensionHost, source: string) {
    void action.run(async () => {
      await session().api(`/api/connectors/${segment(host.id)}/extensions/requests`, { method: "POST", body: { action: "install", source } });
    }, `Asked ${host.name} to install it: it does within half a minute while it is online. Its page shows how it went.`);
  }
  async function remove(extension: WorkspaceExtension) {
    if (!await confirm({ title: "Remove this extension?", confirmLabel: "Remove", destructive: true,
      message: `Sessions stop running ${extension.source} from their next message. Hosts keep it installed until their owners remove it.` })) return;
    await action.run(async () => {
      await session().api(`${path()}?source=${encodeURIComponent(extension.source)}`, { method: "DELETE" });
      resource.refresh();
    }, "Extension removed.");
  }
  function switchSessionTools(source: string, on: boolean) {
    const extension = pikiExtension(source);
    const replaced = Boolean(extension?.replaces) && Boolean(data()?.extensions.some(item => item.source === extension!.replaces && !item.enabled));
    const removing = extension?.optIn ? !on : on && !replaced;
    void action.run(async () => {
      if (removing) await session().api(`${path()}?source=${encodeURIComponent(source)}`, { method: "DELETE" });
      else await session().api(path(), { method: "PUT", body: { source, enabled: on, tools: "approval", settings: {} } });
      resource.refresh();
    }, on ? "Tool on. Sessions offer it from their next message." : "Tool off. Sessions stop offering it from their next message.");
  }
  const sessionToolSources = new Set<string>(pikiSessionToolExtensions().map(item => item.source));
  const listed = () => (data()?.extensions ?? []).filter(extension => !sessionToolSources.has(extension.source));
  const installed = () => installedOn(data()?.hosts ?? []);
  const usable = () => (data() ? workspaceTools(data()!.extensions, installed()) : undefined);
  const shadowedOf = (source: string) => new Map((usable()?.shadowed ?? []).filter(item => item.source === source).map(item => [item.name, item.by]));
  const conflicts = () => {
    const result: { kind: ShadowKind; tool: string; by: string; sources: string[] }[] = [];
    for (const item of usable()?.shadowed ?? []) {
      const conflict = result.find(other => other.kind === item.kind && other.tool === item.name && other.by === item.by);
      if (conflict) conflict.sources.push(item.source);
      else result.push({ kind: item.kind, tool: item.name, by: item.by, sources: [item.source] });
    }
    return result;
  };
  return (
    <Section title="Extensions" testID="workspace-extensions" info={<View style={{ gap: 8 }}>
      <Note>Pi extensions add tools, prompt text and hooks to this workspace's sessions. A session runs those enabled here that its host has installed at the same version: its host's owner installs them there, from the host's page or with pikibun extensions.</Note>
      <Note>Tools sessions can use lists every tool they get: Pikibun's own, which the session-tool extensions below turn on or off, the built-in code mode, and those of the extensions enabled here, as hosts that have them report them.</Note>
      <Note>Extensions run on the host, as its owner's OS user, outside the sandbox and the network access above. Their tool calls are approved like host commands, by the host's owner or a member granted host commands, unless you set their tools to run automatically and the host's owner allows that on their host.</Note>
      <Note>Settings are the extension's own options. Never put secrets in them: an extension reads keys on its host, which its owner sets up.</Note>
    </View>} action={admin() && listed().length < extensionLimits.workspace ? <Button small variant="outline" icon="plus" label="Add extension" onPress={() => editing.set("new")} /> : undefined}>
      <ResourceState inline loading={resource.loading() && !data()} error={resource.error()} retry={resource.refresh}>
        <If when={data()}>
          {current => (
            <>
              <If when={usable()}>{tools => <ToolsOverview usable={tools()} />}</If>
              <Each of={pikiSessionToolExtensions().filter(item => !item.retired)} key={item => item.source}>
                {item => {
                  const on = () => sessionToolExtensionOn(current().extensions, item().source);
                  return (
                    <Row leading={<Icon name="tool" size={16} color={palette().muted} />} title={`${item().title} · ${item().source}`}
                      hint={extensionHint(extensionOffer(item().source, installed()), undefined, Infinity,
                        item().core ? undefined : item().optIn ? "Hosts on older connectors don't have it." : "Hosts on older connectors offer its tools whatever is chosen here.")}
                      trailing={item().core ? <Badge>Always on</Badge> : admin()
                        ? <Checkbox label="On" checked={on()} disabled={action.busy()} onChange={value => switchSessionTools(item().source, value)} />
                        : <Badge tone={on() ? "success" : "neutral"}>{on() ? "On" : "Off"}</Badge>} />
                  );
                }}
              </Each>
              <If when={!listed().length}>
                <EmptyState title="No extensions">{admin() ? "Add a Pi extension, such as npm:cc-safety-net@2.7.2 or piki:gh (the GitHub CLI), to run it in this workspace's sessions." : "Owners and admins add the Pi extensions this workspace's sessions run."}</EmptyState>
              </If>
              <Each of={listed()} key={extension => extension.source}>
                {extension => {
                  const cli = () => pikiExtension(extension().source);
                  const offer = () => extensionOffer(extension().source, installed());
                  const hostsWithIt = () => current().hosts.filter(host => host.availability?.[extension().source]?.status === "installed").length;
                  return (
                    <CollapsibleRow leading={<Icon name="tool" size={16} color={palette().muted} />} title={cli() ? `${cli()!.title} · ${extension().source}` : extension().source}
                      hint={extensionHint(offer(), extension().enabled ? shadowedOf(extension().source) : undefined, 300, undefined,
                        `Tool calls: ${toolsLabel[extension().tools].toLowerCase()} · ${cli() ? "on" : "installed on"} ${hostsWithIt()} of ${current().hosts.length} ${current().hosts.length === 1 ? "host" : "hosts"}`)}
                      trailing={<Badge tone={extension().enabled ? "success" : "neutral"}>{extension().enabled ? "On" : "Off"}</Badge>}>
                      <If when={offer()?.tools.length}>
                        <ToolList tools={offer()!.tools.map(tool => ({ ...tool, source: extension().source }))} shadowed={extension().enabled ? shadowedOf(extension().source) : undefined} />
                      </If>
                      <Each of={current().hosts} key={host => host.id}>
                        {host => {
                          const availability = () => host().availability?.[extension().source];
                          const installable = () => !cli() && host().ownerId === user.id && host().report?.remoteInstalls === true && availability() && availability()!.status !== "installed";
                          return (
                            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                              <Icon name="server" size={16} color={palette().muted} />
                              <View style={{ flex: 1, minWidth: 120 }}>
                                <Text style={{ fontSize: text.body, color: palette().text }}>{host().name}</Text>
                                <Small>{`Hosted by ${host().ownerId === user.id ? "you" : host().ownerName}`}</Small>
                              </View>
                              <AvailabilityBadge availability={availability()} source={extension().source} />
                              <If when={installable()}>
                                <Button small variant="outline" label={availability()?.status === "other-version" ? "Update" : "Install"} disabled={action.busy()} onPress={() => install(host(), extension().source)} />
                              </If>
                            </View>
                          );
                        }}
                      </Each>
                      <If when={!current().hosts.length}><Small>No host is connected to this workspace yet</Small></If>
                      <If when={cli()?.tool && cli()?.install && cli()?.account}>
                        <Small>{`Each host needs ${cli()?.tool} installed (${cli()?.install}) where its sandbox finds it. It acts as the session's owner, with ${cli()?.account} in Pikibun: it reads the workspace's repositories, and writes only in a call a person approved, on the session owner's own host. Turn on read-only under Edit before running its tools automatically.`}</Small>
                        <View style={{ flexDirection: "row" }}><Button small variant="ghost" icon="external-link" label="How to install it" onPress={() => openExternal(cli()!.install!)} /></View>
                      </If>
                      <If when={admin()}>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                          <Checkbox label="Enabled" checked={extension().enabled} disabled={action.busy()}
                            onChange={value => void save({ ...extension(), enabled: value }, value ? "Extension on." : "Extension off.")} />
                          <View style={{ flex: 1 }} />
                          <Button small variant="outline" icon="pencil" label="Edit" disabled={action.busy()} onPress={() => editing.set(extension())} />
                          <Button small variant="ghost" icon="trash" label="Remove" disabled={action.busy()} onPress={() => void remove(extension())} />
                        </View>
                      </If>
                    </CollapsibleRow>
                  );
                }}
              </Each>
              <Each of={conflicts()} key={conflict => `${conflict.kind} ${conflict.tool} ${conflict.by}`}>
                {conflict => {
                  const one = () => conflict().sources.length === 1;
                  return (
                    <CardBody>
                      <If when={conflict().kind === "own"}>
                        <Banner tone="warning" title={`${conflict().tool} is one of Pikibun's own tools`}>
                          {`${conflict().sources.join(" and ")} ${one() ? "registers" : "register"} a tool named ${conflict().tool}, like Pikibun's own${conflict().by === PIKIBUN ? "" : ` (${conflict().by})`}. Sessions keep Pikibun's, even while it is turned off here, and leave out the ${one() ? "extension's" : "extensions'"}.`}
                        </Banner>
                      </If>
                      <If when={conflict().kind === "extension"}>
                        <Banner tone="warning" title={`${one() ? "Two" : "Several"} extensions offer ${conflict().tool}`}>
                          {`${[conflict().by, ...conflict().sources].join(" and ")} ${one() ? "both" : "all"} register a tool named ${conflict().tool}. Sessions keep the first one's, in this list's order, and leave out the ${one() ? "other's" : "others'"}.`}
                        </Banner>
                      </If>
                      <If when={conflict().kind !== "own" && conflict().kind !== "extension"}>
                        <Banner tone="info" title={`${conflict().by} replaces the built-in ${conflict().tool}`}>
                          {`It registers a tool named ${conflict().tool}, like ${conflict().sources.join(" and ")}: sessions use the extension's instead of the built-in.`}
                        </Banner>
                      </If>
                    </CardBody>
                  );
                }}
              </Each>
            </>
          )}
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      <If when={editing() && data() ? editing() : null}>
        {current => (
          <ExtensionSheet extension={current() === "new" ? undefined : current() as WorkspaceExtension} taken={data()!.extensions} installed={installed()}
            flags={current() === "new" ? undefined : flagsOf((current() as WorkspaceExtension).source, data()!.hosts)}
            close={() => editing.set(null)} save={async extension => { if (await save(extension)) editing.set(null); }} busy={action.busy()} error={action.error()} />
        )}
      </If>
    </Section>
  );
}

function ExtensionSheet(props: { extension?: WorkspaceExtension; taken: readonly WorkspaceExtension[]; installed: readonly InstalledExtension[]; flags?: ExtensionFlag[];
  close: () => void; save: (extension: WorkspaceExtension) => Promise<void>; busy: boolean; error: string }) {
  const existing = untracked(() => props.extension);
  const source = signal(existing?.source ?? "");
  const tools = signal<ExtensionToolMode>(existing?.tools ?? "approval");
  const settings = signal<ExtensionSettings>(existing?.settings ?? {});
  const parsed = () => {
    try { return { normalized: source().trim() ? normalizeExtensionSource(source().trim()) : undefined, invalid: "" }; }
    catch (reason) { return { normalized: undefined, invalid: reason instanceof Error ? reason.message : "Invalid source" }; }
  };
  const normalized = () => parsed().normalized;
  const replacing = () => (!existing && normalized() ? props.taken.find(item => extensionPackageKey(item.source) === extensionPackageKey(normalized()!)) : undefined);
  const cli = () => (normalized() ? pikiExtension(normalized()!) : undefined);
  const offer = () => (normalized() ? extensionOffer(normalized()!, props.installed) : undefined);
  const offered = () => pikiCommandExtensions().filter(item => !props.taken.some(used => used.source === item.source));
  const workflows = () => pikiWorkflowExtensions().filter(item => !props.taken.some(used => used.source === item.source));
  const editingCli = Boolean(existing && isPikiExtensionSource(existing.source));
  const extra = () => Object.keys(settings()).filter(name => !props.flags?.some(flag => flag.name === name));
  function submit() {
    const value = normalized();
    if (value) void props.save({ source: value, enabled: existing?.enabled ?? true, tools: tools(), settings: settings() });
  }
  return (
    <FormSheet open title={existing ? "Edit extension" : "Add extension"} onClose={() => { if (!props.busy) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.close} />
        <Button variant="primary" label={props.busy ? "Saving…" : "Save"} disabled={props.busy || !normalized()} onPress={submit} />
      </>}>
      <If when={!existing && offered().length}>
        <Field label="Command-line tools" hint="These come with every host's connector: each host needs only the command itself, signed in by its owner.">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Each of={offered()} key={item => item.source}>
              {item => <Button small variant={normalized() === item().source ? "primary" : "outline"} label={item().title} disabled={props.busy} onPress={() => source.set(item().source)} />}
            </Each>
          </View>
        </Field>
      </If>
      <If when={!existing && workflows().length}>
        <Field label="Workflows" hint="These come with every host's connector too: they guide how the agent works with the session's own tools, and add none. Set their settings with Edit once added.">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Each of={workflows()} key={item => item.source}>
              {item => <Button small variant={normalized() === item().source ? "primary" : "outline"} label={item().title} disabled={props.busy} onPress={() => source.set(item().source)} />}
            </Each>
          </View>
        </Field>
      </If>
      <Field label="Source" error={parsed().invalid} hint={editingCli ? "Built into the connector: its version is each host's connector's"
        : existing ? "Change the version to move every host to it: until a host's owner installs it there, sessions on that host run without it"
        : "npm:<package>@<exact version>, git:<https URL>@<full commit>, or piki:<name>. A Pi extension package, pinned"}>
        <TextField monospace value={source()} onChange={value => source.set(value)} disabled={props.busy || editingCli} maxLength={512} placeholder="npm:cc-safety-net@2.7.2" autoFocus={!existing} />
      </Field>
      <If when={offer()} else={<If when={normalized()}><Note>What it is and its tools show here once a host that has it installed at this version reports them.</Note></If>}>
        {current => (
          <View style={{ gap: 8 }}>
            <If when={current().description}><Note>{`${current().description!.trim()}${cli()?.tool ? ` It runs ${cli()!.tool} as the host's owner is signed in to it.` : ""}`}</Note></If>
            <If when={current().tools.length} else={<Note>No tools: it adds prompt text or hooks only.</Note>}>
              <ToolList tools={current().tools.map(tool => ({ ...tool, source: normalized()! }))} shadowed={new Map(current().tools.filter(tool => tool.own).map(tool => [tool.name, PIKIBUN]))} />
            </If>
          </View>
        )}
      </If>
      <If when={replacing()}><Note>{`The workspace uses ${replacing()?.source}: this replaces it, in its place.`}</Note></If>
      <Field label="Tools" hint={tools() === "approval" ? "Each tool call waits for the host's owner, or a member granted host commands, to approve it."
        : "Tool calls run at once, outside the sandbox, on hosts whose owner lets workspaces do that; elsewhere they still wait for approval."}>
        <Segmented value={tools()} onChange={value => tools.set(value)} options={(["approval", "automatic"] as const).map(value => ({ value, label: toolsLabel[value] }))} />
      </Field>
      <If when={existing}>
        <If when={props.flags !== undefined} else={<Note>Its settings show here once a host that has it installed reports them.</Note>}>
          <If when={props.flags?.length || extra().length} else={<Note>This extension has no settings.</Note>}>
            <ExtensionSettingsFields flags={props.flags ?? []} settings={settings()} onChange={value => settings.set(value)} busy={props.busy} />
            <Note>Never put secrets here: every member of the workspace can read these, and they are in its audit log.</Note>
          </If>
        </If>
      </If>
      <Feedback error={props.error} />
    </FormSheet>
  );
}
