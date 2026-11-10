import { computed, effect, signal, untracked, View } from "nsh";
import type { ConnectorInfo } from "../../../../packages/shared/src/connector";
import { builtinExtensions, hostConfigLimits, type BuiltinExtensionName, type RequiredExtension } from "../../../../packages/shared/src/host-config";
import {
  isPikiExtensionSource, missingRequiredExtensions, normalizeExtensionSource, type ExtensionAvailability, type ExtensionSettings, type HostExtensionsReport,
  type InstalledExtension,
} from "../../../../packages/shared/src/host-extensions";
import { pikiExtension } from "../../../../packages/shared/src/piki-extensions";
import { defaultHostBrowserConfig, type BrowserSource, type HostBrowserConfig, type HostBrowserStatus } from "../../../../packages/shared/src/browser";
import { defaultHostTunnelConfig, type HostTunnelConfig, type HostTunnelStatus, type TunnelSource } from "../../../../packages/shared/src/tunnel";
import { segment } from "../shared";
import { session } from "../lib/auth";
import { relativeTime } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import { Icon } from "../icons";
import { palette } from "../theme";
import { Checkbox, CheckControl, Field, TextField } from "../form";
import { Badge, Banner, Button, CardBody, CollapsibleRow, confirm, Feedback, FormSheet, Note, ResourceState, Row, Section, Segmented, Small, Value } from "../ui";
import { ExtensionSettingsFields } from "./extension-fields";

interface HostRequest { id: string; action: "install" | "remove"; source: string; status: "pending" | "done" | "failed"; error?: string; requestedAt: string; finishedAt?: string }
interface HostExtensionsResponse {
  role: "owner" | "admin";
  report?: HostExtensionsReport; reportedAt?: string;
  automaticTools: boolean;
  requests: HostRequest[];
  workspaces: { id: string; name: string; shared: boolean; extensions: { source: string; availability: ExtensionAvailability }[] }[];
}

const BROWSER = "piki:browser";
const TUNNEL = "piki:tunnel";

const browserHints: Readonly<Record<HostBrowserStatus["state"], string>> = {
  ready: "Sessions in this host's sandbox can open web pages with it",
  missing: "No Chromium for it on this host: its sessions have no browser until you set one up below",
  downloading: "Downloading Chromium for it: its sessions get the browser once it is ready",
  failed: "Chromium's download failed: it is tried again in a few minutes, or set one up another way below",
  off: "Off on this host: its sessions have no browser",
  unsupported: "It runs in the Linux sandbox only, which this host's sessions don't have",
};
const tunnelHints: Readonly<Record<HostTunnelStatus["state"], string>> = {
  ready: "Sessions in this host's sandbox can put their servers online with it, where their workspace turns the tunnel on",
  missing: "No cloudflared for it on this host: its sessions have no tunnel until you set one up below",
  downloading: "Downloading cloudflared for it: its sessions get the tunnel once it is ready",
  failed: "cloudflared's download failed: it is tried again in a few minutes, or set one up another way below",
  off: "Off on this host: its sessions put nothing online",
  unsupported: "Session services run in the Linux sandbox only, which this host's sessions don't have",
};

type ToolState = HostBrowserStatus["state"];
function StateBadge(props: { state: ToolState; missing: string }) {
  return (
    <Badge tone={props.state === "ready" ? "success" : props.state === "missing" ? "warning" : props.state === "failed" ? "danger" : "neutral"} dot={props.state === "downloading"}>
      {props.state === "ready" ? "Ready" : props.state === "downloading" ? "Downloading" : props.state === "missing" ? props.missing : props.state === "failed" ? "Download failed"
        : props.state === "off" ? "Off" : "Not on this host"}
    </Badge>
  );
}

export const browserSources: { value: BrowserSource; label: string; hint: string }[] = [
  { value: "auto", label: "Find it", hint: "Looks on this host: PIKIBUN_BROWSER, your distribution's chromium, Google Chrome or Chromium, then Playwright's and Puppeteer's downloads, then one downloaded here" },
  { value: "path", label: "This path", hint: "Runs the Chromium executable you name, and no other" },
  { value: "download", label: "Download", hint: "The connector downloads Chrome for Testing's headless shell (about 110 MB) into its own folder, and keeps it up to date" },
  { value: "off", label: "Off", hint: "Sessions on this host get no browser" },
];
const tunnelSources: { value: TunnelSource; label: string; hint: string }[] = [
  { value: "auto", label: "Find it", hint: "Looks on this host: PIKIBUN_CLOUDFLARED, cloudflared on the connector's PATH, /usr/local/bin and /usr/bin, Homebrew's, then one downloaded here" },
  { value: "path", label: "This path", hint: "Runs the cloudflared executable you name, and no other" },
  { value: "download", label: "Download", hint: "The connector downloads the cloudflared its version pins (about 40 MB) into its own folder, checked against the SHA-256 the connector carries" },
  { value: "off", label: "Off", hint: "Sessions on this host put nothing online, whatever their workspace chose" },
];

export function ToolSetup<S extends "auto" | "path" | "download" | "off">(props: {
  kind: "browser" | "tunnel"; saved: { source: S; path?: string }; status?: { state: ToolState; source: S; executable?: string; version?: string; error?: string; downloadable?: boolean };
  owner: boolean; busy: boolean; revoked: boolean; sources: { value: S; label: string; hint: string }[]; save: (value: { source: S; path?: string }) => void;
}) {
  const browser = props.kind === "browser";
  const source = signal<S>(untracked(() => props.saved.source));
  const path = signal(untracked(() => props.saved.path ?? ""));
  const savedSource = computed(() => props.saved.source);
  const savedPath = computed(() => props.saved.path ?? "");
  effect(() => {
    const nextSource = savedSource();
    const nextPath = savedPath();
    untracked(() => { source.set(nextSource); path.set(nextPath); });
  });
  const chosen = () => path().trim();
  const pathError = () => (source() === "path" && chosen() && !chosen().startsWith("/")
    ? browser ? "The executable's absolute path, such as /usr/lib/chromium/chromium" : "The executable's absolute path, such as /usr/local/bin/cloudflared" : undefined);
  const changed = () => source() !== props.saved.source || (source() === "path" && chosen() !== (props.saved.path ?? ""));
  const current = () => (props.status && props.status.source === props.saved.source ? props.status : undefined);
  const hints = browser ? browserHints : tunnelHints;
  function submit() {
    if (!changed() || pathError() || (source() === "path" && !chosen())) return;
    props.save(source() === "path" ? { source: source(), path: chosen() } : { source: source() });
  }
  return (
    <View style={{ gap: 12 }}>
      <If when={current()?.state === "ready"}>
        <Small>{browser
          ? `Sessions run ${current()?.executable ?? "the host's Chromium"}${current()?.version ? ` (${current()!.version})` : ""}, read-only in their sandbox.`
          : `Tunnels run ${current()?.executable ?? "the host's cloudflared"}${current()?.version ? ` (${current()!.version})` : ""} in this host's connector, never in a session's sandbox. It needs to reach Cloudflare's edge on port 7844.`}</Small>
      </If>
      <If when={current() && current()!.state !== "ready" && current()!.state !== "off" ? current() : null}>
        {status => (
          <Banner tone={status().state === "downloading" ? "info" : "warning"}
            title={status().state === "downloading" ? `Downloading ${browser ? "Chromium" : "cloudflared"}` : status().state === "failed" ? `${browser ? "Chromium" : "cloudflared"}'s download failed`
              : status().state === "unsupported" ? "Not on this host" : browser ? "No Chromium for the browser" : "No cloudflared for the tunnel"}>
            {status().error ?? hints[status().state]}
          </Banner>
        )}
      </If>
      <If when={props.status && !current()}><Small>The host applies your choice as it next reports, within a minute.</Small></If>
      <If when={props.owner}
        else={<Small>{browser ? "Only the host's owner chooses where its Chromium comes from." : "Only the host's owner chooses where its cloudflared comes from, or refuses tunnels on it."}</Small>}>
        <Segmented<S> small value={source()} onChange={value => source.set(value)} options={props.sources.map(({ value, label }) => ({ value, label }))} />
        <Small>{`${props.sources.find(item => item.value === source())?.hint ?? ""}${source() === "download" && props.status && !props.status.downloadable
          ? browser ? ". Chrome for Testing builds it for Linux on x86-64 only: on this host, install your distribution's chromium and find it instead."
            : ". Cloudflare builds a lone cloudflared for Linux on x86-64 and ARM64 only: on this host, install its package and find it instead." : ""}`}</Small>
        <If when={source() === "path"}>
          <Field label={browser ? "Chromium executable" : "cloudflared executable"} error={pathError()}
            hint={browser ? "The program itself, beside Chromium's own files (icudtl.dat, its .pak files): /usr/lib/chromium/chromium rather than the /usr/bin/chromium script" : "The program itself, such as /usr/local/bin/cloudflared"}>
            <TextField testID={`${props.kind}-path`} monospace value={path()} onChange={value => path.set(value)} maxLength={4096} placeholder={browser ? "/usr/lib/chromium/chromium" : "/usr/local/bin/cloudflared"} />
          </Field>
        </If>
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Button small variant="primary" label="Save" disabled={!changed() || props.busy || Boolean(pathError()) || (source() === "path" && !chosen()) || props.revoked} onPress={submit} />
        </View>
      </If>
    </View>
  );
}

function ModuleDetails(props: { extension: InstalledExtension }) {
  return (
    <If when={!props.extension.error} else={<Small tone="danger">{`Doesn't load: ${props.extension.error}`}</Small>}>
      <Each of={props.extension.modules} key={module => module.path}>
        {module => (
          <View style={{ gap: 4 }}>
            <Value monospace>{module().path}</Value>
            <If when={module().error}><Small tone="danger">{`Doesn't load: ${module().error}`}</Small></If>
            <If when={module().tools.length}><Small>{`Tools: ${module().tools.map(tool => tool.name).join(", ")}`}</Small></If>
            <If when={module().events.length}><Small>{`Events: ${module().events.join(", ")}`}</Small></If>
            <If when={module().flags.length}><Small>{`Settings: ${module().flags.map(flag => flag.name).join(", ")}`}</Small></If>
            <If when={module().noops.length}><Small>{`Does nothing in Pikibun: ${module().noops.join(", ")}`}</Small></If>
            <If when={module().ignored.length}><Small>{`Not supported: ${module().ignored.join(", ")}`}</Small></If>
          </View>
        )}
      </Each>
    </If>
  );
}

const info = (
  <View style={{ gap: 8 }}>
    <Note>Pi extensions this host runs for the sessions on it: those a workspace chose that it has installed at the same version. They run in its connector, as your OS user, outside the sandbox.</Note>
    <Note>Install what your workspaces use here, or on the host with pikibun extensions add. A dev extension, installed there from a local path, runs only in your own sessions on this host.</Note>
    <Note>Pikibun's own built-in extensions come with the connector too: piki:gh, piki:glab and piki:azure-cli run the GitHub, GitLab and Azure CLIs where your workspaces use them, as you are signed in to them on this host.</Note>
    <Note>Extension tool calls need the approval of you or a member granted host commands, unless a workspace sets an extension's tools to automatic and you let workspaces do that here.</Note>
    <Note>Require an extension of every session to run it on this host whatever each workspace chose, yours included, with the settings you give it here. While this host can't run one you require, its sessions take no messages.</Note>
  </View>
);

export function HostExtensionsSection(props: { connector: ConnectorInfo; refresh: () => void }) {
  const path = () => `/api/connectors/${segment(props.connector.id)}/extensions`;
  const resource = createResource<HostExtensionsResponse>(path);
  const action = createAction();
  const installing = signal(false);
  const configuring = signal<{ extension: RequiredExtension; flags: InstalledExtension["modules"][number]["flags"] } | null>(null);
  const data = () => resource.data();
  const owner = () => data()?.role === "owner";
  const pending = () => data()?.requests.filter(request => request.status === "pending") ?? [];
  const config = () => props.connector.config;
  const report = () => data()?.report;
  const changing = () => pending().length > 0
    || Boolean(report()?.browser && config() && (report()!.browser!.source !== config()!.browser.source || report()!.browser!.state === "downloading"))
    || Boolean(report()?.tunnel && config()?.tunnel && (report()!.tunnel!.source !== config()!.tunnel!.source || report()!.tunnel!.state === "downloading"));
  effect(() => {
    if (!changing()) return;
    const timer = setInterval(resource.refresh, 5000);
    return () => clearInterval(timer);
  });
  const notice = () => (props.connector.online ? "Asked the host: it carries this out within half a minute." : "Asked the host: it carries this out once it is online.");
  async function request(requestAction: "install" | "remove", source: string): Promise<boolean> {
    return action.run(async () => {
      await session().api(`${path()}/requests`, { method: "POST", body: { action: requestAction, source } });
      resource.refresh();
    }, notice());
  }
  async function remove(source: string) {
    if (!await confirm({ title: "Remove this extension from the host?", confirmLabel: "Remove", destructive: true,
      message: `Sessions on this host stop running ${source} once it is removed, in every workspace that uses it.` })) return;
    await request("remove", source);
  }
  const patchConfig = (body: Record<string, unknown>) => session().api(`/api/connectors/${segment(props.connector.id)}/config`, { method: "PATCH", body });
  function setAutomatic(automaticTools: boolean) {
    void action.run(async () => {
      await session().api(path(), { method: "PATCH", body: { automaticTools } });
      resource.refresh();
    }, automaticTools ? "Workspaces may now run extension tools without approval on this host, where they set them to automatic." : "Extension tools on this host need approval again.");
  }
  const builtin = () => config()?.builtinExtensions ?? [];
  function setBuiltin(name: BuiltinExtensionName, on: boolean) {
    const next = builtinExtensions.map(item => item.name).filter(item => (item === name ? on : builtin().includes(item)));
    const item = builtinExtensions.find(candidate => candidate.name === name);
    const title = item?.title ?? name;
    const core = Boolean(item && "core" in item && item.core === true);
    void action.run(async () => { await patchConfig({ builtinExtensions: next }); props.refresh(); }, core
      ? on ? `${title} is on for older connectors too. Connectors of this release or later always run it.` : `${title} is off for older connectors only. Connectors of this release or later always run it.`
      : on ? `${title} is on: sessions on this host get it with their next message, within a minute.` : `${title} is off: sessions on this host run without it from their next message, within a minute.`);
  }
  const required = () => config()?.requiredExtensions ?? [];
  function saveTool(kind: "browser" | "tunnel", value: HostBrowserConfig | HostTunnelConfig) {
    void action.run(async () => {
      await patchConfig({ [kind]: value });
      props.refresh();
      setTimeout(resource.refresh, 35_000);
    }, value.source === "download" ? `Saved: the host starts downloading ${kind === "browser" ? "Chromium" : "cloudflared"} within a minute, and keeps it up to date`
      : kind === "tunnel" && value.source === "off" ? "Saved: the host refuses tunnels within a minute; one online now stays until it stops" : "Saved: the host applies it within a minute");
  }
  const saveRequired = (next: RequiredExtension[], message: string) => action.run(async () => { await patchConfig({ requiredExtensions: next }); props.refresh(); }, message);
  async function setRequired(extension: InstalledExtension, on: boolean) {
    const name = pikiExtension(extension.source)?.title ?? extension.source;
    if (on && !await confirm({ title: `Require ${name} of every session?`, confirmLabel: "Require",
      message: `Every session on ${props.connector.name} will run ${extension.source}, yours included, in every workspace, whatever the workspace chose. It runs in this host's connector, as your OS user. Its settings are yours to set here.` })) return;
    const next = on ? [...required(), { source: extension.source, settings: {} }] : required().filter(item => item.source !== extension.source);
    const saved = await saveRequired(next, on ? `Every session on this host runs ${name} from its next message, within a minute.` : `${name} is no longer required: sessions run it only where their workspace chose it.`);
    if (saved && on && extension.modules.some(module => module.flags.length)) configuring.set({ extension: { source: extension.source, settings: {} }, flags: extension.modules.flatMap(module => module.flags) });
  }
  const isRequired = (source: string) => required().some(item => item.source === source);
  const installedSources = () => new Set(report()?.installed.map(item => item.source) ?? []);
  const unavailable = () => (report() ? missingRequiredExtensions(required(), report()!.installed).flatMap(source => required().filter(item => item.source === source)) : []);
  const missing = () => (data()?.workspaces ?? []).flatMap(workspace => workspace.extensions.filter(item => item.availability.status !== "installed").map(item => ({ workspace, ...item })));
  const waiting = (source: string) => pending().some(item => item.source === source);
  const revoked = () => Boolean(props.connector.revokedAt);
  return (
    <Section title="Extensions" info={info} testID="host-extensions" action={owner() && report()?.remoteInstalls !== false
      ? <Button small variant="outline" icon="plus" label="Install extension" disabled={revoked()} onPress={() => installing.set(true)} /> : undefined}>
      <ResourceState inline loading={resource.loading() && !data()} error={resource.error()} retry={resource.refresh}>
        <If when={config()}>
          <Each of={builtinExtensions} key={item => item.name}>
            {item => {
              const core = () => "core" in item() && (item() as { core?: boolean }).core === true;
              return (
                <Row leading={<Icon name="tool" size={16} color={palette().muted} />} title={`${item().title} · ${item().name}`}
                  hint={props.connector.capabilities.builtinExtensions ? `${item().description} Tools: ${item().tools.join(", ")}${core() ? ". Always on with connectors of this release or later; older ones run it only where it's ticked here." : ""}`
                    : "This host's connector predates built-in extensions: its sessions run without them until it is updated (npx pikibun@latest connect)"}
                  trailing={<Checkbox label={core() ? "Older connectors too" : "Every session"} checked={builtin().includes(item().name)} disabled={action.busy() || revoked()}
                    onChange={on => setBuiltin(item().name, on)} />} />
              );
            }}
          </Each>
        </If>
        <If when={!props.connector.capabilities.extensions}><Row title="Update the host's connector" hint="This host's connector predates extensions: its sessions run none until it is updated (npx pikibun@latest connect)." /></If>
        <If when={props.connector.capabilities.extensions && data() && !report()}><Row title="Not reported yet" hint="The host reports its extensions once its connector is online" /></If>
        <If when={report() && !report()!.remoteInstalls}><Row title="Installs from Pikibun are off" hint="Its connector runs with --no-remote-installs: install extensions on the host with pikibun extensions" /></If>
        <If when={report() && !report()!.installed.length}><Row title="No extensions installed" hint="Install those your workspaces use, below" /></If>
        <Each of={report()?.installed ?? []} key={extension => extension.source}>
          {extension => {
            const source = () => extension().source;
            const broken = () => Boolean(extension().error || extension().modules.some(module => module.error));
            return (
              <CollapsibleRow leading={<Icon name="tool" size={16} color={palette().muted} />} title={source()}
                hint={source() === BROWSER && report()?.browser ? browserHints[report()!.browser!.state] : source() === TUNNEL && report()?.tunnel ? tunnelHints[report()!.tunnel!.state]
                  : extension().dev ? "Dev extension: your own sessions on this host" : extension().description ?? `${extension().modules.flatMap(module => module.tools).length} tools`}
                trailing={broken() ? <Badge tone="danger">Error</Badge>
                  : source() === BROWSER && report()?.browser ? <StateBadge state={report()!.browser!.state} missing="No Chromium" />
                  : source() === TUNNEL && report()?.tunnel ? <StateBadge state={report()!.tunnel!.state} missing="No cloudflared" />
                  : extension().dev ? <Badge tone="warning">Dev</Badge> : isPikiExtensionSource(source()) ? <Badge>With the connector</Badge>
                  : waiting(source()) ? <Badge dot>Removing</Badge> : <Badge tone="success">Installed</Badge>}>
                <If when={source() === BROWSER && config()}>
                  <ToolSetup<BrowserSource> kind="browser" saved={config()?.browser ?? defaultHostBrowserConfig} status={report()?.browser} owner={owner()} busy={action.busy()} revoked={revoked()}
                    sources={browserSources} save={value => saveTool("browser", value as HostBrowserConfig)} />
                </If>
                <If when={source() === TUNNEL && config()}>
                  <ToolSetup<TunnelSource> kind="tunnel" saved={config()?.tunnel ?? defaultHostTunnelConfig} status={report()?.tunnel} owner={owner()} busy={action.busy()} revoked={revoked()}
                    sources={tunnelSources} save={value => saveTool("tunnel", value as HostTunnelConfig)} />
                </If>
                <ModuleDetails extension={extension()} />
                <If when={!extension().dev && !extension().error && !pikiExtension(source())?.sessionTools && (owner() || isRequired(source()))}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <If when={owner()} else={<Badge tone="success">Required of every session</Badge>}>
                      <Checkbox label="Require of every session" checked={isRequired(source())}
                        disabled={action.busy() || revoked() || (!isRequired(source()) && required().length >= hostConfigLimits.requiredExtensions)}
                        onChange={on => void setRequired(extension(), on)} />
                    </If>
                    <If when={owner() && isRequired(source()) && extension().modules.some(module => module.flags.length)}>
                      <Button small variant="outline" icon="pencil" label="Settings" disabled={action.busy()}
                        onPress={() => configuring.set({ extension: required().find(item => item.source === source())!, flags: extension().modules.flatMap(module => module.flags) })} />
                    </If>
                    <View style={{ flex: 1 }} />
                    <If when={owner() && !isPikiExtensionSource(source()) && report()?.remoteInstalls}>
                      <Button small variant="ghost" icon="trash" label="Remove" disabled={action.busy() || waiting(source())} onPress={() => void remove(source())} />
                    </If>
                  </View>
                </If>
              </CollapsibleRow>
            );
          }}
        </Each>
        <If when={props.connector.capabilities.extensions && !props.connector.capabilities.requiredExtensions && required().length > 0}>
          <Row leading={<Icon name="alert" size={16} color={palette().muted} />} title="Update the host's connector"
            hint="This host's connector predates required extensions: its sessions run only what their workspace chose, and messages go unaudited, until it is updated (npx pikibun@latest connect)" />
        </If>
        <Each of={unavailable()} key={item => item.source}>
          {item => (
            <Row leading={<Icon name="alert" size={16} color={palette().muted} />} title={item().source}
              hint={isPikiExtensionSource(item().source) ? "Required of every session, but this host's connector doesn't have it: no session here takes messages until the connector is updated (npx pikibun@latest connect), or you stop requiring it"
                : installedSources().has(item().source) ? "Required of every session, but it doesn't load here: no session takes messages until it does, or you stop requiring it"
                : "Required of every session, but not installed here: no session takes messages until it is, or you stop requiring it"}
              trailing={<>
                <If when={owner() && !isPikiExtensionSource(item().source) && !installedSources().has(item().source) && report()?.remoteInstalls}>
                  <If when={!waiting(item().source)} else={<Badge dot>Installing</Badge>}>
                    <Button small variant="outline" label="Install" disabled={action.busy() || revoked()} onPress={() => void request("install", item().source)} />
                  </If>
                </If>
                <If when={owner()} else={<Badge tone="danger">Missing</Badge>}>
                  <Button small variant="ghost" label="Stop requiring" disabled={action.busy()} onPress={() => void saveRequired(required().filter(other => other.source !== item().source), "No longer required.")} />
                </If>
              </>} />
          )}
        </Each>
        <Each of={missing()} key={item => `${item.workspace.id} ${item.source}`}>
          {item => (
            <Row leading={<Icon name="alert" size={16} color={palette().muted} />} title={item().source}
              hint={isPikiExtensionSource(item().source) ? `${item().workspace.name} uses it, which comes with newer connectors. Its sessions here run without it until this host's connector is updated (npx pikibun@latest connect)`
                : `${item().workspace.name} uses it${item().availability.status === "other-version" ? `; this host has ${(item().availability as { installed?: string }).installed}` : "; this host doesn't have it"}. Its sessions here run without it`}
              trailing={isPikiExtensionSource(item().source) ? <Badge tone="warning">Update the connector</Badge>
                : waiting(item().source) ? <Badge dot>Installing</Badge>
                : owner() && report()?.remoteInstalls !== false ? <Button small variant="outline" label={item().availability.status === "other-version" ? "Update" : "Install"}
                  disabled={action.busy() || revoked()} onPress={() => void request("install", item().source)} />
                : <Badge>Missing</Badge>} />
          )}
        </Each>
        <If when={data()}>
          <If when={owner()} else={<Row title="Extension tools without approval" trailing={<Badge tone={data()?.automaticTools ? "warning" : "neutral"}>{data()?.automaticTools ? "Allowed" : "Off"}</Badge>} />}>
            <Row title="Let workspaces run extension tools without approval" hint="Only where a workspace sets an extension's tools to automatic. Off: each call waits for you, or a member granted host commands"
              trailing={<CheckControl label="Let workspaces run extension tools without approval" checked={Boolean(data()?.automaticTools)} disabled={action.busy()} onChange={setAutomatic} />} />
          </If>
        </If>
        <If when={data()?.requests.length}>
          <CollapsibleRow title="Recent requests" hint={pending().length ? `${pending().length} waiting for the host` : "Installs and removals asked for here"}>
            <Each of={data()?.requests ?? []} key={item => item.id}>
              {item => (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Value monospace>{`${item().action === "install" ? "Install" : "Remove"} ${item().source}`}</Value>
                    <Small tone={item().error ? "danger" : undefined}>{item().error ?? relativeTime(item().finishedAt ?? item().requestedAt)}</Small>
                  </View>
                  <Badge tone={item().status === "done" ? "success" : item().status === "failed" ? "danger" : "neutral"} dot={item().status === "pending"}>
                    {item().status === "pending" ? "Waiting" : item().status === "done" ? "Done" : "Failed"}
                  </Badge>
                </View>
              )}
            </Each>
          </CollapsibleRow>
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      <InstallSheet open={installing()} close={() => installing.set(false)} busy={action.busy()} error={action.error()}
        install={async source => { if (await request("install", source)) installing.set(false); }} />
      <If when={configuring()}>
        {current => (
          <RequiredSettingsSheet extension={current().extension} flags={current().flags} busy={action.busy()} error={action.error()} close={() => configuring.set(null)}
            save={async settings => {
              const next = required().map(item => (item.source === current().extension.source ? { ...item, settings } : item));
              if (await saveRequired(next, "Settings saved. Sessions on this host use them from their next message, within a minute.")) configuring.set(null);
            }} />
        )}
      </If>
    </Section>
  );
}

function RequiredSettingsSheet(props: { extension: RequiredExtension; flags: InstalledExtension["modules"][number]["flags"]; close: () => void;
  save: (settings: ExtensionSettings) => Promise<void>; busy: boolean; error: string }) {
  const settings = signal<ExtensionSettings>(untracked(() => props.extension.settings));
  const piki = () => pikiExtension(props.extension.source);
  return (
    <FormSheet open title={`${piki()?.title ?? props.extension.source} settings`} onClose={() => { if (!props.busy) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.close} />
        <Button variant="primary" label={props.busy ? "Saving…" : "Save"} disabled={props.busy} onPress={() => void props.save(settings())} />
      </>}>
      <If when={piki()}><Note>{piki()?.description}</Note></If>
      <ExtensionSettingsFields flags={props.flags} settings={settings()} onChange={value => settings.set(value)} busy={props.busy} multiline={["policy"]} />
      <Note>Every session on this host runs it with these settings, whatever its workspace set. Never put secrets here: they are in the host's audit log, which its admins can read.</Note>
      <Feedback error={props.error} />
    </FormSheet>
  );
}

function InstallSheet(props: { open: boolean; close: () => void; install: (source: string) => Promise<void>; busy: boolean; error: string }) {
  const source = signal("");
  const parsed = () => {
    try { return { normalized: source().trim() ? normalizeExtensionSource(source().trim()) : undefined, invalid: "" }; }
    catch (reason) { return { normalized: undefined, invalid: reason instanceof Error ? reason.message : "Invalid source" }; }
  };
  return (
    <FormSheet open={props.open} title="Install extension" onClose={() => { if (!props.busy) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.close} />
        <Button variant="primary" label={props.busy ? "Asking…" : "Install"} disabled={props.busy || !parsed().normalized}
          onPress={() => { const value = parsed().normalized; if (value) void props.install(value); }} />
      </>}>
      <Banner tone="warning" title="Runs on your machine">An extension runs in this host's connector, as your OS user, with your files, credentials and network. Install only code you trust. npm runs none of its install scripts.</Banner>
      <Field label="Source" hint="npm:<package>@<exact version>, or git:<https URL>@<full commit>" error={parsed().invalid}>
        <TextField monospace value={source()} onChange={value => source.set(value)} disabled={props.busy} maxLength={512} placeholder="npm:cc-safety-net@2.7.2" autoFocus />
      </Field>
      <Feedback error={props.error} />
    </FormSheet>
  );
}
