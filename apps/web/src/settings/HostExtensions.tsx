import { useEffect, useState, type FormEvent } from "react";
import type { ConnectorInfo } from "../../../../packages/shared/src/connector";
import { builtinExtensions, hostConfigLimits, type BuiltinExtensionName, type RequiredExtension } from "../../../../packages/shared/src/host-config";
import { isPikiExtensionSource, missingRequiredExtensions, normalizeExtensionSource, type ExtensionAvailability, type ExtensionSettings, type HostExtensionsReport,
  type InstalledExtension } from "../../../../packages/shared/src/host-extensions";
import { pikiExtension } from "../../../../packages/shared/src/piki-extensions";
import { defaultHostBrowserConfig, type BrowserSource, type HostBrowserConfig, type HostBrowserStatus } from "../../../../packages/shared/src/browser";
import { defaultHostTunnelConfig, type HostTunnelConfig, type HostTunnelStatus, type TunnelSource } from "../../../../packages/shared/src/tunnel";
import { ExtensionSettingsFields } from "./ExtensionSettingsFields";
import { api, segment } from "../api";
import { Icon } from "../icons";
import { Alert, Button, CardBody, Collapsible, confirmDialog, Feedback, Field, RelativeTime, ResourceState, Row, Section, SegmentedControl, Sheet, StatusBadge,
  useAction, useResource } from "../ui";

/*
 * A host's extensions (docs/design/host-extensions.md): what it has installed and what each offers, ignores or does
 * nothing with; the extensions its workspaces use that it lacks, which its owner installs here; and its owner's switch
 * that lets workspaces run extension tools without approval on it. Its connector carries out installs when it next
 * syncs, within half a minute while it is online. Above them, Pi's built-in extensions, which its owner and admins turn
 * on for every session on it (HostConfig.builtinExtensions), with nothing to install. Its owner can also require any of
 * its extensions, Pikibun's own (such as piki:prompt-audit) or installed ones, of every session on it, with settings of
 * their own (HostConfig.requiredExtensions).
 */

interface HostRequest { id: string; action: "install" | "remove"; source: string; status: "pending" | "done" | "failed"; error?: string; requestedAt: string; finishedAt?: string }
interface HostExtensionsResponse {
  role: "owner" | "admin";
  report?: HostExtensionsReport; reportedAt?: string;
  automaticTools: boolean;
  requests: HostRequest[];
  workspaces: { id: string; name: string; shared: boolean; extensions: { source: string; availability: ExtensionAvailability }[] }[];
}

const info = <div className="stack">
  <p>Pi extensions this host runs for the sessions on it: those a workspace chose that it has installed at the same version. They run in its connector, as your OS user, outside the sandbox.</p>
  <p>Install what your workspaces use here, or on the host with <code>pikibun extensions add</code>. A dev extension, installed there from a local path, runs only in your own sessions on this host.</p>
  <p>Pikibun's own built-in extensions come with the connector too: <code>piki:gh</code>, <code>piki:glab</code> and <code>piki:azure-cli</code> run the GitHub, GitLab and Azure CLIs where your workspaces use them, as you are signed in to them on this host (<code>gh auth login</code>, <code>glab auth login</code>, <code>az login</code>).</p>
  <p>Extension tool calls need the approval of you or a member granted host commands, unless a workspace sets an extension's tools to automatic and you let workspaces do that here.</p>
  <p>Built-in extensions come with Pikibun. Turned on, every session on this host runs with them, in every workspace; the tools they call are the session's own, decided as usual.</p>
  <p>Require an extension of every session to run it on this host whatever each workspace chose, yours included, with the settings you give it here. Guards belong here: <code>piki:prompt-audit</code>, which has a model check other members' messages before they reach the agent, or a tool-call guard such as <code>npm:cc-safety-net</code>. While this host can't run one you require, its sessions take no messages.</p>
</div>;

const BROWSER = "piki:browser";

const browserHints: Readonly<Record<HostBrowserStatus["state"], string>> = {
  ready: "Sessions in this host's sandbox can open web pages with it",
  missing: "No Chromium for it on this host: its sessions have no browser until you set one up below",
  downloading: "Downloading Chromium for it: its sessions get the browser once it is ready",
  failed: "Chromium's download failed: it is tried again in a few minutes, or set one up another way below",
  off: "Off on this host: its sessions have no browser",
  unsupported: "It runs in the Linux sandbox only, which this host's sessions don't have",
};

function BrowserBadge({ status }: { status: HostBrowserStatus }) {
  switch (status.state) {
    case "ready": return <StatusBadge tone="success">Ready</StatusBadge>;
    case "downloading": return <StatusBadge tone="neutral" dot>Downloading</StatusBadge>;
    case "missing": return <StatusBadge tone="warning">No Chromium</StatusBadge>;
    case "failed": return <StatusBadge tone="danger">Download failed</StatusBadge>;
    case "off": return <StatusBadge tone="neutral">Off</StatusBadge>;
    case "unsupported": return <StatusBadge tone="neutral">Not on this host</StatusBadge>;
  }
}

const browserSources: { value: BrowserSource; label: string; hint: string }[] = [
  { value: "auto", label: "Find it", hint: "Looks on this host: PIKIBUN_BROWSER, your distribution's chromium, Google Chrome or Chromium, then Playwright's and Puppeteer's downloads, then one downloaded here" },
  { value: "path", label: "This path", hint: "Runs the Chromium executable you name, and no other" },
  { value: "download", label: "Download", hint: "The connector downloads Chrome for Testing's headless shell (about 110 MB) into its own folder, and keeps it up to date" },
  { value: "off", label: "Off", hint: "Sessions on this host get no browser" },
];

/**
 * Where piki:browser's Chromium comes from on the host (HostConfig.browser): found there, at a path its owner gives,
 * downloaded by its connector, or none; with how it stands, as the connector last reported. Each session's sandbox gets
 * it read-only; the connector applies a change as it next reports, within a minute.
 */
function BrowserSetup({ connector, status, owner, busy, save }: { connector: ConnectorInfo; status?: HostBrowserStatus; owner: boolean; busy: boolean;
  save: (browser: HostBrowserConfig) => void }) {
  const saved = connector.config?.browser ?? defaultHostBrowserConfig;
  const [source, setSource] = useState<BrowserSource>(saved.source);
  const [path, setPath] = useState(saved.path ?? "");
  useEffect(() => { setSource(saved.source); setPath(saved.path ?? ""); }, [saved.source, saved.path]);
  const chosen = path.trim();
  const pathError = source === "path" && chosen && !chosen.startsWith("/") ? "The executable's absolute path, such as /usr/lib/chromium/chromium" : undefined;
  const changed = source !== saved.source || (source === "path" && chosen !== (saved.path ?? ""));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!changed || pathError || (source === "path" && !chosen)) return;
    save(source === "path" ? { source, path: chosen } : { source });
  }
  const current = status && status.source === saved.source ? status : undefined;
  return <CardBody><div className="stack">
    {current?.state === "ready" && <p className="small">Sessions run {current.executable ? <code>{current.executable}</code> : "the host's Chromium"}{current.version ? ` (${current.version})` : ""}, read-only in their sandbox.</p>}
    {current && current.state !== "ready" && current.state !== "off" && <Alert variant={current.state === "downloading" ? "info" : "warning"}
      title={current.state === "downloading" ? "Downloading Chromium" : current.state === "failed" ? "Chromium's download failed" : current.state === "unsupported" ? "Not on this host" : "No Chromium for the browser"}>
      {current.error ?? browserHints[current.state]}{current.state === "missing" && current.downloadable && saved.source === "path" ? ". Or have the host find one, or download one." : ""}</Alert>}
    {status && !current && <p className="muted small">The host applies your choice as it next reports, within a minute.</p>}
    {owner ? <form className="stack" onSubmit={submit}>
      <SegmentedControl label="Where the browser's Chromium comes from" value={source} onChange={setSource} options={browserSources.map(({ value, label, hint }) => ({ value, label, hint }))} />
      <p className="muted small">{browserSources.find(item => item.value === source)?.hint}{source === "download" && status && !status.downloadable
        ? ". Chrome for Testing builds it for Linux on x86-64 only: on this host, install your distribution's chromium and find it instead." : ""}</p>
      {source === "path" && <Field label="Chromium executable" error={pathError} hint="The program itself, beside Chromium's own files (icudtl.dat, its .pak files): /usr/lib/chromium/chromium rather than the /usr/bin/chromium script">
        <input className="input" required spellCheck={false} autoComplete="off" placeholder="/usr/lib/chromium/chromium" maxLength={4096} value={path} onChange={event => setPath(event.target.value)} />
      </Field>}
      <div className="inline"><span className="spacer" />
        <Button type="submit" variant="default" size="sm" disabled={!changed || busy || !!pathError || (source === "path" && !chosen) || !!connector.revokedAt}>Save</Button></div>
    </form> : <p className="muted small">Only the host's owner chooses where its Chromium comes from.</p>}
  </div></CardBody>;
}

const TUNNEL = "piki:tunnel";

const tunnelHints: Readonly<Record<HostTunnelStatus["state"], string>> = {
  ready: "Sessions in this host's sandbox can put their servers online with it, where their workspace turns the tunnel on",
  missing: "No cloudflared for it on this host: its sessions have no tunnel until you set one up below",
  downloading: "Downloading cloudflared for it: its sessions get the tunnel once it is ready",
  failed: "cloudflared's download failed: it is tried again in a few minutes, or set one up another way below",
  off: "Off on this host: its sessions put nothing online",
  unsupported: "Session services run in the Linux sandbox only, which this host's sessions don't have",
};

function TunnelBadge({ status }: { status: HostTunnelStatus }) {
  switch (status.state) {
    case "ready": return <StatusBadge tone="success">Ready</StatusBadge>;
    case "downloading": return <StatusBadge tone="neutral" dot>Downloading</StatusBadge>;
    case "missing": return <StatusBadge tone="warning">No cloudflared</StatusBadge>;
    case "failed": return <StatusBadge tone="danger">Download failed</StatusBadge>;
    case "off": return <StatusBadge tone="neutral">Off</StatusBadge>;
    case "unsupported": return <StatusBadge tone="neutral">Not on this host</StatusBadge>;
  }
}

const tunnelSourceChoices: { value: TunnelSource; label: string; hint: string }[] = [
  { value: "auto", label: "Find it", hint: "Looks on this host: PIKIBUN_CLOUDFLARED, cloudflared on the connector's PATH, /usr/local/bin and /usr/bin, Homebrew's, then one downloaded here" },
  { value: "path", label: "This path", hint: "Runs the cloudflared executable you name, and no other" },
  { value: "download", label: "Download", hint: "The connector downloads Cloudflare's latest cloudflared (about 40 MB) into its own folder, checked against its release's SHA-256, and keeps it up to date" },
  { value: "off", label: "Off", hint: "Sessions on this host put nothing online, whatever their workspace chose" },
];

/**
 * Where piki:tunnel's cloudflared comes from on the host (HostConfig.tunnel): found there, at a path its owner gives,
 * downloaded by its connector, or none, which refuses tunnels on the host. cloudflared runs in the connector, on the host,
 * never in a session's sandbox, and publishes from the host's network; each start waits for its owner's approval, or a
 * member's granted host commands.
 */
function TunnelSetup({ connector, status, owner, busy, save }: { connector: ConnectorInfo; status?: HostTunnelStatus; owner: boolean; busy: boolean;
  save: (tunnel: HostTunnelConfig) => void }) {
  const saved = connector.config?.tunnel ?? defaultHostTunnelConfig;
  const [source, setSource] = useState<TunnelSource>(saved.source);
  const [path, setPath] = useState(saved.path ?? "");
  useEffect(() => { setSource(saved.source); setPath(saved.path ?? ""); }, [saved.source, saved.path]);
  const chosen = path.trim();
  const pathError = source === "path" && chosen && !chosen.startsWith("/") ? "The executable's absolute path, such as /usr/local/bin/cloudflared" : undefined;
  const changed = source !== saved.source || (source === "path" && chosen !== (saved.path ?? ""));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!changed || pathError || (source === "path" && !chosen)) return;
    save(source === "path" ? { source, path: chosen } : { source });
  }
  const current = status && status.source === saved.source ? status : undefined;
  return <CardBody><div className="stack">
    {current?.state === "ready" && <p className="small">Tunnels run {current.executable ? <code>{current.executable}</code> : "the host's cloudflared"}{current.version ? ` (${current.version})` : ""} in this host's connector, never in a session's sandbox. It needs to reach Cloudflare's edge on port 7844.</p>}
    {current && current.state !== "ready" && current.state !== "off" && <Alert variant={current.state === "downloading" ? "info" : "warning"}
      title={current.state === "downloading" ? "Downloading cloudflared" : current.state === "failed" ? "cloudflared's download failed" : current.state === "unsupported" ? "Not on this host" : "No cloudflared for the tunnel"}>
      {current.error ?? tunnelHints[current.state]}</Alert>}
    {status && !current && <p className="muted small">The host applies your choice as it next reports, within a minute.</p>}
    {owner ? <form className="stack" onSubmit={submit}>
      <SegmentedControl label="Where the tunnel's cloudflared comes from" value={source} onChange={setSource} options={tunnelSourceChoices.map(({ value, label, hint }) => ({ value, label, hint }))} />
      <p className="muted small">{tunnelSourceChoices.find(item => item.value === source)?.hint}{source === "download" && status && !status.downloadable
        ? ". Cloudflare builds a lone cloudflared for Linux on x86-64 and ARM64 only: on this host, install its package and find it instead." : ""}</p>
      {source === "path" && <Field label="cloudflared executable" error={pathError} hint="The program itself, such as /usr/local/bin/cloudflared">
        <input className="input" required spellCheck={false} autoComplete="off" placeholder="/usr/local/bin/cloudflared" maxLength={4096} value={path} onChange={event => setPath(event.target.value)} />
      </Field>}
      <div className="inline"><span className="spacer" />
        <Button type="submit" variant="default" size="sm" disabled={!changed || busy || !!pathError || (source === "path" && !chosen) || !!connector.revokedAt}>Save</Button></div>
    </form> : <p className="muted small">Only the host's owner chooses where its cloudflared comes from, or refuses tunnels on it.</p>}
  </div></CardBody>;
}

function ModuleDetails({ extension }: { extension: InstalledExtension }) {
  if (extension.error) return <Row title="Doesn't load" hint={extension.error} trailing={<StatusBadge tone="danger">Error</StatusBadge>} />;
  return <>{extension.modules.map(module => <CardBody key={module.path}>
    <div className="stack small">
      <strong><code>{module.path}</code></strong>
      {module.error && <span>Doesn't load: {module.error}</span>}
      {!!module.tools.length && <span>Tools: {module.tools.map(tool => tool.name).join(", ")}</span>}
      {!!module.events.length && <span className="muted">Events: {module.events.join(", ")}</span>}
      {!!module.flags.length && <span className="muted">Settings: {module.flags.map(flag => flag.name).join(", ")}</span>}
      {!!module.noops.length && <span className="muted">Does nothing in Pikibun: {module.noops.join(", ")}</span>}
      {!!module.ignored.length && <span className="muted">Not supported: {module.ignored.join(", ")}</span>}
    </div>
  </CardBody>)}</>;
}

export function HostExtensionsSection({ connector, refresh }: { connector: ConnectorInfo; refresh: () => void }) {
  const path = `/api/connectors/${segment(connector.id)}/extensions`;
  const resource = useResource<HostExtensionsResponse>(path);
  const action = useAction();
  const [installing, setInstalling] = useState(false);
  const data = resource.data;
  const owner = data?.role === "owner";
  const pending = data?.requests.filter(request => request.status === "pending") ?? [];
  // While requests wait for the host, or it applies a browser choice or downloads one, look again every few seconds.
  const browser = data?.report?.browser;
  const browserChanging = !!browser && !!connector.config && (browser.source !== connector.config.browser.source || browser.state === "downloading");
  const tunnel = data?.report?.tunnel;
  const tunnelChanging = !!tunnel && !!connector.config?.tunnel && (tunnel.source !== connector.config.tunnel.source || tunnel.state === "downloading");
  useEffect(() => {
    if (!pending.length && !browserChanging && !tunnelChanging) return;
    const timer = setInterval(resource.refresh, 5000);
    return () => clearInterval(timer);
  }, [pending.length, browserChanging, tunnelChanging, resource.refresh]);

  async function request(requestAction: "install" | "remove", source: string): Promise<boolean> {
    let done = false;
    await action.run(async () => {
      await api(`${path}/requests`, { method: "POST", body: { action: requestAction, source } });
      done = true;
      resource.refresh();
    }, connector.online ? "Asked the host: it carries this out within half a minute." : "Asked the host: it carries this out once it is online.");
    return done;
  }
  function remove(source: string) {
    void (async () => {
      if (!await confirmDialog({ title: "Remove this extension from the host?", message: <>Sessions on this host stop running <code>{source}</code> once it is removed, in every workspace that uses it.</>, confirmLabel: "Remove", destructive: true })) return;
      await request("remove", source);
    })();
  }
  function setAutomatic(automaticTools: boolean) {
    void action.run(async () => {
      await api(path, { method: "PATCH", body: { automaticTools } });
      resource.refresh();
    }, automaticTools ? "Workspaces may now run extension tools without approval on this host, where they set them to automatic." : "Extension tools on this host need approval again.");
  }
  const builtin = connector.config?.builtinExtensions ?? [];
  function setBuiltin(name: BuiltinExtensionName, on: boolean) {
    const next = builtinExtensions.map(item => item.name).filter(item => item === name ? on : builtin.includes(item));
    const item = builtinExtensions.find(candidate => candidate.name === name);
    const title = item?.title ?? name;
    // A core one runs whatever is ticked on connectors of this release: the box only decides it on older ones.
    const core = !!item && "core" in item && item.core === true;
    void action.run(async () => {
      await api(`/api/connectors/${segment(connector.id)}/config`, { method: "PATCH", body: { builtinExtensions: next } });
      refresh();
    }, core
      ? on ? `${title} is on for older connectors too. Connectors of this release or later always run it.` : `${title} is off for older connectors only. Connectors of this release or later always run it.`
      : on ? `${title} is on: sessions on this host get it with their next message, within a minute.` : `${title} is off: sessions on this host run without it from their next message, within a minute.`);
  }
  const required = connector.config?.requiredExtensions ?? [];
  const [configuring, setConfiguring] = useState<{ extension: RequiredExtension; flags: InstalledExtension["modules"][number]["flags"] } | null>(null);
  /** Saves the extensions the host requires; true once saved. */
  function saveBrowser(browser: HostBrowserConfig) {
    void action.run(async () => {
      await api(`/api/connectors/${segment(connector.id)}/config`, { method: "PATCH", body: { browser } });
      refresh();
      // The connector applies it as it next reports, within a minute: the section looks again until it has.
      setTimeout(resource.refresh, 35_000);
    }, browser.source === "download" ? "Saved: the host starts downloading Chromium within a minute, and keeps it up to date" : "Saved: the host applies it within a minute");
  }

  function saveTunnel(tunnel: HostTunnelConfig) {
    void action.run(async () => {
      await api(`/api/connectors/${segment(connector.id)}/config`, { method: "PATCH", body: { tunnel } });
      refresh();
      setTimeout(resource.refresh, 35_000);
    }, tunnel.source === "download" ? "Saved: the host starts downloading cloudflared within a minute, and keeps it up to date"
      : tunnel.source === "off" ? "Saved: the host refuses tunnels within a minute; one online now stays until it stops" : "Saved: the host applies it within a minute");
  }

  async function saveRequired(next: RequiredExtension[], notice: string): Promise<boolean> {
    let done = false;
    await action.run(async () => {
      await api(`/api/connectors/${segment(connector.id)}/config`, { method: "PATCH", body: { requiredExtensions: next } });
      done = true;
      refresh();
    }, notice);
    return done;
  }
  function setRequired(extension: InstalledExtension, on: boolean) {
    void (async () => {
      const name = pikiExtension(extension.source)?.title ?? extension.source;
      if (on && !await confirmDialog({ title: `Require ${name} of every session?`,
        message: <>Every session on {connector.name} will run <code>{extension.source}</code>, yours included, in every workspace, whatever the workspace chose. It runs in this host's connector, as your OS user. Its settings are yours to set here.</>,
        confirmLabel: "Require" })) return;
      const next = on ? [...required, { source: extension.source, settings: {} }] : required.filter(item => item.source !== extension.source);
      const saved = await saveRequired(next, on ? `Every session on this host runs ${name} from its next message, within a minute.` : `${name} is no longer required: sessions run it only where their workspace chose it.`);
      // Its settings, once it is required: not when the save failed.
      if (saved && on && extension.modules.some(module => module.flags.length)) setConfiguring({ extension: { source: extension.source, settings: {} }, flags: extension.modules.flatMap(module => module.flags) });
    })();
  }
  const isRequired = (source: string) => required.some(item => item.source === source);
  const installedSources = new Set(data?.report?.installed.map(item => item.source) ?? []);
  const unavailable = data?.report ? missingRequiredExtensions(required, data.report.installed)
    .flatMap(source => required.filter(item => item.source === source)) : [];
  const missing = (data?.workspaces ?? []).flatMap(workspace => workspace.extensions.filter(item => item.availability.status !== "installed").map(item => ({ workspace, ...item })));
  const waiting = (source: string) => pending.some(item => item.source === source);
  return <Section title="Extensions" bare info={info} action={owner && data?.report?.remoteInstalls !== false
    ? <Button variant="outline" size="sm" icon="plus" disabled={!!connector.revokedAt} onClick={() => setInstalling(true)}>Install extension</Button> : undefined}>
    <ResourceState loading={resource.loading && !data} error={resource.error} retry={resource.refresh}>
      {data && <div className="card">
        {connector.config && builtinExtensions.map(item => <Row key={`builtin ${item.name}`} leading={<Icon name="tool" size={16} />}
          title={<>{item.title} <code>{item.name}</code></>}
          hint={connector.capabilities.builtinExtensions ? `${item.description} Tools: ${item.tools.join(", ")}${"core" in item && item.core
            ? ". Always on with connectors of this release or later; older ones run it only where it's ticked here." : ""}`
            : "This host's connector predates built-in extensions: its sessions run without them until it is updated (npx pikibun@latest connect)"}
          trailing={<label className="check-row small"><input type="checkbox" className="checkbox" aria-label={"core" in item && item.core ? `Run ${item.title} on this host's older connectors too` : `Run ${item.title} in every session on this host`}
            checked={builtin.includes(item.name)} disabled={action.busy || !!connector.revokedAt} onChange={event => setBuiltin(item.name, event.target.checked)} />
            <span>{"core" in item && item.core ? "Older connectors too" : "Every session"}</span></label>} />)}
        {!connector.capabilities.extensions && <Row title="Update the host's connector" hint="This host's connector predates extensions: its sessions run none until it is updated (npx pikibun@latest connect)." />}
        {connector.capabilities.extensions && !data.report && <Row title="Not reported yet" hint="The host reports its extensions once its connector is online" />}
        {data.report && !data.report.remoteInstalls && <Row title="Installs from Pikibun are off" hint="Its connector runs with --no-remote-installs: install extensions on the host with pikibun extensions" />}
        {data.report && !data.report.installed.length && <Row title="No extensions installed" hint="Install those your workspaces use, below" />}
        {data.report?.installed.map(extension => <Collapsible key={extension.source} leading={<Icon name="tool" size={16} />} title={<code>{extension.source}</code>}
          hint={extension.source === BROWSER && data.report?.browser ? browserHints[data.report.browser.state]
            : extension.source === TUNNEL && data.report?.tunnel ? tunnelHints[data.report.tunnel.state]
            : extension.dev ? "Dev extension: your own sessions on this host" : extension.description ?? `${extension.modules.flatMap(module => module.tools).length} tools`}
          trailing={extension.error || extension.modules.some(module => module.error) ? <StatusBadge tone="danger">Error</StatusBadge>
            : extension.source === BROWSER && data.report?.browser ? <BrowserBadge status={data.report.browser} />
            : extension.source === TUNNEL && data.report?.tunnel ? <TunnelBadge status={data.report.tunnel} />
            : extension.dev ? <StatusBadge tone="warning">Dev</StatusBadge> : isPikiExtensionSource(extension.source) ? <StatusBadge tone="neutral">With the connector</StatusBadge>
            : waiting(extension.source) ? <StatusBadge tone="neutral" dot>Removing</StatusBadge> : <StatusBadge tone="success">Installed</StatusBadge>}>
          {extension.source === BROWSER && connector.config && <BrowserSetup connector={connector} status={data.report?.browser} owner={owner} busy={action.busy} save={saveBrowser} />}
          {extension.source === TUNNEL && connector.config && <TunnelSetup connector={connector} status={data.report?.tunnel} owner={owner} busy={action.busy} save={saveTunnel} />}
          <ModuleDetails extension={extension} />
          {!extension.dev && !extension.error && !pikiExtension(extension.source)?.sessionTools && (owner || isRequired(extension.source)) && <CardBody><div className="inline">
            {owner ? <label className="check-row small"><input type="checkbox" className="checkbox" checked={isRequired(extension.source)}
              disabled={action.busy || !!connector.revokedAt || (!isRequired(extension.source) && required.length >= hostConfigLimits.requiredExtensions)}
              onChange={event => setRequired(extension, event.target.checked)} /><span>Require of every session</span></label>
              : <StatusBadge tone="success">Required of every session</StatusBadge>}
            {owner && isRequired(extension.source) && extension.modules.some(module => module.flags.length) && <Button variant="outline" size="sm" icon="pencil" disabled={action.busy}
              onClick={() => setConfiguring({ extension: required.find(item => item.source === extension.source)!, flags: extension.modules.flatMap(module => module.flags) })}>Settings</Button>}
            <span className="spacer" />
            {owner && !isPikiExtensionSource(extension.source) && data.report?.remoteInstalls && <Button variant="ghost" size="sm" icon="trash"
              disabled={action.busy || waiting(extension.source)} onClick={() => remove(extension.source)}>Remove</Button>}
          </div></CardBody>}
        </Collapsible>)}
        {connector.capabilities.extensions && !connector.capabilities.requiredExtensions && !!required.length && <Row leading={<Icon name="alert" size={16} />}
          title="Update the host's connector" hint="This host's connector predates required extensions: its sessions run only what their workspace chose, and messages go unaudited, until it is updated (npx pikibun@latest connect)" />}
        {unavailable.map(item => <Row key={`required ${item.source}`} leading={<Icon name="alert" size={16} />} title={<code>{item.source}</code>}
          hint={isPikiExtensionSource(item.source) ? "Required of every session, but this host's connector doesn't have it: no session here takes messages until the connector is updated (npx pikibun@latest connect), or you stop requiring it"
            : installedSources.has(item.source) ? "Required of every session, but it doesn't load here: no session takes messages until it does, or you stop requiring it"
            : "Required of every session, but not installed here: no session takes messages until it is, or you stop requiring it"}
          trailing={<span className="inline">
            {owner && !isPikiExtensionSource(item.source) && !installedSources.has(item.source) && data.report?.remoteInstalls && (waiting(item.source)
              ? <StatusBadge tone="neutral" dot>Installing</StatusBadge>
              : <Button variant="outline" size="sm" disabled={action.busy || !!connector.revokedAt} onClick={() => void request("install", item.source)}>Install</Button>)}
            {owner ? <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => void saveRequired(required.filter(other => other.source !== item.source), "No longer required.")}>Stop requiring</Button>
              : <StatusBadge tone="danger">Missing</StatusBadge>}
          </span>} />)}
        {missing.map(item => <Row key={`${item.workspace.id} ${item.source}`} leading={<Icon name="alert" size={16} />} title={<code>{item.source}</code>}
          hint={isPikiExtensionSource(item.source) ? `${item.workspace.name} uses it, which comes with newer connectors. Its sessions here run without it until this host's connector is updated (npx pikibun@latest connect)`
            : `${item.workspace.name} uses it${item.availability.status === "other-version" ? `; this host has ${item.availability.installed}` : "; this host doesn't have it"}. Its sessions here run without it`}
          trailing={isPikiExtensionSource(item.source) ? <StatusBadge tone="warning">Update the connector</StatusBadge>
            : waiting(item.source) ? <StatusBadge tone="neutral" dot>Installing</StatusBadge>
            : owner && data.report?.remoteInstalls !== false ? <Button variant="outline" size="sm" disabled={action.busy || !!connector.revokedAt}
              onClick={() => void request("install", item.source)}>{item.availability.status === "other-version" ? "Update" : "Install"}</Button>
            : <StatusBadge tone="neutral">Missing</StatusBadge>} />)}
        {owner && <Row title="Let workspaces run extension tools without approval" hint="Only where a workspace sets an extension's tools to automatic. Off: each call waits for you, or a member granted host commands"
          trailing={<input type="checkbox" className="checkbox" aria-label="Let workspaces run extension tools without approval" checked={data.automaticTools} disabled={action.busy}
            onChange={event => setAutomatic(event.target.checked)} />} />}
        {!owner && <Row title="Extension tools without approval" trailing={<StatusBadge tone={data.automaticTools ? "warning" : "neutral"}>{data.automaticTools ? "Allowed" : "Off"}</StatusBadge>} />}
        {!!data.requests.length && <Collapsible title="Recent requests" hint={pending.length ? `${pending.length} waiting for the host` : "Installs and removals asked for here"}>
          {data.requests.map(item => <Row key={item.id} title={<><span className="muted">{item.action === "install" ? "Install" : "Remove"}</span> <code>{item.source}</code></>}
            hint={item.error ?? <RelativeTime value={item.finishedAt ?? item.requestedAt} />}
            trailing={<StatusBadge tone={item.status === "done" ? "success" : item.status === "failed" ? "danger" : "neutral"} dot={item.status === "pending"}>
              {item.status === "pending" ? "Waiting" : item.status === "done" ? "Done" : "Failed"}</StatusBadge>} />)}
        </Collapsible>}
        {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
      </div>}
    </ResourceState>
    {installing && <InstallSheet close={() => setInstalling(false)} busy={action.busy} error={action.error}
      install={async source => { if (await request("install", source)) setInstalling(false); }} />}
    {configuring && <RequiredSettingsSheet extension={configuring.extension} flags={configuring.flags} busy={action.busy} error={action.error} close={() => setConfiguring(null)}
      save={async settings => {
        const next = required.map(item => item.source === configuring.extension.source ? { ...item, settings } : item);
        if (await saveRequired(next, "Settings saved. Sessions on this host use them from their next message, within a minute.")) setConfiguring(null);
      }} />}
  </Section>;
}

/** The settings a required extension runs with on this host: the host owner's, not any workspace's. */
function RequiredSettingsSheet({ extension, flags, close, save, busy, error }: { extension: RequiredExtension; flags: InstalledExtension["modules"][number]["flags"];
  close: () => void; save: (settings: ExtensionSettings) => Promise<void>; busy: boolean; error: string }) {
  const [settings, setSettings] = useState<ExtensionSettings>(extension.settings);
  const piki = pikiExtension(extension.source);
  function submit(event: FormEvent) {
    event.preventDefault();
    void save(settings);
  }
  return <Sheet open title={`${piki?.title ?? extension.source} settings`} onClose={() => { if (!busy) close(); }} footer={<>
    <Button disabled={busy} onClick={close}>Cancel</Button>
    <Button variant="default" type="submit" form="required-extension-form" disabled={busy}>{busy ? "Saving..." : "Save"}</Button>
  </>}>
    <form id="required-extension-form" className="stack" onSubmit={submit}>
      {piki && <p className="muted small">{piki.description}</p>}
      <ExtensionSettingsFields flags={flags} settings={settings} onChange={setSettings} busy={busy} multiline={["policy"]} />
      <p className="muted small">Every session on this host runs it with these settings, whatever its workspace set. Never put secrets here: they are in the host's audit log, which its admins can read.</p>
      <Feedback error={error} />
    </form>
  </Sheet>;
}

function InstallSheet({ close, install, busy, error }: { close: () => void; install: (source: string) => Promise<void>; busy: boolean; error: string }) {
  const [source, setSource] = useState("");
  let normalized: string | undefined;
  let invalid = "";
  try { normalized = source.trim() ? normalizeExtensionSource(source.trim()) : undefined; }
  catch (reason) { invalid = reason instanceof Error ? reason.message : "Invalid source"; }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (normalized) void install(normalized);
  }
  return <Sheet open title="Install extension" onClose={() => { if (!busy) close(); }} footer={<>
    <Button disabled={busy} onClick={close}>Cancel</Button>
    <Button variant="default" type="submit" form="install-extension-form" disabled={busy || !normalized}>{busy ? "Asking..." : "Install"}</Button>
  </>}>
    <form id="install-extension-form" className="stack" onSubmit={submit}>
      <Alert variant="warning" title="Runs on your machine">An extension runs in this host's connector, as your OS user, with your files, credentials and network. Install only code you trust. npm runs none of its install scripts.</Alert>
      <Field label="Source" hint="npm:<package>@<exact version>, or git:<https URL>@<full commit>" error={invalid}>
        <input className="input mono" value={source} onChange={event => setSource(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} maxLength={512}
          placeholder="npm:cc-safety-net@2.7.2" autoFocus />
      </Field>
      <Feedback error={error} />
    </form>
  </Sheet>;
}
