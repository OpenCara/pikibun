import { useEffect, useState, type FormEvent } from "react";
import type { ConnectorPairing } from "../../../../packages/shared/src/connector";
import { api } from "../api";
import { listedPrerequisites } from "../../../../packages/shared/src/host-prerequisites";
import { check, useDesktop, type DesktopBridge, type DesktopView } from "../desktop";
import { Alert, Button, CardBody, Collapsible, CopyField, EmptyState, Feedback, Field, Loading, Row, Section, SegmentedControl, StatusBadge, useAction, type Tone } from "../ui";
import "./settings.css";

// Settings › This Mac: the Pikibun desktop app's own settings, in the server's Settings page. Everything goes through
// window.pikibunDesktop (desktop.ts); the app asks in its own dialogs before changes to which servers this computer
// serves or runs, and takes secrets only in its own Settings window.

type HostView = DesktopView["hosts"]["connections"][number];
type Shared = NonNullable<NonNullable<DesktopView["local"]["inspection"]>["shared"]>;

const hostStates: Record<HostView["state"], string> = {
  stopped: "Stopped", starting: "Starting", connecting: "Connecting", connected: "Online", disconnected: "Reconnecting", stopping: "Stopping",
};
const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };

function hostBadge(view: HostView) {
  const failed = view.error && view.state === "stopped";
  const tone: Tone = view.state === "connected" ? "success" : failed ? "danger" : view.state === "stopped" ? "neutral" : "warning";
  return <StatusBadge tone={tone} dot={view.state === "connected"}>{failed ? "Stopped (error)" : hostStates[view.state]}</StatusBadge>;
}

function isolation(view: HostView): string {
  const inspection = view.inspection;
  if (inspection?.unsupported) return inspection.unsupported;
  const mode = view.running ? (view.running.unsandboxed ? "unsandboxed" : "sandboxed") : inspection?.mode;
  const sandbox = view.running ? view.running.sandbox : inspection?.sandbox;
  const wsl = view.windows?.sandbox === "wsl2";
  if (mode === "sandboxed") {
    return sandbox === "windows" ? "Sandboxed (Windows process containers, experimental)" : sandbox === "seatbelt" ? "Sandboxed (macOS Seatbelt, experimental)"
      : wsl ? "Sandboxed (bubblewrap in WSL2)" : "Sandboxed (bubblewrap)";
  }
  return mode === "unsandboxed" ? `Unsandboxed${wsl ? " in WSL2" : ""}, after your consent in the app` : "Checking...";
}

/**
 * Where a host's sessions run. Windows: WSL2 (in which distribution) or native Windows. The app asks the owner before
 * it changes, and only while the host is stopped. Absent from apps that predate the choice.
 */
function SandboxField({ connection, view, bridge }: { connection: HostView; view: DesktopView; bridge: DesktopBridge }) {
  return connection.mac ? <MacSandboxField connection={connection} bridge={bridge} /> : <WindowsSandboxField connection={connection} view={view} bridge={bridge} />;
}

/**
 * macOS: whether a host's sessions run in macOS's own sandbox (experimental) or without one. The app asks the owner
 * before it changes, and only while the host is stopped. Absent from apps that predate the choice.
 */
function MacSandboxField({ connection, bridge }: { connection: HostView; bridge: DesktopBridge }) {
  const action = useAction();
  const choice = connection.mac;
  const setSandbox = bridge.host.setSandbox;
  if (!choice || !setSandbox) return null;
  const stopped = connection.state === "stopped";
  const change = (sandbox: "seatbelt" | "none") => {
    if (!stopped || action.busy || sandbox === choice.sandbox) return;
    void action.run(() => check(setSandbox(connection.id, { sandbox })));
  };
  return <Field label="Sandbox" hint={choice.sandbox === "seatbelt"
    ? "Sessions run in macOS's own Seatbelt sandbox, which is experimental (macOS 15 or later with the developer tools: xcode-select --install), or without one, after your consent, while it isn't ready. Each session sees only its own files and reaches the network only through its egress proxy. macOS can't limit a session's memory or processes, so shell commands run only in your own sessions on this host."
    : "Sessions run directly as you on this Mac, after your consent in the app at each start: approved commands can read and change anything you can. Choose macOS sandbox to isolate them."}>
    <div className="stack">
      <fieldset className="stack" disabled={action.busy || !stopped}>
        <SegmentedControl label="Sandbox" value={choice.sandbox} onChange={change}
          options={[{ value: "none", label: "None", hint: "Unsandboxed, after your consent" }, { value: "seatbelt", label: "macOS sandbox", hint: "Seatbelt (experimental)" }]} />
      </fieldset>
      {!stopped && <span className="small muted">Stop the host to change where its sessions run.</span>}
      <Feedback {...action} />
    </div>
  </Field>;
}

function WindowsSandboxField({ connection, view, bridge }: { connection: HostView; view: DesktopView; bridge: DesktopBridge }) {
  const action = useAction();
  const choice = connection.windows;
  const setSandbox = bridge.host.setSandbox;
  if (!choice || !setSandbox) return null;
  const stopped = connection.state === "stopped";
  const distros = view.hosts.wsl?.distros ?? [];
  const fallback = distros.find(distro => distro.default && distro.version === 2) ?? distros.find(distro => distro.version === 2);
  const chosen = choice.sandbox === "wsl2" ? choice.distro : undefined;
  // Only while the host is stopped, as the app requires: a running host's buttons ask nothing.
  const change = (next: { sandbox: "wsl2"; distro?: string } | { sandbox: "native" }) => {
    if (!stopped || action.busy) return;
    void action.run(() => check(setSandbox(connection.id, next)));
  };
  return <Field label="Sandbox" hint={choice.sandbox === "wsl2"
    ? "Sessions run in WSL2's bubblewrap sandbox, with Node.js, Pi's models and the host's pairing inside that distribution, as `pikibun connect` run there does."
    : "Sessions run in Windows' own sandbox, which is experimental (Windows 11 24H2 or later with the October 2026 update, Git for Windows, busybox-w32, Node.js 24 or newer and Microsoft's MXC SDK), or without one, after your consent, while it isn't ready. Pi's models and the host's pairing are your Windows profile's."}>
    <div className="stack">
      <fieldset className="stack" disabled={action.busy || !stopped}>
        <SegmentedControl label="Sandbox" value={choice.sandbox} onChange={sandbox => change(sandbox === "native" ? { sandbox: "native" } : { sandbox: "wsl2" })}
          options={[{ value: "wsl2", label: "WSL2", hint: "bubblewrap in a WSL2 distribution" }, { value: "native", label: "Native Windows", hint: "Windows' own sandbox (experimental)" }]} />
      </fieldset>
      {choice.sandbox === "wsl2" && <select className="select" aria-label="WSL distribution" value={chosen ?? ""} disabled={action.busy || !stopped}
        onChange={event => change(event.target.value ? { sandbox: "wsl2", distro: event.target.value } : { sandbox: "wsl2" })}>
        <option value="">{fallback ? `WSL's default (${fallback.name})` : "WSL's default"}</option>
        {distros.map(distro => <option key={distro.name} value={distro.name} disabled={distro.version !== 2}>{distro.name}{distro.version === 2 ? "" : " (WSL 1: no sandbox)"}</option>)}
        {chosen && !distros.some(distro => distro.name === chosen) && <option value={chosen} disabled>{chosen} (not found)</option>}
      </select>}
      {!stopped && <span className="small muted">Stop the host to change where its sessions run.</span>}
      <Feedback {...action} />
    </div>
  </Field>;
}

export function DesktopSettings() {
  const { bridge, view, error } = useDesktop();
  if (!bridge) return <EmptyState title="Only in the Pikibun app">Open Pikibun in its desktop app to run sessions on this computer, connect it to several servers, or run Pikibun itself here.</EmptyState>;
  if (!view) return error ? <Alert variant="error" title="App settings unavailable">{error}</Alert> : <Loading />;
  return <>
    <ThisServerSection view={view} bridge={bridge} />
    <ServersSection view={view} bridge={bridge} />
    <LocalServerSection view={view} bridge={bridge} />
    <AppSection view={view} bridge={bridge} />
  </>;
}

/** This computer as a host of this very server: paired in one step, with a pairing this page makes for you. */
function ThisServerSection({ view, bridge }: { view: DesktopView; bridge: DesktopBridge }) {
  const here = view.hosts.connections.find(entry => entry.id === view.connectionHere);
  const [name, setName] = useState(view.title === "This Mac" ? "My Mac" : "My computer");
  const action = useAction();
  const server = hostOf(view.origin);
  if (view.local.status.origin === view.origin) {
    return <Section title={`${view.title} and ${server}`}>
      <Row title="Pikibun runs on this computer" hint={`It becomes its own host once you have signed in: no pairing needed. Sessions: ${view.local.status.host}.`} />
    </Section>;
  }
  const paired = here?.inspection?.pairedServer === view.origin;
  const otherPairing = here?.inspection && !paired && (here.inspection.pairedServer || here.inspection.pairingError);
  function pair(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const { pairing } = await api<{ pairing: ConnectorPairing }>("/api/connectors/pairings", { method: "POST", body: { name: name.trim() } });
      // The code goes straight to the app, which hands it to this computer's host and keeps it nowhere.
      await check(bridge.host.pairHere({ id: pairing.id, code: pairing.code }, Boolean(otherPairing)));
    }, `${view.title} is pairing with ${server}. It appears under Hosts once it is online.`);
  }
  return <Section title={`${view.title} and ${server}`} info={`${view.title} runs sessions for this server as one of your hosts, as \`pikibun connect\` does. Its other servers are below.`}>
    {here && paired ? <>
      <Row title={`${view.title} is a host of ${server}`} hint={isolation(here)} trailing={hostBadge(here)} />
      <CardBody>
        {here.error && <Alert variant="error" title="The host stopped">{here.error}</Alert>}
        <div className="inline">
          {here.state === "stopped"
            ? <Button variant="default" disabled={action.busy} onClick={() => void action.run(() => check(bridge.host.start(here.id)))}>Start host</Button>
            : <Button variant="outline" disabled={action.busy || here.state === "stopping"} onClick={() => void action.run(() => check(bridge.host.stop(here.id)))}>Stop host</Button>}
        </div>
        <Feedback {...action} />
      </CardBody>
    </> : <form onSubmit={pair}>
      <CardBody>
        <span className="small muted">{otherPairing
          ? `${view.title}'s connection to this server is paired elsewhere (${here?.inspection?.pairedServer ?? "an unreadable pairing"}). Pairing again replaces it; the old host stays in that Pikibun, offline, until you remove it there.`
          : `Pair ${view.title} with ${server} as your host in one step: no code to copy.${here ? "" : " The app asks before it adds this server to its list."}`}</span>
        {here && <SandboxField connection={here} view={view} bridge={bridge} />}
        <Field label="Host name"><input className="input" required maxLength={120} autoComplete="off" value={name} onChange={event => setName(event.target.value)} /></Field>
        <div className="inline"><Button type="submit" variant="default" disabled={action.busy || !name.trim()}>{action.busy ? "Pairing..." : `Pair ${view.title}`}</Button></div>
        <Feedback {...action} />
      </CardBody>
    </form>}
  </Section>;
}

function ServersSection({ view, bridge }: { view: DesktopView; bridge: DesktopBridge }) {
  const [server, setServer] = useState("");
  const action = useAction();
  function add(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => { await check(bridge.host.add(server)); setServer(""); }, `Added. Pair it from that server's Settings, or in the app's ${view.title} window.`);
  }
  return <Section title="Servers" info={`${view.title} can run sessions for several Pikibun servers at once, each with its own pairing and host, as one \`pikibun connect\` per server would. The primary server is the one the Pikibun window opens.`}>
    {view.hosts.connections.map(connection => <ConnectionRow key={connection.id} connection={connection} view={view} bridge={bridge} />)}
    <form onSubmit={add}>
      <CardBody>
        <Field label="Add a server" hint="HTTPS; plain HTTP only for localhost and 127.0.0.1.">
          <input className="input" type="url" required autoComplete="off" spellCheck={false} placeholder="https://pikibun.example.com" value={server} onChange={event => setServer(event.target.value)} />
        </Field>
        <div className="inline"><Button type="submit" variant="outline" icon="plus" disabled={action.busy || !server.trim()}>Add server</Button></div>
        <Feedback {...action} />
      </CardBody>
    </form>
  </Section>;
}

function ConnectionRow({ connection, view, bridge }: { connection: HostView; view: DesktopView; bridge: DesktopBridge }) {
  const action = useAction();
  const inspection = connection.inspection;
  const available = inspection?.models ?? [];
  const key = (model: { provider: string; modelId: string }) => `${model.provider}/${model.modelId}`;
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const chosen = checked ?? new Set(connection.models ? connection.models.map(key) : available.map(key));
  const here = connection.server === view.origin;
  const run = (work: () => Promise<unknown>, notice?: string) => void action.run(async () => { await check(work() as Promise<void>); }, notice);
  return <Collapsible title={<>{hostOf(connection.server)}{connection.primary && <span className="muted"> · primary</span>}{here && <span className="muted"> · this server</span>}</>}
    hint={inspection ? inspection.pairedServer ? `Paired · ${isolation(connection)}` : inspection.pairingError ?? "Not paired yet" : connection.server}
    trailing={hostBadge(connection)}>
    <div className="stack">
      {connection.error && <Alert variant="error" title="The host stopped">{connection.error}</Alert>}
      <Field label="Server"><span>{connection.server}</span></Field>
      {inspection?.stateDir && <Field label="State directory"><span className="small">{inspection.stateDir}</span></Field>}
      <SandboxField connection={connection} view={view} bridge={bridge} />
      <Field label="The same connection in a terminal"><CopyField value={connection.command} label="Copy command" /></Field>
      <div className="inline">
        {connection.state === "stopped"
          ? <Button variant="default" size="sm" disabled={action.busy || !inspection?.pairedServer} onClick={() => run(() => bridge.host.start(connection.id))}>Start host</Button>
          : <Button variant="outline" size="sm" disabled={action.busy || connection.state === "stopping"} onClick={() => run(() => bridge.host.stop(connection.id))}>Stop host</Button>}
        {!here && <Button variant="outline" size="sm" icon="external" onClick={() => run(() => bridge.host.open(connection.id))}>Open</Button>}
        <Button variant="ghost" size="sm" icon="refresh" disabled={connection.inspecting} onClick={() => run(() => bridge.host.refresh(connection.id))}>Refresh</Button>
        {!connection.primary && <Button variant="ghost" size="sm" icon="trash" disabled={action.busy} onClick={() => run(() => bridge.host.remove(connection.id))}>Remove</Button>}
      </div>
      {!inspection?.pairedServer && !here && <span className="small muted">Pair it from {hostOf(connection.server)}'s own Settings › {view.title} (Open, then Settings), or with a pairing code in the app's {view.title} window.</span>}
      {available.length > 0 && <Field label="Models offered" hint={connection.models ? "Only the checked models; a change applies from the host's next start." : "Pi chooses: its enabledModels setting, or every model with configured authentication. Uncheck some to offer only the rest."}>
        <div className="stack">
          {available.map(model => <label key={key(model)} className="check-row">
            <input type="checkbox" className="checkbox" checked={chosen.has(key(model))} disabled={action.busy} onChange={event => {
              const next = new Set(chosen);
              if (event.target.checked) next.add(key(model)); else next.delete(key(model));
              setChecked(next);
            }} />
            <span>{model.name} <span className="small muted">{key(model)}</span></span>
          </label>)}
          <div className="inline">
            <Button variant="outline" size="sm" disabled={action.busy || !checked} onClick={() => run(async () => {
              await check(bridge.host.setModels(connection.id, available.filter(model => chosen.has(key(model))).map(model => ({ provider: model.provider, modelId: model.modelId }))));
              setChecked(null);
            }, "Saved: the host offers these from its next start.")}>Offer checked models</Button>
            {connection.models && <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => run(async () => { await check(bridge.host.setModels(connection.id, null)); setChecked(null); })}>Let Pi choose</Button>}
          </div>
        </div>
      </Field>}
      <SetupAlert connection={connection} view={view} bridge={bridge} />
      {connection.logs.length > 0 && <Collapsible plain title="Recent activity">
        <ol className="small mono desktop-logs">{connection.logs.slice(-30).reverse().map((line, index) => <li key={index} className={line.level === "error" ? "danger" : line.level === "warning" ? "muted" : undefined}>
          {new Date(line.time).toLocaleTimeString()} {line.message}
        </li>)}</ol>
      </Collapsible>}
      <Feedback {...action} />
    </div>
  </Collapsible>;
}

/**
 * What this computer lacks to host, with what to do about each. Installing and signing Pi in happen in the app's own
 * window (it starts installers and takes API keys, which a web page never does), so this links there.
 */
function SetupAlert({ connection, view, bridge }: { connection: HostView; view: DesktopView; bridge: DesktopBridge }) {
  const inspection = connection.inspection;
  if (!inspection) return null;
  // What the sandbox lacks too, where the host would run without it until then: those are what to install.
  // Optional ones (npm, for extensions) don't keep this computer from hosting: the app's window lists them.
  const missing = listedPrerequisites(inspection).map(item => item.entry).filter(item => !item.ok && !item.optional);
  const fixes = [...new Map(missing.flatMap(item => item.fix ? [[JSON.stringify(item.fix), item.fix] as const] : [])).values()];
  if (inspection.unsupportedFix) fixes.unshift(inspection.unsupportedFix);
  const noModels = !inspection.unsupported && !inspection.models.length && inspection.modelsError;
  if (!missing.length && !inspection.prerequisitesError && !inspection.unsupportedFix && !noModels) return null;
  return <Alert variant="warning" title={`Set up ${view.title === "This Mac" ? "this Mac" : "this computer"} to host`}>
    <div className="stack">
      {inspection.prerequisitesError && <span>{inspection.prerequisitesError}</span>}
      {fixes.map(fix => <span key={fix.text}>{fix.text}{fix.command && <> <code>{fix.command}</code></>}</span>)}
      {noModels && <span>{inspection.modelsError} Sign Pi in to your provider in the {view.title} window: no separate Pi install is needed.</span>}
      <div className="inline">
        <Button size="sm" variant="outline" onClick={() => void bridge.openWindow("host")}>{fixes.some(fix => fix.action) || noModels ? `Set up in ${view.title}…` : `Open ${view.title}…`}</Button>
      </div>
    </div>
  </Alert>;
}

const emptyShared: Shared = { origin: "", listen: "loopback", trustProxy: true, signup: "invite", passwordAuth: true, admins: [] };

function LocalServerSection({ view, bridge }: { view: DesktopView; bridge: DesktopBridge }) {
  const { status, inspection, error, notice } = view.local;
  const running = status.state !== "stopped";
  const [mode, setMode] = useState<"local" | "shared">(view.local.mode);
  const [shared, setShared] = useState<Shared>(inspection?.shared ?? emptyShared);
  const [admins, setAdmins] = useState((inspection?.shared?.admins ?? []).join("\n"));
  const [filled, setFilled] = useState(Boolean(inspection));
  const action = useAction();
  // Filled from the saved settings once they arrive; then the form is the owner's.
  useEffect(() => {
    if (filled || !inspection) return;
    setFilled(true);
    if (inspection.shared) { setShared(inspection.shared); setAdmins(inspection.shared.admins.join("\n")); }
  }, [filled, inspection]);
  const current = running && status.mode ? status.mode : mode;
  const label = status.state === "running" ? (status.mode === "shared" ? "Shared" : "Running") : status.state === "stopped" ? "Off" : status.state === "starting" ? "Starting" : "Stopping";
  const githubMissing = current === "local" ? !inspection?.githubClientId : !inspection?.shared?.githubClientId && !shared.passwordAuth;
  function start(event: FormEvent) {
    event.preventDefault();
    void action.run(() => check(bridge.local.start(current === "local" ? { mode: "local" } : {
      mode: "shared", shared: { origin: shared.origin.trim().replace(/\/+$/, ""), listen: shared.listen, trustProxy: shared.trustProxy, signup: shared.signup,
        passwordAuth: shared.passwordAuth, admins: admins.split(/[\n,]/).map(item => item.trim()).filter(Boolean) },
    })));
  }
  const set = (change: Partial<Shared>) => setShared(value => ({ ...value, ...change }));
  return <Section title="Pikibun on this computer" info="Pikibun itself, run by the app as `pikibun serve` does and from the same data: just for you on this computer, or shared with others at a public HTTPS address, as `pikibun serve --share`."
    action={<StatusBadge tone={status.state === "running" ? "success" : "neutral"} dot={status.state === "running"}>{label}</StatusBadge>}>
    <form onSubmit={start}>
      <CardBody>
        <SegmentedControl label="Who uses it" value={current} onChange={value => { if (!running) setMode(value); }} options={[
          { value: "local", label: "Just for me", icon: "user" },
          { value: "shared", label: "Share with others", icon: "users" },
        ]} />
        {running && <>
          <Field label="Address"><span>{status.origin}</span></Field>
          {status.address && <Field label="Listens on" hint={status.mode === "shared" ? "Your TLS proxy or tunnel forwards the public address here." : undefined}><span>{status.address}</span></Field>}
          <Field label="Sessions"><span>{status.host === "connected" ? "Run on this computer" : status.host === "waiting" ? "On this computer, once you have signed in" : status.host === "off" ? "Not on this computer" : status.host}</span></Field>
        </>}
        {current === "local" && !running && <span className="small muted">Only this computer can reach it, and only your GitHub account can sign in, through a GitHub OAuth app of your own whose callback is <code>http://127.0.0.1/api/auth/github/callback</code>. {inspection?.githubClientId ? `Saved: client ID ${inspection.githubClientId}.` : ""}</span>}
        {current === "shared" && <>
          <span className="small muted">A full Pikibun server for your team: people sign in, create workspaces and pair their own hosts. It serves plain HTTP on this computer; people reach it at a public HTTPS address through a TLS proxy or tunnel you run (<code>tailscale serve</code>, Cloudflare Tunnel, Caddy).</span>
          <fieldset className="stack" disabled={running}>
            <Field label="Public address"><input className="input" type="url" required spellCheck={false} placeholder="https://pikibun.example.com" value={shared.origin} onChange={event => set({ origin: event.target.value })} /></Field>
            <Field label="Listen on">
              <select className="select" value={shared.listen} onChange={event => set({ listen: event.target.value === "all" ? "all" : "loopback" })}>
                <option value="loopback">This computer only: the proxy or tunnel runs here</option>
                <option value="all">Every network interface: the proxy runs on another machine</option>
              </select>
            </Field>
            <label className="check-row"><input type="checkbox" className="checkbox" checked={shared.trustProxy} onChange={event => set({ trustProxy: event.target.checked })} /><span>Trust the proxy's X-Forwarded-Proto and X-Forwarded-Host</span></label>
            <Field label="Who may create an account">
              <select className="select" value={shared.signup} onChange={event => set({ signup: event.target.value === "open" ? "open" : event.target.value === "off" ? "off" : "invite" })}>
                <option value="invite">Only people with a workspace's invite link</option>
                <option value="open">Anyone who reaches it</option>
                <option value="off">Nobody new: only the administrators</option>
              </select>
            </Field>
            <label className="check-row"><input type="checkbox" className="checkbox" checked={shared.passwordAuth} onChange={event => set({ passwordAuth: event.target.checked })} /><span>Usernames and passwords, besides GitHub or instead of it</span></label>
            <Field label="Administrators" hint="One per line: a GitHub login (the app looks up its user ID), github:12345 or password:alice. The first with an account owns this computer's host.">
              <textarea className="textarea mono" rows={3} spellCheck={false} value={admins} onChange={event => setAdmins(event.target.value)} placeholder={"octocat\npassword:admin"} />
            </Field>
            <span className="small muted">GitHub sign-in: {inspection?.shared?.githubClientId ? `saved OAuth app ${inspection.shared.githubClientId}` : "no OAuth app yet"}. Its callback is <code>{(shared.origin.trim().replace(/\/+$/, "") || "https://…")}/api/auth/github/callback</code>.</span>
          </fieldset>
        </>}
        {githubMissing && !running && <Alert variant="info" title={current === "local" ? "Add your GitHub OAuth app first" : "Add a GitHub OAuth app, or turn on usernames and passwords"}
          actions={<Button size="sm" variant="outline" onClick={() => void bridge.openWindow("settings")}>Open app Settings</Button>}>
          Secrets are entered only in the app's own Settings window, never in a web page.
        </Alert>}
        {status.state === "running" && status.mode === "shared" && inspection?.shared?.passwordAuth && <span className="small muted">Create a listed password administrator's account in the app's own Settings window, where its password stays out of web pages.</span>}
        {error && <Alert variant="error" title="Pikibun on this computer">{error}</Alert>}
        {notice && <Alert variant="success" title="Done">{notice}</Alert>}
        <div className="inline">
          {running
            ? <Button variant="outline" disabled={action.busy || status.state === "stopping"} onClick={() => void action.run(() => check(bridge.local.stop()))}>Stop</Button>
            : <Button type="submit" variant="default" disabled={action.busy || githubMissing}>{current === "shared" ? "Share from this computer" : "Run on this computer"}</Button>}
          <Button variant="ghost" onClick={() => void bridge.openWindow("settings")}>App Settings…</Button>
        </div>
        <Feedback {...action} />
      </CardBody>
    </form>
  </Section>;
}

function AppSection({ view, bridge }: { view: DesktopView; bridge: DesktopBridge }) {
  const [server, setServer] = useState(view.primaryServer);
  const action = useAction();
  const login = useAction();
  function save(event: FormEvent) {
    event.preventDefault();
    void action.run(() => check(bridge.setServer(server)), "Saved. The Pikibun window opens this server.");
  }
  return <Section title="App">
    <form onSubmit={save}>
      <CardBody>
        <Field label="Primary server" hint="The Pikibun window opens it, and this computer's primary host pairs with it. It keeps the command line's connector state, so a pairing made with `pikibun connect` carries over.">
          <input className="input" type="url" required spellCheck={false} value={server} onChange={event => setServer(event.target.value)} />
        </Field>
        <div className="inline">
          <Button type="submit" variant="outline" disabled={action.busy || server.trim() === view.primaryServer}>Save</Button>
          {view.primaryServer !== view.defaultServer && <Button variant="ghost" disabled={action.busy} onClick={() => { setServer(view.defaultServer); void action.run(() => check(bridge.setServer(view.defaultServer))); }}>Use {hostOf(view.defaultServer)}</Button>}
        </div>
        <Feedback {...action} />
      </CardBody>
    </form>
    {view.hosts.openAtLogin !== undefined && <Row title="Open Pikibun at login" hint="Hosts left running when Pikibun quits start again when it opens."
      trailing={<input type="checkbox" className="checkbox" role="switch" aria-label="Open Pikibun at login" checked={view.hosts.openAtLogin} disabled={login.busy}
        onChange={event => { const enabled = event.target.checked; void login.run(() => check(bridge.setOpenAtLogin(enabled))); }} />} />}
    {login.error && <CardBody><Feedback {...login} /></CardBody>}
    {view.version && <Row title={view.update ? `Pikibun ${view.update.version} is available` : "Version"}
      hint={view.update ? `You have ${view.version}. Download the new version from its GitHub release page and install it over this one.` : `Pikibun ${view.version}`}
      trailing={view.update && bridge.openUpdate ? <Button variant="default" onClick={() => void bridge.openUpdate?.()}>Update</Button> : undefined} />}
    <Row title={`${view.title} window`} hint="Prerequisites, activity, and pairing with a code for any server" onClick={() => void bridge.openWindow("host")} chevron />
    <Row title="App Settings window" hint="GitHub OAuth apps' secrets and password administrators, and settings while no server answers" onClick={() => void bridge.openWindow("settings")} chevron />
  </Section>;
}
