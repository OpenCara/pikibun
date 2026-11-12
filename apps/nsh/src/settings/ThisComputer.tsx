import { effect, signal, untracked, View } from "nsh";
import type { ConnectorPairing } from "../../../../packages/shared/src/connector";
import { listedPrerequisites } from "../../../../packages/shared/src/host-prerequisites";
import type { HostInspection, HostState, LoginMethodType, PrerequisiteFix } from "../../../runner/src/app-host-protocol";
import { session } from "../lib/auth";
import { openExternal } from "../lib/links";
import { createAction } from "../lib/resource";
import {
  computerName, computerTitle, INSTALL_COMMAND, setUnsandboxedConsent, thisComputer, type LaunchProblem, type MacSandbox, type ThisComputerHost,
} from "../lib/this-computer";
import { Checkbox, Field, Select, TextField } from "../form";
import { Icon } from "../icons";
import { palette, type Tone } from "../theme";
import {
  Badge, Banner, Button, CardBody, CollapsibleRow, confirm, CopyField, Feedback, Note, Row, Section, Segmented, Small, Value,
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

export function ThisComputer(_props: SectionProps) {
  const { origin } = untracked(session);
  return (
    <ThisComputerPanel host={thisComputer()} server={origin}
      createPairing={async name => (await session().api<{ pairing: ConnectorPairing }>("/api/connectors/pairings", { method: "POST", body: { name } })).pairing} />
  );
}

function isolation(host: ThisComputerHost): string {
  const inspection = host.inspection();
  if (inspection?.unsupported) return inspection.unsupported;
  const running = host.running();
  const mode = running ? (running.unsandboxed ? "unsandboxed" : "sandboxed") : inspection?.mode;
  const sandbox = running ? running.sandbox : inspection?.sandbox;
  if (mode === "sandboxed") {
    return sandbox === "windows" ? "Sandboxed (Windows process containers, experimental)" : sandbox === "seatbelt" ? "Sandboxed (macOS Seatbelt, experimental)" : "Sandboxed (bubblewrap)";
  }
  return mode === "unsandboxed" ? "Unsandboxed, after your consent" : "Checking…";
}

function stateBadge(host: ThisComputerHost) {
  const failed = Boolean(host.error()) && host.state() === "stopped";
  const tone: Tone = host.state() === "connected" ? "success" : failed ? "danger" : host.state() === "stopped" ? "neutral" : "warning";
  return <Badge testID="this-computer-state" tone={tone} dot={host.state() === "connected"}>{failed ? "Stopped (error)" : stateLabels[host.state()]}</Badge>;
}

export function ThisComputerPanel(props: { host: ThisComputerHost; server: string; createPairing: (name: string) => Promise<{ id: string; code: string }> }) {
  const host = props.host;
  void host.load().then(() => host.refresh(props.server));
  return (
    <SectionPage testID="settings-this-computer">
      <If when={host.problem()}>{problem => <CommandProblem problem={problem()} host={host} server={props.server} />}</If>
      <If when={host.updating()}>
        <Section title="Pikibun's command" testID="this-computer-updating">
          <CardBody>
            <Banner tone="info" title={`Updating Pikibun's command on ${computerName}`}>
              {`Pikibun was updated, so npm is updating its pikibun command to match: this takes a minute, and ${computerTitle} hosts again once it is done. Its output is under Recent activity below.`}
            </Banner>
          </CardBody>
        </Section>
      </If>
      <ThisServerSection host={host} server={props.server} createPairing={props.createPairing} />
      <If when={host.inspection()}>
        <SandboxSection host={host} server={props.server} />
        <ModelsSection host={host} />
        <SignInSection host={host} />
        <PrerequisitesSection host={host} />
      </If>
      <ActivitySection host={host} server={props.server} />
    </SectionPage>
  );
}

function CommandProblem(props: { problem: LaunchProblem; host: ThisComputerHost; server: string }) {
  const host = props.host;
  const update = () => props.problem.kind === "outdated";
  const refresh = () => <Button small variant="outline" icon="refresh" label="Refresh" testID="this-computer-retry" disabled={host.inspecting() || host.installing()} onPress={() => void host.refresh(props.server)} />;
  const install = () => { if (!host.installing()) void host.install(props.server); };
  return (
    <Section title="Pikibun's command" testID="this-computer-command">
      <CardBody>
        <If when={props.problem.kind === "failed"}
          else={
            <Banner tone="warning" title={update() ? `Update Pikibun's command on ${computerName}` : `Install Pikibun's command on ${computerName}`} actions={refresh()}>
              {update()
                ? `${computerTitle}'s pikibun command is older than this app, which runs pikibun host. Update it from npm here.`
                : `${computerTitle} hosts sessions with the pikibun command, as pikibun connect does in a terminal. Install it from npm here: it needs Node.js 24 or newer (nodejs.org${computerTitle === "This Mac" ? ", or brew install node" : ""}).`}
            </Banner>
          }>
          <Banner tone="danger" title="The host could not start" actions={refresh()}>{(props.problem as { message: string }).message}</Banner>
        </If>
        <If when={props.problem.kind !== "failed"}>
          <View style={{ flexDirection: "row" }}>
            <Button variant="primary" icon="download" testID="this-computer-install-button" busy={host.installing()} disabled={host.installing() || host.inspecting()}
              label={host.installing() ? (update() ? "Updating pikibun" : "Installing pikibun") : update() ? "Update pikibun" : "Install pikibun"} onPress={install} />
          </View>
          <If when={host.installing()}><Small>npm is installing pikibun: this takes a minute. Its output is under Recent activity below.</Small></If>
          <If when={host.installError()}>
            <Feedback error={host.installError()} />
            <Small>To install it in a terminal instead:</Small>
            <CopyField testID="this-computer-install" value={INSTALL_COMMAND} label="Copy command" />
          </If>
        </If>
      </CardBody>
    </Section>
  );
}

function ThisServerSection(props: { host: ThisComputerHost; server: string; createPairing: (name: string) => Promise<{ id: string; code: string }> }) {
  const host = props.host;
  const name = signal(computerTitle === "This Mac" ? "My Mac" : "My computer");
  const action = createAction();
  const paired = () => host.inspection()?.pairedServer === props.server;
  const otherPairing = () => { const inspection = host.inspection(); return Boolean(inspection && !paired() && (inspection.pairedServer || inspection.pairingError)); };
  const elsewhere = () => { const running = host.running(); return running && running.server !== props.server ? running.server : null; };
  function pair() {
    if (action.busy() || !name().trim()) return;
    const hostName = name().trim();
    void action.run(async () => {
      const outcome = await host.start(props.server, { create: () => props.createPairing(hostName), replace: otherPairing() });
      if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't start.");
    }, `${computerTitle} is pairing with ${hostOf(props.server)}. It appears under Hosts once it is online.`);
  }
  function start() {
    void action.run(async () => {
      const outcome = await host.start(props.server);
      if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't start.");
    });
  }
  function stop() {
    void action.run(async () => {
      const outcome = await host.stop();
      if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't stop.");
    });
  }
  return (
    <Section title={`${computerTitle} and ${hostOf(props.server)}`} testID="this-computer-server"
      info={`${computerTitle} runs sessions for this server as one of your hosts, as pikibun connect does, while Pikibun is open. Its pairing is the command line's, so a computer paired with pikibun connect carries over; only one of them runs at a time.`}>
      <If when={host.inspection() || host.state() !== "stopped"} else={<Row title={host.problem() ? `${computerTitle} can't host yet` : `Checking ${computerName}…`} hint={host.problem() ? "Pikibun's command is needed first: see above." : undefined} />}>
        <If when={paired() || elsewhere() || host.state() !== "stopped"}
          else={
            <CardBody testID="this-computer-pair">
              <Small>{otherPairing()
                ? `${computerTitle} is paired elsewhere (${host.inspection()?.pairedServer ?? "an unreadable pairing"}). Pairing again replaces it; the old host stays in that Pikibun, offline, until you remove it there.`
                : `Pair ${computerName} with ${hostOf(props.server)} as your host in one step: no code to copy.`}</Small>
              <Field label="Host name">
                <TextField testID="this-computer-name" value={name()} onChange={value => name.set(value)} maxLength={120} onSubmit={pair} />
              </Field>
              <View style={{ flexDirection: "row" }}>
                <Button variant="primary" testID="this-computer-pair-button" label={action.busy() ? "Pairing" : `Pair ${computerTitle}`} busy={action.busy()}
                  disabled={!name().trim() || Boolean(host.inspection()?.unsupported)} onPress={pair} />
              </View>
              <Feedback error={action.error()} notice={action.notice()} />
            </CardBody>
          }>
          <Row title={elsewhere() ? `${computerTitle} is a host of ${hostOf(elsewhere()!)}` : `${computerTitle} is a host of ${hostOf(props.server)}`} hint={isolation(host)}
            trailing={stateBadge(host)} />
          <CardBody>
            <If when={host.error() && host.state() === "stopped"}><Banner tone="danger" title="The host stopped">{host.error()}</Banner></If>
            <If when={elsewhere()}>{other => <Small>{`It runs for ${other()}, the server it is paired with. Stop it to pair ${computerName} with ${hostOf(props.server)} instead.`}</Small>}</If>
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

function SandboxSection(props: { host: ThisComputerHost; server: string }) {
  const host = props.host;
  const action = createAction();
  const stopped = () => host.state() === "stopped";
  const change = (choice: MacSandbox) => {
    if (!stopped() || action.busy() || choice === host.sandbox()) return;
    void action.run(async () => {
      const outcome = await host.setSandbox(choice);
      if (!outcome.ok) throw new Error(outcome.error);
    });
  };
  return (
    <If when={computerTitle === "This Mac"}>
      <Section title="Sandbox" testID="this-computer-sandbox">
        <CardBody>
          <Segmented<MacSandbox> testID="this-computer-sandbox-choice" value={host.sandbox()} onChange={change}
            options={[{ value: "none", label: "None" }, { value: "seatbelt", label: "macOS sandbox" }]} />
          <Small>{host.sandbox() === "seatbelt"
            ? "Sessions run in macOS's own Seatbelt sandbox, which is experimental (macOS 15 or later with the developer tools: xcode-select --install), or without one, after your consent, while it isn't ready. Each session sees only its own files and reaches the network only through its egress proxy. macOS can't limit a session's memory or processes, so shell commands run only in your own sessions on this host."
            : "Sessions run directly as you on this Mac, after your consent at each start: its commands can read and change anything you can. Choose macOS sandbox to isolate them."}</Small>
          <If when={!stopped()}><Small>Stop the host to change where its sessions run.</Small></If>
          <Feedback error={action.error()} />
        </CardBody>
      </Section>
    </If>
  );
}

const modelKey = (model: { provider: string; modelId: string }) => `${model.provider}/${model.modelId}`;

function ModelsSection(props: { host: ThisComputerHost }) {
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
      info="Pikibun never receives your provider credentials: Pi keeps them on this computer. A change applies from the host's next start.">
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

function SignInSection(props: { host: ThisComputerHost }) {
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
    if (signIn.state === "done") return `Pi is signed in to ${signIn.name} on ${computerName}. Its models are listed above.`;
    if (signIn.state === "cancelled") return "Sign-in cancelled.";
    return signIn.error ?? "Sign-in failed.";
  };
  return (
    <Section title="Sign Pi in to a provider" testID="this-computer-sign-in"
      info="Pikibun runs Pi's own sign-in here, as Pi's /login does: the credential is saved in Pi's configuration on this computer and never sent to Pikibun. No separate Pi install is needed.">
      <CardBody>
        <If when={!host.providersError()} else={<Small>{`${host.providersError()} Choose Refresh once ${computerName} is ready.`}</Small>}>
          <If when={host.providers() === null || providers().length > 0} else={<Small>Pi on this computer offers no provider to sign in to.</Small>}>
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

function PrerequisitesSection(props: { host: ThisComputerHost }) {
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
    <Section title="Prerequisites" testID="this-computer-prerequisites">
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

function ActivitySection(props: { host: ThisComputerHost; server: string }) {
  const host = props.host;
  return (
    <Section title="Host" testID="this-computer-activity"
      action={<Button small variant="ghost" icon="refresh" label="Refresh" testID="this-computer-refresh" disabled={host.inspecting()} onPress={() => void host.refresh(props.server)} />}>
      <If when={host.inspection()?.stateDir}>{dir => <Row title="State directory" hint={<Value monospace>{dir()}</Value>} />}</If>
      <If when={host.inspection()?.pairedServer}>{server => <Row title="Paired with" trailing={server()} />}</If>
      <CollapsibleRow title="Recent activity" hint={host.logs().length ? undefined : "Nothing yet"} testID="this-computer-logs">
        <Each of={host.logs().slice(-50).reverse()} key="index">
          {line => (
            <Note>{`${new Date(line().time).toLocaleTimeString()} ${line().level === "info" ? "" : `${line().level}: `}${line().message}`}</Note>
          )}
        </Each>
      </CollapsibleRow>
    </Section>
  );
}
