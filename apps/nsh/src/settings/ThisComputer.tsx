import { effect, signal, untracked, View } from "nsh";
import type { ConnectorPairing } from "../../../../packages/shared/src/connector";
import { listedPrerequisites } from "../../../../packages/shared/src/host-prerequisites";
import type { HostInspection, HostState, LoginMethodType, PrerequisiteFix } from "../../../../packages/shared/src/app-host-protocol";
import { ApiError, createApi } from "../shared";
import { servers, session } from "../lib/auth";
import { openExternal } from "../lib/links";
import { createAction } from "../lib/resource";
import { displayOrigin } from "../lib/server";
import {
  checkCommandUpdates, commandAutoCheck, commandAutoChecking, commandAutoUpdate, commandAutoUpdateLoaded, setCommandAutoUpdate,
  computerName, computerTitle, defaultHostName, INSTALL_COMMAND, localHosts, nativeEnvironment, NVM_INSTALL, originOf, sandboxChoices, sandboxNames, setUnsandboxedConsent,
  relistWsl, wslDistributions, wslName, type LaunchProblem, type LocalEnvironment, type LocalHost, type LocalSandbox, type LogLine,
} from "../lib/this-computer";
import { Checkbox, Field, Select, TextField } from "../form";
import { Icon } from "../icons";
import { palette, type Tone } from "../theme";
import {
  Badge, Banner, Button, CardBody, CollapsibleRow, confirm, CopyField, Feedback, FormSheet, IconButton, Note, Row, Section, Segmented, Small, Value,
} from "../ui";
import { SectionPage, type SectionProps } from "./parts";

const stateLabels: Record<HostState, string> = {
  stopped: "Stopped", starting: "Starting", connecting: "Connecting", connected: "Online", disconnected: "Reconnecting", stopping: "Stopping",
};
const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };

setUnsandboxedConsent((warning, server, missing) => confirm({
  title: `Run ${hostOf(server)}'s agent work directly on ${computerName}?`,
  message: `${missing.length ? `The isolated sandbox needs ${missing.join(", ")}, so the host would run unsandboxed.\n\n` : ""}${warning || "Commands run as you, as soon as the agent calls them, with access to your files, credentials and network, and no resource limits."}`,
  confirmLabel: "Run unsandboxed",
  destructive: true,
}));

export type CreatePairing = (server: string, name: string) => Promise<{ id: string; code: string }>;
export type RenameHost = (server: string, connectorId: string, name: string) => Promise<void>;

function serverApi(server: string) {
  const current = untracked(session);
  if (originOf(server) === originOf(current.origin)) return current.api;
  const saved = untracked(servers).find(item => originOf(item.origin) === originOf(server));
  if (!saved) throw new Error(`This app isn't signed in to ${displayOrigin(server)} any more. Add it again under Settings › Profile › Servers.`);
  return createApi({ baseUrl: saved.origin, auth: () => saved.token });
}

async function createPairing(server: string, name: string): Promise<ConnectorPairing> {
  return (await serverApi(server)<{ pairing: ConnectorPairing }>("/api/connectors/pairings", { method: "POST", body: { name } })).pairing;
}

async function renameHost(server: string, connectorId: string, name: string): Promise<void> {
  await serverApi(server)(`/api/connectors/${encodeURIComponent(connectorId)}`, { method: "PATCH", body: { name } });
}

export function ThisComputer(props: SectionProps) {
  const { origin } = untracked(session);
  const choices = () => [...new Set([origin, ...servers().map(item => item.origin)])];
  return <LocalHostsPanel server={origin} servers={choices} id={props.id} go={props.go} createPairing={createPairing} renameHost={renameHost} />;
}

export function LocalHostsPanel(props: {
  server: string; servers?: () => string[]; id?: string; go?: SectionProps["go"]; createPairing: CreatePairing; renameHost?: RenameHost;
}) {
  const opened = signal(props.id);
  const open = (id?: string) => {
    if (props.go) props.go({ name: "settings", section: "desktop", ...(id ? { id } : {}) });
    else opened.set(id);
  };
  const choices = () => props.servers?.() ?? [props.server];
  return (
    <If when={opened()} else={<HostList server={props.server} servers={choices} createPairing={props.createPairing} open={open} />}>
      {id => <HostPage id={id()} server={props.server} createPairing={props.createPairing} renameHost={props.renameHost ?? renameHost} back={() => open()} />}
    </If>
  );
}

function isolation(host: LocalHost): string {
  const inspection = host.inspection();
  if (inspection?.unsupported) return inspection.unsupported;
  const running = host.running();
  const mode = running ? (running.unsandboxed ? "unsandboxed" : "sandboxed") : inspection?.mode;
  const sandbox = running ? running.sandbox : inspection?.sandbox;
  const where = host.sandbox() === "wsl" ? ` in ${wslName(host.config().distro)}` : "";
  if (mode === "sandboxed") {
    return sandbox === "windows" ? "Sandboxed (Windows process containers, experimental)" : sandbox === "seatbelt" ? "Sandboxed (macOS Seatbelt, experimental)" : `Sandboxed (bubblewrap${where})`;
  }
  return mode === "unsandboxed" ? `Unsandboxed${where}, after your consent` : host.isolationName();
}

function stateBadge(host: LocalHost, testID = "this-computer-state") {
  const failed = Boolean(host.error()) && host.state() === "stopped";
  const tone: Tone = host.state() === "connected" ? "success" : failed ? "danger" : host.state() === "stopped" ? "neutral" : "warning";
  return <Badge testID={testID} tone={tone} dot={host.state() === "connected"}>{failed ? "Stopped (error)" : stateLabels[host.state()]}</Badge>;
}

function activityLines(lines: LogLine[][]): LogLine[] {
  return lines.flat().sort((a, b) => a.time - b.time);
}

function ActivityRows(props: { lines: LogLine[] }) {
  return (
    <CollapsibleRow title="Recent activity" hint={props.lines.length ? undefined : "Nothing yet"} testID="this-computer-logs">
      <Each of={props.lines.slice(-50).reverse()} key="index">
        {line => <Note>{`${new Date(line().time).toLocaleTimeString()} ${line().level === "info" ? "" : `${line().level}: `}${line().message}`}</Note>}
      </Each>
    </CollapsibleRow>
  );
}

const prefixed = (host: LocalHost): LogLine[] => host.logs().map(line => ({ ...line, message: `${host.name()}: ${line.message}` }));

function HostList(props: { server: string; servers: () => string[]; createPairing: CreatePairing; open: (id?: string) => void }) {
  const hosts = localHosts();
  const native = nativeEnvironment();
  const ready = signal(false);
  void hosts.discover(props.server).finally(() => ready.set(true));
  const inspector = () => hosts.probe() ?? hosts.list().find(host => !host.stateDir && host.environment.key === "native");
  const refresh = async (): Promise<LaunchProblem | null | undefined> => {
    const host = untracked(inspector) ?? hosts.draft(sandboxChoices()[0]!);
    await host.refresh(props.server);
    return untracked(() => host.problem());
  };
  const logs = () => activityLines([native.logs(), ...[...hosts.list(), ...(hosts.probe() ? [hosts.probe()!] : [])].map(prefixed)]);
  return (
    <SectionPage testID="settings-this-computer">
      <CommandSection environment={native} refresh={refresh} busy={Boolean(inspector()?.inspecting())} />
      <UpdatingSection environment={native} />
      <HostsSection server={props.server} servers={props.servers} createPairing={props.createPairing} open={props.open} ready={ready()} />
      <AutoUpdateSection />
      <Section title="Activity" testID="this-computer-activity"
        action={<Button small variant="ghost" icon="refresh" label="Refresh" testID="this-computer-refresh" disabled={Boolean(inspector()?.inspecting())} onPress={() => void refresh()} />}>
        <ActivityRows lines={logs()} />
      </Section>
    </SectionPage>
  );
}

function CommandSection(props: { environment: LocalEnvironment; refresh: () => Promise<LaunchProblem | null | undefined>; busy: boolean }) {
  const env = props.environment;
  const action = createAction();
  const install = () => {
    if (env.installing()) return;
    void action.run(async () => {
      const outcome = await env.install(props.refresh);
      if (!outcome.ok && outcome.error && !env.installError()) throw new Error(outcome.error);
    });
  };
  const place = () => `${env.wsl ? "in" : "on"} ${env.where()}`;
  const node = () => (env.wsl ? `Node.js 24 or newer there (for example with nvm: ${NVM_INSTALL})` : `Node.js 24 or newer (nodejs.org${computerTitle === "This Mac" ? ", or brew install node" : ""})`);
  return (
    <If when={env.problem() ?? (env.stale() ? { kind: "outdated" as const } : null)}>
      {problem => {
        const update = () => problem().kind === "outdated";
        const refresh = () => <Button small variant="outline" icon="refresh" label="Refresh" testID="this-computer-retry" disabled={props.busy || env.installing()} onPress={() => void props.refresh()} />;
        return (
          <Section title={env.wsl ? `Pikibun's command in ${env.where()}` : "Pikibun's command"} testID="this-computer-command">
            <CardBody>
              <If when={problem().kind === "failed"}
                else={
                  <Banner tone="warning" title={update() ? `Update Pikibun's command ${place()}` : `Install Pikibun's command ${place()}`} actions={refresh()}>
                    {update()
                      ? (env.stale() && !env.problem()
                        ? `${env.wsl ? `Hosts in ${env.where()} run` : `${computerTitle} runs`} pikibun ${env.stale()!.version}, older than the ${env.stale()!.wanted} this version of Pikibun comes with: its hosts may miss fixes and features they need. Update it from npm here.`
                        : `The pikibun command ${place()} is older than this app, which runs pikibun host. Update it from npm here.`)
                      : `${env.wsl ? `Hosts in ${env.where()}` : computerTitle} run sessions with the pikibun command, as pikibun connect does in a terminal. Install it from npm here: it needs ${node()}.`}
                  </Banner>
                }>
                <Banner tone="danger" title="The host could not start" actions={refresh()}>{(problem() as { message: string }).message}</Banner>
              </If>
              <If when={problem().kind !== "failed"}>
                <View style={{ flexDirection: "row" }}>
                  <Button variant="primary" icon="download" testID="this-computer-install-button" busy={env.installing()} disabled={env.installing() || props.busy || Boolean(env.stopFirst())}
                    label={env.installing() ? (update() ? "Updating pikibun" : "Installing pikibun") : update() ? "Update pikibun" : "Install pikibun"} onPress={install} />
                </View>
                <If when={env.installing()}><Small>npm is installing pikibun: this takes a minute. Its output is under Recent activity below.</Small></If>
                <If when={!env.installing() && env.stopFirst()}><Small testID="this-computer-install-hosts-running">{env.stopFirst()}</Small></If>
                <Feedback error={action.error()} />
                <If when={env.installError()}>
                  <Feedback error={env.installError()} />
                  <Small>{env.wsl ? `To install it in a WSL terminal instead:` : "To install it in a terminal instead:"}</Small>
                  <CopyField testID="this-computer-install" value={INSTALL_COMMAND} label="Copy command" />
                </If>
              </If>
            </CardBody>
          </Section>
        );
      }}
    </If>
  );
}

function UpdatingSection(props: { environment: LocalEnvironment }) {
  return (
    <If when={props.environment.updating()}>
      <Section title="Pikibun's command" testID="this-computer-updating">
        <CardBody>
          <Banner tone="info" title={`Updating Pikibun's command ${props.environment.wsl ? "in" : "on"} ${props.environment.where()}`}>
            {props.environment.updatingTo()
              ? `npm has pikibun ${props.environment.updatingTo()}, so npm is updating the command to it: this takes a minute, and the hosts there start again once it is done. Its output is under Recent activity below.`
              : `Pikibun was updated, so npm is updating its pikibun command to match: this takes a minute, and the hosts there start once it is done. Its output is under Recent activity below.`}
          </Banner>
        </CardBody>
      </Section>
    </If>
  );
}

function AutoUpdateSection() {
  const loaded = signal(false);
  void commandAutoUpdateLoaded().finally(() => loaded.set(true));
  const action = createAction();
  const toggle = (on: boolean) => void action.run(() => setCommandAutoUpdate(on));
  const check = () => void checkCommandUpdates({ retry: true });
  const status = () => {
    const last = commandAutoCheck();
    if (commandAutoChecking()) return "Asking npm for pikibun's latest version…";
    if (!last) return "";
    const at = new Date(last.at).toLocaleTimeString();
    return last.error ? `${at}: ${last.error}` : last.latest ? `Checked at ${at}: npm's latest pikibun is ${last.latest}.` : `Checked at ${at}: npm named no version.`;
  };
  return (
    <Section title="Updates" testID="this-computer-auto-update"
      info={`Pikibun's command on ${computerName} is the version this app was released with. With this on, the app asks npm for a newer pikibun when it opens and every few hours, and installs it into its own copy (and the copies it installed in WSL), stopping the hosts that run it for the minute npm takes and starting them again after, as stopping and starting them here does.`}>
      <CardBody>
        <Checkbox testID="this-computer-auto-update-toggle" label="Update Pikibun's command automatically" hint="Install a newer pikibun from npm as soon as it is released"
          checked={commandAutoUpdate()} disabled={!loaded() || action.busy()} onChange={toggle} />
        <If when={commandAutoUpdate()}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Button small variant="outline" icon="refresh" label="Check now" testID="this-computer-auto-update-check" disabled={action.busy() || commandAutoChecking()} onPress={check} />
          </View>
          <If when={status()}><Small testID="this-computer-auto-update-status">{status()}</Small></If>
        </If>
        <Feedback error={action.error()} />
      </CardBody>
    </Section>
  );
}

function HostsSection(props: { server: string; servers: () => string[]; createPairing: CreatePairing; open: (id?: string) => void; ready: boolean }) {
  const hosts = localHosts();
  const adding = signal(false);
  const action = createAction();
  const start = (host: LocalHost) => void action.run(async () => {
    const outcome = await host.start();
    if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't start.");
  });
  const stop = (host: LocalHost) => void action.run(async () => {
    const outcome = await host.stop();
    if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't stop.");
  });
  const empty = () => hosts.list().length === 0;
  return (
    <>
      <Section title={`Hosts on ${computerName}`} testID="this-computer-hosts"
        info={`Each host runs sessions on ${computerName} for one Pikibun server, as pikibun connect does, while Pikibun is open: with a pairing, a state directory, a sandbox and models of its own. Add several to host for several servers, or for one server in different sandboxes. The first one's pairing is the command line's, so a computer paired with pikibun connect carries over; only one of them runs at a time.`}
        action={!empty() && !adding() ? <Button small variant="outline" icon="plus" label="Add a host" testID="this-computer-add" onPress={() => adding.set(true)} /> : undefined}>
        <If when={!empty()} else={<Row title={props.ready ? "No hosts yet" : `Checking ${computerName}…`} hint={props.ready ? `Add one below to run sessions on ${computerName}.` : undefined} />}>
          <Each of={hosts.list()} key={host => host.id}>
            {host => (
              <Row title={host().name()} testID={`local-host-${host().id}`} hint={`${displayOrigin(host().server())} · ${isolation(host())}`}
                trailing={
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    {stateBadge(host(), `local-host-state-${host().id}`)}
                    <If when={host().state() === "stopped"}
                      else={<Button small variant="outline" testID={`local-host-stop-${host().id}`} label="Stop" disabled={action.busy() || host().state() === "stopping"} onPress={() => stop(host())} />}>
                      <Button small variant="outline" testID={`local-host-start-${host().id}`} label="Start" disabled={action.busy()} onPress={() => start(host())} />
                    </If>
                    <IconButton testID={`local-host-open-${host().id}`} icon="chevron-right" label={`Open ${host().name()}`} onPress={() => props.open(host().id)} />
                  </View>
                } />
            )}
          </Each>
        </If>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Section>
      <If when={props.ready && (adding() || empty())}>
        <AddHostSection server={props.server} servers={props.servers} createPairing={props.createPairing} cancel={empty() ? undefined : () => adding.set(false)}
          added={() => adding.set(false)} />
      </If>
    </>
  );
}

function AddHostSection(props: { server: string; servers: () => string[]; createPairing: CreatePairing; cancel?: () => void; added: () => void }) {
  const hosts = localHosts();
  const choices = sandboxChoices();
  const server = signal(props.server);
  const sandbox = signal<LocalSandbox>(choices[0]!);
  const distro = signal("");
  const named = signal<string | null>(null);
  const draft = signal<LocalHost | undefined>(undefined);
  const action = createAction();
  let finished = false;
  const retire = (host: LocalHost | undefined) => {
    if (host && !hosts.list().includes(host) && host !== hosts.probe() && host.state() === "stopped") void host.shutdown();
  };
  effect(() => () => untracked(() => retire(draft())));
  effect(() => {
    const chosen = sandbox();
    const wanted = chosen === "wsl" && distro() ? distro() : undefined;
    const origin = server();
    if (finished) return;
    const next = hosts.draft(chosen, wanted);
    untracked(() => {
      if (hosts.list().includes(next)) return;
      const previous = draft();
      if (previous !== next) retire(previous);
      const config = next.config();
      const changed = config.sandbox !== chosen;
      if (changed || config.server !== origin) next.change({ server: origin, sandbox: chosen }, false);
      draft.set(next);
      if ((changed || !next.inspection()) && !next.inspecting()) void next.refresh();
    });
  });
  const suggested = () => {
    const base = defaultHostName(sandbox());
    const taken = new Set(hosts.list().map(host => host.name()));
    let name = base;
    for (let count = 2; taken.has(name); count++) name = `${base} ${count}`;
    return name;
  };
  const name = () => named() ?? suggested();
  const others = () => hosts.forServer(server());
  const inspection = () => draft()?.inspection();
  const noModels = () => Boolean(inspection() && !inspection()!.models.length);
  const distros = () => (sandbox() === "wsl" ? wslDistributions() : undefined);
  function pair() {
    const target = untracked(draft);
    const hostName = untracked(name).trim();
    const origin = untracked(server);
    if (!target || action.busy() || !hostName) return;
    void action.run(async () => {
      target.change({ server: origin, name: hostName }, false);
      const outcome = await target.start({ pairing: { create: () => props.createPairing(origin, hostName), replace: false } });
      if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't start.");
      finished = true;
      props.added();
      await hosts.add(target);
    }, `${hostName} is pairing with ${hostOf(origin)}. It appears under that server's Hosts once it is online.`);
  }
  return (
    <>
      <Section title="Add a host" testID="this-computer-pair"
        action={props.cancel ? <Button small variant="ghost" label="Cancel" testID="this-computer-add-cancel" onPress={props.cancel} /> : undefined}>
        <CardBody>
          <Small>{others().length
            ? `Pair another host on ${computerName} with ${hostOf(server())} in one step: no code to copy. It is a host of its own, beside ${others().map(host => host.name()).join(", ")}, with its own sandbox and models.`
            : `Pair ${computerName} with ${hostOf(server())} as your host in one step: no code to copy.`}</Small>
          <If when={props.servers().length > 1}>
            <Field label="Pikibun server">
              <Select<string> testID="this-computer-server-choice" label="Pikibun server" value={server()} disabled={action.busy()}
                options={props.servers().map(origin => ({ value: origin, label: displayOrigin(origin) }))} onChange={value => server.set(value)} />
            </Field>
          </If>
          <Field label="Host name">
            <TextField testID="this-computer-name" value={name()} onChange={value => named.set(value)} maxLength={120} onSubmit={pair} />
          </Field>
          <If when={choices.length > 1}>
            <Field label="Sandbox">
              <Segmented<LocalSandbox> testID="this-computer-sandbox-choice" value={sandbox()} onChange={value => { if (!action.busy()) sandbox.set(value); }}
                options={choices.map(value => ({ value, label: sandboxNames[value] }))} />
            </Field>
          </If>
          <Small>{sandboxHint(sandbox())}</Small>
          <If when={sandbox() === "wsl"}>
            <Field label="WSL distribution">
              <Select<string> testID="this-computer-distro" label="WSL distribution" value={distro()} disabled={action.busy()}
                options={[{ value: "", label: "WSL's default" }, ...(distros() ?? []).map(name => ({ value: name, label: name }))]} onChange={value => distro.set(value)} />
            </Field>
            <If when={distros() === null}>
              <Small>WSL isn't set up on this computer, or has no distribution yet. In PowerShell, run wsl --install, restart if Windows asks, and open Ubuntu once to create your Linux user; then choose Refresh.</Small>
              <CopyField value="wsl --install" label="Copy command" />
              <View style={{ flexDirection: "row" }}>
                <Button small variant="outline" icon="refresh" label="Refresh" testID="this-computer-distros-refresh" onPress={() => { relistWsl(); const host = untracked(draft); if (host) void host.refresh(); }} />
              </View>
            </If>
          </If>
          <If when={draft() && inspection()}>
            <Small testID="this-computer-new-isolation">{`Here, sessions would run: ${isolation(draft()!)}.`}</Small>
          </If>
          <If when={noModels()}>
            <Small>{`${inspection()!.modelsError ?? "Pi has no models to offer yet."} Sign Pi in to a provider ${draft()!.environment.wsl ? "in" : "on"} ${draft()!.where()} below first.`}</Small>
          </If>
          <View style={{ flexDirection: "row" }}>
            <Button variant="primary" testID="this-computer-pair-button" label={action.busy() ? "Pairing" : "Pair host"} busy={action.busy()}
              disabled={!name().trim() || !draft() || !inspection() || Boolean(inspection()?.unsupported)} onPress={pair} />
          </View>
          <Feedback error={action.error()} notice={action.notice()} />
        </CardBody>
      </Section>
      <If when={draft()}>
        {host => (
          <>
            <If when={host().environment.wsl}>
              <CommandSection environment={host().environment} busy={host().inspecting()} refresh={async () => { relistWsl(); await host().refresh(); return untracked(() => host().problem()); }} />
              <UpdatingSection environment={host().environment} />
            </If>
            <If when={noModels()}><SignInSection host={host()} /></If>
            <If when={inspection()}><PrerequisitesSection host={host()} /></If>
          </>
        )}
      </If>
    </>
  );
}

function sandboxHint(sandbox: LocalSandbox): string {
  switch (sandbox) {
    case "seatbelt": return "Sessions run in macOS's own Seatbelt sandbox, which is experimental (macOS 15 or later with the developer tools: xcode-select --install), or without one, after your consent, while it isn't ready.";
    case "none": return `Sessions run directly as you on ${computerName}, after your consent at each start: their commands can read and change anything you can.`;
    case "windows": return "Sessions run in Windows' own sandbox, which is experimental, where this computer meets its requirements; otherwise without one, after your consent.";
    case "wsl": return "Sessions run in WSL2's bubblewrap sandbox, with WSL's own Node.js, Pi sign-in and Git, as pikibun connect does in a WSL terminal.";
    default: return "Sessions run in the bubblewrap sandbox where it is installed; otherwise without one, after your consent.";
  }
}

function HostPage(props: { id: string; server: string; createPairing: CreatePairing; renameHost: RenameHost; back: () => void }) {
  const hosts = localHosts();
  const loaded = signal(false);
  void hosts.load().finally(() => loaded.set(true));
  const host = () => hosts.byId(props.id);
  let inspected: LocalHost | undefined;
  effect(() => {
    const current = host();
    if (!current || current === inspected) return;
    inspected = current;
    void current.refresh();
  });
  return (
    <SectionPage testID="local-host">
      <View style={{ flexDirection: "row", marginLeft: -8, marginBottom: -16 }}>
        <Button small variant="ghost" icon="chevron-left" label="Local hosts" testID="local-hosts-back" onPress={props.back} />
      </View>
      <If when={host()} else={<Section title="Host"><Row title={loaded() ? `${computerTitle} has no such host` : "Loading…"} hint={loaded() ? "It may have been removed." : undefined} /></Section>}>
        {current => (
          <>
            <CommandSection environment={current().environment} busy={current().inspecting()} refresh={async () => { await current().refresh(); return untracked(() => current().problem()); }} />
            <UpdatingSection environment={current().environment} />
            <HostSection host={current()} createPairing={props.createPairing} renameHost={props.renameHost} />
            <If when={current().inspection()}>
              <SandboxSection host={current()} />
              <ModelsSection host={current()} />
              <SignInSection host={current()} />
              <PrerequisitesSection host={current()} />
            </If>
            <HostActivitySection host={current()} removed={props.back} />
          </>
        )}
      </If>
    </SectionPage>
  );
}

function HostSection(props: { host: LocalHost; createPairing: CreatePairing; renameHost: RenameHost }) {
  const host = props.host;
  const action = createAction();
  const name = signal(untracked(() => host.name()));
  const renameAction = createAction();
  const renaming = signal(false);
  const newName = signal("");
  const openRename = () => { renameAction.clear(); newName.set(untracked(() => host.name())); renaming.set(true); };
  async function rename() {
    const next = untracked(newName).trim();
    if (renameAction.busy() || !next) return;
    if (next === untracked(() => host.name())) { renaming.set(false); return; }
    const origin = untracked(server);
    const connectorId = untracked(() => host.running()?.connectorId ?? host.config().connectorIds?.at(-1));
    let onServer = false;
    const saved = await renameAction.run(async () => {
      if (connectorId) {
        try {
          await props.renameHost(origin, connectorId, next);
          onServer = true;
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      }
      host.change({ name: next });
      name.set(next);
    }, () => (onServer ? `Renamed to ${next}, here and on ${hostOf(origin)}.` : `Renamed to ${next} here. Rename it on ${hostOf(origin)} too, under Settings › Hosts.`));
    if (saved) renaming.set(false);
  }
  const server = () => host.server();
  const pairingProblem = () => {
    const inspection = host.inspection();
    return Boolean(inspection && !host.paired() && (inspection.pairedServer || inspection.pairingError));
  };
  function pair() {
    const hostName = untracked(name).trim();
    if (action.busy() || !hostName) return;
    const origin = untracked(server);
    void action.run(async () => {
      host.change({ name: hostName });
      const outcome = await host.start({ pairing: { create: () => props.createPairing(origin, hostName), replace: untracked(pairingProblem) } });
      if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't start.");
    }, `${hostName} is pairing with ${hostOf(origin)}. It appears under that server's Hosts once it is online.`);
  }
  const start = () => void action.run(async () => {
    const outcome = await host.start();
    if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't start.");
  });
  const stop = () => void action.run(async () => {
    const outcome = await host.stop();
    if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't stop.");
  });
  return (
    <Section title={host.name()} testID="this-computer-server"
      info={`This host runs sessions for ${hostOf(server())} on ${computerName}, as pikibun connect does, while Pikibun is open. It starts again at the next launch if it was running when the app quit.`}>
      <If when={host.inspection() || host.state() !== "stopped"}
        else={<Row title={host.problem() ? `${host.name()} can't start yet` : `Checking ${host.where()}…`} hint={host.problem() ? "Pikibun's command is needed first: see above." : undefined} />}>
        <If when={host.paired() || host.state() !== "stopped"}
          else={
            <CardBody testID="this-computer-repair">
              <Small>{pairingProblem()
                ? `This host's pairing for ${hostOf(server())} can't be used (${host.inspection()?.pairedServer ?? "it can't be read"}). Pairing again replaces it; the old host stays in that Pikibun, offline, until you remove it there.`
                : `This host isn't paired with ${hostOf(server())} yet. Pair it in one step: no code to copy.`}</Small>
              <Field label="Host name">
                <TextField testID="this-computer-name" value={name()} onChange={value => name.set(value)} maxLength={120} onSubmit={pair} />
              </Field>
              <View style={{ flexDirection: "row" }}>
                <Button variant="primary" testID="this-computer-pair-button" label={action.busy() ? "Pairing" : pairingProblem() ? "Pair again" : "Pair host"} busy={action.busy()}
                  disabled={!name().trim() || Boolean(host.inspection()?.unsupported)} onPress={pair} />
              </View>
              <Feedback error={action.error()} notice={action.notice()} />
            </CardBody>
          }>
          <Row title={`${host.name()} is a host of ${hostOf(server())}`} hint={isolation(host)} trailing={<>
            {stateBadge(host)}
            <Button small variant="outline" icon="pencil" label="Rename" testID="this-computer-rename" disabled={renameAction.busy()} onPress={openRename} />
          </>} />
          <FormSheet open={renaming()} title={`Rename ${host.name()}`} onClose={() => { if (!renameAction.busy()) renaming.set(false); }} testID="this-computer-rename-sheet"
            footer={<>
              <Button label="Cancel" disabled={renameAction.busy()} onPress={() => renaming.set(false)} />
              <Button testID="this-computer-rename-save" variant="primary" label={renameAction.busy() ? "Saving…" : "Rename"} disabled={renameAction.busy() || !newName().trim()}
                onPress={() => void rename()} />
            </>}>
            <Field label="Host name" hint={`How ${hostOf(server())} lists this host, here and under Settings › Hosts`}>
              <TextField testID="this-computer-rename-name" value={newName()} onChange={value => newName.set(value)} maxLength={120} autoFocus onSubmit={() => void rename()} />
            </Field>
            <Feedback error={renameAction.error()} />
          </FormSheet>
          <CardBody>
            <If when={!renaming() && renameAction.notice()}><Feedback notice={renameAction.notice()} /></If>
            <If when={host.error() && host.state() === "stopped"}><Banner tone="danger" title="The host stopped">{host.error()}</Banner></If>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <If when={host.state() === "stopped"}
                else={<Button variant="outline" testID="this-computer-stop" label="Stop host" disabled={action.busy() || host.state() === "stopping"} onPress={stop} />}>
                <Button variant="primary" testID="this-computer-start" label="Start host" busy={action.busy()} onPress={start} />
              </If>
            </View>
            <Feedback error={action.error()} notice={action.notice()} />
          </CardBody>
        </If>
      </If>
    </Section>
  );
}

function SandboxSection(props: { host: LocalHost }) {
  const host = props.host;
  const action = createAction();
  const choices = () => sandboxChoices().filter(choice => choice !== "wsl" && choice !== "windows");
  const change = (choice: LocalSandbox) => {
    if (host.state() !== "stopped" || action.busy() || choice === host.sandbox()) return;
    void action.run(async () => {
      const outcome = await host.setSandbox(choice);
      if (!outcome.ok) throw new Error(outcome.error);
    });
  };
  return (
    <Section title="Sandbox" testID="this-computer-sandbox">
      <If when={computerTitle === "This Mac"}
        else={
          <>
            <Row title="Sessions run in" trailing={host.isolationName()} />
            <CardBody><Small>{`${sandboxHint(host.sandbox())}${sandboxChoices().length > 1 ? " It was chosen when the host was added: to run sessions in another, add another host." : ""}`}</Small></CardBody>
          </>
        }>
        <CardBody>
          <Segmented<LocalSandbox> testID="this-computer-sandbox-choice" value={host.sandbox()} onChange={change}
            options={choices().map(value => ({ value, label: sandboxNames[value] }))} />
          <Small>{host.sandbox() === "seatbelt"
            ? `${sandboxHint("seatbelt")} Each session sees only its own files and reaches the network only through its egress proxy. macOS can't limit a session's memory or processes, so commands (what git, node, python and the other program tools run) run only in your own sessions on this host and those of members you grant host commands.`
            : `${sandboxHint("none")} Choose macOS sandbox to isolate them.`}</Small>
          <If when={host.state() !== "stopped"}><Small>Stop this host to change where its sessions run.</Small></If>
          <Feedback error={action.error()} />
        </CardBody>
      </If>
    </Section>
  );
}

const modelKey = (model: { provider: string; modelId: string }) => `${model.provider}/${model.modelId}`;

function ModelsSection(props: { host: LocalHost }) {
  const host = props.host;
  const available = () => host.inspection()?.models ?? [];
  const draft = signal<Set<string> | null>(null);
  const chosen = () => draft() ?? new Set(host.models()?.map(modelKey) ?? available().map(modelKey));
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen());
    if (on) next.add(key); else next.delete(key);
    draft.set(next);
  };
  const action = createAction();
  return (
    <Section title="Models offered" testID="this-computer-models"
      info={`This host's own choice: other hosts on ${computerName} offer theirs. Pikibun never receives your provider credentials: Pi keeps them in ${host.where()}. A change applies from the host's next start.`}>
      <If when={available().length > 0}
        else={<Row title="No models yet" hint={host.inspection()?.modelsError ? `${host.inspection()!.modelsError} Sign Pi in to a provider below.` : "Sign Pi in to a provider below."} />}>
        <CardBody>
          <Small>{host.models() ? "Only the checked models." : "Pi chooses: its enabledModels setting, or every model with configured authentication. Uncheck some to offer only the rest."}</Small>
          <Each of={available()} key={model => modelKey(model)}>
            {model => <Checkbox testID={`this-computer-model-${modelKey(model())}`} label={model().name} hint={modelKey(model())} checked={chosen().has(modelKey(model()))}
              disabled={action.busy()} onChange={on => toggle(modelKey(model()), on)} />}
          </Each>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button small variant="outline" testID="this-computer-models-save" label="Offer checked models" disabled={!draft() || chosen().size === 0} onPress={() => void action.run(async () => {
              const outcome = host.setModels(available().filter(model => chosen().has(modelKey(model))).map(model => ({ provider: model.provider, modelId: model.modelId })));
              if (!outcome.ok) throw new Error(outcome.error);
              draft.set(null);
            }, "Saved: the host offers these from its next start.")} />
            <If when={host.models()}>
              <Button small variant="ghost" label="Let Pi choose" onPress={() => void action.run(async () => { host.setModels(null); draft.set(null); })} />
            </If>
            <If when={draft() && chosen().size === 0}><Small>Check at least one model, or let Pi choose.</Small></If>
          </View>
          <Feedback error={action.error()} notice={action.notice()} />
        </CardBody>
      </If>
    </Section>
  );
}

function SignInSection(props: { host: LocalHost }) {
  const host = props.host;
  const provider = signal<string | undefined>(undefined);
  const method = signal<LoginMethodType | undefined>(undefined);
  const answer = signal("");
  const choice = signal<string | undefined>(undefined);
  const feedback = signal("");
  const providers = () => host.providers() ?? [];
  const current = () => providers().find(entry => entry.id === provider()) ?? providers()[0];
  const methods = () => current()?.methods ?? [];
  const chosenMethod = () => methods().find(entry => entry.type === method())?.type ?? methods()[0]?.type;
  const running = () => host.signIn()?.state === "running";
  let shown: number | undefined;
  effect(() => {
    const prompt = host.signIn()?.prompt;
    if (prompt?.id === shown) return;
    shown = prompt?.id;
    answer.set("");
    choice.set(prompt?.detail.type === "select" ? prompt.detail.options[0]?.id : undefined);
  });
  function start() {
    const chosen = current();
    const how = chosenMethod();
    if (!chosen || !how || running()) return;
    feedback.set("");
    void host.startSignIn(chosen.id, how, openExternal).then(outcome => { if (!outcome.ok && outcome.error) feedback.set(outcome.error); });
  }
  function submit() {
    const prompt = host.signIn()?.prompt;
    if (!prompt) return;
    const value = prompt.detail.type === "select" ? choice() ?? "" : answer();
    answer.set("");
    void host.answerSignIn(prompt.id, value).then(outcome => { if (!outcome.ok && outcome.error) feedback.set(outcome.error); });
  }
  const status = () => {
    const signIn = host.signIn();
    if (!signIn) return "";
    if (signIn.state === "running") return `Signing in to ${signIn.name}…`;
    if (signIn.state === "done") return `Pi is signed in to ${signIn.name} in ${host.where()}. Its models are listed above.`;
    if (signIn.state === "cancelled") return "Sign-in cancelled.";
    return signIn.error ?? "Sign-in failed.";
  };
  return (
    <Section title="Sign Pi in to a provider" testID="this-computer-sign-in"
      info={`Pikibun runs Pi's own sign-in in ${host.where()}, as Pi's /login does: the credential is saved in Pi's configuration there, shared by every host that runs there, and never sent to Pikibun. No separate Pi install is needed.`}>
      <CardBody>
        <If when={!host.providersError()} else={<Small>{`${host.providersError()} Choose Refresh once ${host.where()} is ready.`}</Small>}>
          <If when={host.providers() === null || providers().length > 0} else={<Small>{`Pi in ${host.where()} offers no provider to sign in to.`}</Small>}>
            <Field label="Provider">
              <Select<string> testID="this-computer-provider" label="Provider" value={current()?.id} disabled={running() || !providers().length}
                options={providers().map(entry => ({ value: entry.id, label: `${entry.name}${entry.signedIn ? " (signed in)" : ""}` }))}
                onChange={value => { provider.set(value); method.set(undefined); }} />
            </Field>
            <If when={methods().length > 1}>
              <Field label="How">
                <Select<LoginMethodType> label="How" value={chosenMethod()} disabled={running()}
                  options={methods().map(entry => ({ value: entry.type, label: `${entry.name}${entry.subscription ? " (subscription)" : ""}` }))} onChange={value => method.set(value)} />
              </Field>
            </If>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button variant="outline" testID="this-computer-sign-in-start" label="Sign in" disabled={running() || !current()} onPress={start} />
              <If when={running()}><Button variant="ghost" label="Cancel" testID="this-computer-sign-in-cancel" onPress={() => void host.cancelSignIn()} /></If>
            </View>
          </If>
        </If>
        <If when={host.signIn()}>
          <Small testID="this-computer-sign-in-status">{status()}</Small>
          <If when={running()}>
            <Each of={host.signIn()?.notices ?? []} key="index">
              {notice => (
                <View style={{ gap: 6 }}>
                  <If when={notice().kind === "device-code" ? notice() as { userCode: string; verificationUri: string } : null}
                    else={<Small>{notice().kind === "auth-url" ? (notice() as { instructions?: string }).instructions ?? "Sign in on the page that opened in your browser." : (notice() as { message: string }).message}</Small>}>
                    {device => <>
                      <Small>Enter this code on the page that opened in your browser:</Small>
                      <Value monospace testID="this-computer-device-code">{device().userCode}</Value>
                    </>}
                  </If>
                  <If when={notice().kind === "auth-url" ? (notice() as { url: string }).url : notice().kind === "device-code" ? (notice() as { verificationUri: string }).verificationUri : null}>
                    {url => <View style={{ flexDirection: "row" }}><Button small variant="ghost" icon="external-link" label="Open the page again" onPress={() => openExternal(url())} /></View>}
                  </If>
                </View>
              )}
            </Each>
          </If>
          <If when={host.signIn()?.prompt}>
            {prompt => (
              <View style={{ gap: 8 }}>
                <Field label={prompt().detail.message}>
                  <If when={prompt().detail.type === "select" ? prompt().detail as { options: { id: string; label: string; description?: string }[] } : null}
                    else={<TextField testID="this-computer-sign-in-answer" value={answer()} onChange={value => answer.set(value)} masked={prompt().detail.type === "secret"}
                      placeholder={(prompt().detail as { placeholder?: string }).placeholder} monospace onSubmit={submit} />}>
                    {select => <Select<string> label={prompt().detail.message} value={choice()} onChange={value => choice.set(value)}
                      options={select().options.map(option => ({ value: option.id, label: option.label, hint: option.description }))} />}
                  </If>
                </Field>
                <View style={{ flexDirection: "row" }}><Button small variant="primary" testID="this-computer-sign-in-submit" label="Continue" onPress={submit} /></View>
              </View>
            )}
          </If>
        </If>
        <Feedback error={feedback()} />
      </CardBody>
    </Section>
  );
}

function Fix(props: { fix: PrerequisiteFix }) {
  return (
    <View style={{ gap: 6 }}>
      <Small>{props.fix.text}</Small>
      <If when={props.fix.command}>{command => <CopyField value={command()} label="Copy command" />}</If>
      <If when={props.fix.url}>{url => <View style={{ flexDirection: "row" }}><Button small variant="ghost" icon="external-link" label="Open page" onPress={() => openExternal(url())} /></View>}</If>
    </View>
  );
}

function PrerequisitesSection(props: { host: LocalHost }) {
  const inspection = () => props.host.inspection() as HostInspection;
  const listed = () => {
    const seen = new Set<string>();
    return listedPrerequisites(inspection()).map(({ entry, sandbox }) => {
      const key = entry.fix ? JSON.stringify(entry.fix) : "";
      const fix = !entry.ok && entry.fix && !seen.has(key) ? entry.fix : undefined;
      if (fix) seen.add(key);
      return { entry, sandbox, fix };
    });
  };
  const sandboxMissing = () => inspection().sandboxPrerequisites?.filter(entry => !entry.ok).map(entry => entry.name) ?? [];
  return (
    <Section title={props.host.environment.wsl ? `Prerequisites in ${props.host.where()}` : "Prerequisites"} testID="this-computer-prerequisites">
      <If when={inspection().unsupportedFix}>{fix => <CardBody><Fix fix={fix()} /></CardBody>}</If>
      <If when={inspection().prerequisitesError || sandboxMissing().length}>
        <CardBody><Small>{inspection().prerequisitesError ?? `The isolated sandbox needs ${sandboxMissing().join(", ")}; without it the host runs unsandboxed, after your consent.`}</Small></CardBody>
      </If>
      <Each of={listed()} key={item => item.entry.name}>
        {item => (
          <Row title={item().entry.name} testID={`this-computer-prerequisite-${item().entry.name}`}
            leading={<Icon name={item().entry.ok ? "check" : item().entry.optional ? "info" : "x"} size={16}
              color={item().entry.ok ? palette().tones.success.text : item().entry.optional ? palette().muted : palette().tones.danger.text} />}
            hint={item().fix ? <Fix fix={item().fix!} /> : item().sandbox ? "For the sandbox" : item().entry.optional && !item().entry.ok ? "Optional" : undefined}
            trailing={item().entry.ok ? "Present" : item().entry.optional ? "Optional" : "Missing"} />
        )}
      </Each>
    </Section>
  );
}

function HostActivitySection(props: { host: LocalHost; removed: () => void }) {
  const host = props.host;
  const action = createAction();
  const logs = () => activityLines([host.environment.logs(), host.logs()]);
  const remove = () => void action.run(async () => {
    const sure = await confirm({
      title: `Remove ${host.name()}?`,
      message: `${computerTitle} stops this host for ${hostOf(host.server())} and forgets it here. The host stays in that Pikibun's Settings › Hosts, offline, until you remove it there, and its sessions' files stay in its folder.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!sure) return;
    const outcome = await localHosts().remove(host.id);
    if (!outcome.ok) throw new Error(outcome.error ?? "The host wasn't removed.");
    props.removed();
  });
  return (
    <Section title="Host" testID="this-computer-activity"
      action={<Button small variant="ghost" icon="refresh" label="Refresh" testID="this-computer-refresh" disabled={host.inspecting()} onPress={() => void host.refresh()} />}>
      <Row title="State directory" hint={<Value monospace>{host.inspection()?.stateDir ?? host.config().stateDir ?? "pikibun connect's"}</Value>} />
      <If when={host.inspection()?.pairedServer}>{server => <Row title="Paired with" trailing={server()} />}</If>
      <ActivityRows lines={logs()} />
      <If when={host.stateDir}>
        <CardBody>
          <View style={{ flexDirection: "row" }}>
            <Button small variant="ghost" testID="this-computer-remove" label="Remove this host" disabled={action.busy()} onPress={remove} />
          </View>
          <Feedback error={action.error()} />
        </CardBody>
      </If>
    </Section>
  );
}
