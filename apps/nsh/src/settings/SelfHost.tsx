import { signal, untracked, View } from "nsh";
import type { ServerHostState, ServerState } from "../../../../packages/shared/src/app-server-protocol";
import { session, signOut } from "../lib/auth";
import { openExternal } from "../lib/links";
import { createAction } from "../lib/resource";
import { displayOrigin } from "../lib/server";
import { computerName, computerTitle, INSTALL_COMMAND, thisComputer } from "../lib/this-computer";
import { GITHUB_APP_PAGE, LOCAL_CALLBACK, LOCAL_HOMEPAGE, setServerConsent, thisServer, type ThisServer } from "../lib/this-server";
import { Field, TextField } from "../form";
import { type Tone } from "../theme";
import { Badge, Banner, Button, CardBody, CollapsibleRow, confirm, CopyField, Feedback, Note, Row, Section, Small, Value } from "../ui";
import { SectionPage, type SectionProps } from "./parts";

const stateLabels: Record<ServerState, string> = { stopped: "Stopped", starting: "Starting", running: "Running", stopping: "Stopping" };
const hostLabels: Record<ServerHostState, string> = {
  off: "Runs no sessions", waiting: "Waiting for your first sign-in", connecting: "Connecting", connected: "Online",
  disconnected: "Reconnecting", stopped: "Stopped", failed: "Could not start: see Recent activity",
};

setServerConsent(warning => confirm({
  title: `Run your sessions directly on ${computerName}?`,
  message: warning || "Commands run as you, as soon as the agent calls them, with access to your files, credentials and network, and no resource limits.",
  confirmLabel: "Run unsandboxed",
  destructive: true,
}));

export function SelfHost(_props: SectionProps) {
  const { origin } = untracked(session);
  return (
    <ThisServerPanel server={thisServer()} signedInTo={origin} onUse={async local => {
      if (!await confirm({ title: `Sign in to Pikibun on ${computerName}?`, confirmLabel: "Switch",
        message: `This app signs out of ${displayOrigin(origin)} and signs in to Pikibun on ${computerName} instead. Nothing moves: your sessions and workspaces on ${displayOrigin(origin)} stay there, and you can switch back by signing in to it again.` })) return;
      await signOut({ origin: local });
    }} />
  );
}

export function ThisServerPanel(props: { server: ThisServer; signedInTo?: string; onUse: (origin: string) => void | Promise<void> }) {
  const server = props.server;
  void server.load().then(() => server.refresh());
  return (
    <SectionPage testID="settings-self-host">
      <If when={server.problem()}>{problem => <CommandProblem kind={problem().kind} message={"message" in problem() ? (problem() as { message: string }).message : ""} server={server} />}</If>
      <If when={thisComputer().updating()}>
        <Section title="Pikibun's command" testID="self-host-updating">
          <CardBody>
            <Banner tone="info" title={`Updating Pikibun's command on ${computerName}`}>
              {`Pikibun was updated, so npm is updating its pikibun command to match: this takes a minute, and Pikibun on ${computerName} starts once it is done. Its output is under ${computerTitle}'s Recent activity.`}
            </Banner>
          </CardBody>
        </Section>
      </If>
      <ServerSection server={server} signedInTo={props.signedInTo} onUse={props.onUse} />
      <GitHubSection server={server} />
      <ActivitySection server={server} />
    </SectionPage>
  );
}

function CommandProblem(props: { kind: "missing" | "outdated" | "failed"; message: string; server: ThisServer }) {
  const host = thisComputer();
  const action = createAction();
  const update = () => props.kind === "outdated";
  const install = () => void action.run(async () => {
    const outcome = await host.install();
    await props.server.refresh();
    if (!outcome.ok && outcome.error && !host.installError()) throw new Error(outcome.error);
  });
  const refresh = () => <Button small variant="outline" icon="refresh" label="Refresh" testID="self-host-retry" disabled={props.server.inspecting() || host.installing()} onPress={() => void props.server.refresh()} />;
  return (
    <Section title="Pikibun's command" testID="self-host-command">
      <CardBody>
        <If when={props.kind === "failed"}
          else={
            <Banner tone="warning" title={update() ? `Update Pikibun's command on ${computerName}` : `Install Pikibun's command on ${computerName}`} actions={refresh()}>
              {update()
                ? `${computerTitle}'s pikibun command is older than this app, which runs pikibun serve --stdio. Update it from npm here.`
                : `Pikibun runs its server with the pikibun command, as pikibun serve does in a terminal. Install it from npm here: it needs Node.js 24 or newer (nodejs.org${computerTitle === "This Mac" ? ", or brew install node" : ""}).`}
            </Banner>
          }>
          <Banner tone="danger" title="Pikibun could not start" actions={refresh()}>{props.message}</Banner>
        </If>
        <If when={props.kind !== "failed"}>
          <View style={{ flexDirection: "row" }}>
            <Button variant="primary" icon="download" testID="self-host-install" busy={host.installing()} disabled={host.installing() || props.server.inspecting()}
              label={host.installing() ? (update() ? "Updating pikibun" : "Installing pikibun") : update() ? "Update pikibun" : "Install pikibun"} onPress={install} />
          </View>
          <If when={host.installing()}><Small>npm is installing pikibun: this takes a minute. Its output is under This Mac's Recent activity.</Small></If>
          <Feedback error={host.installError() || action.error()} />
          <If when={host.installError()}>
            <Small>To install it in a terminal instead:</Small>
            <CopyField value={INSTALL_COMMAND} label="Copy command" />
          </If>
        </If>
      </CardBody>
    </Section>
  );
}

function stateBadge(server: ThisServer) {
  const state = server.status().state;
  const failed = Boolean(server.error()) && state === "stopped";
  const tone: Tone = state === "running" ? "success" : failed ? "danger" : state === "stopped" ? "neutral" : "warning";
  return <Badge testID="self-host-state" tone={tone} dot={state === "running"}>{failed ? "Stopped (error)" : stateLabels[state]}</Badge>;
}

function ServerSection(props: { server: ThisServer; signedInTo?: string; onUse: (origin: string) => void | Promise<void> }) {
  const server = props.server;
  const action = createAction();
  const origin = () => server.running();
  const port = () => server.inspection()?.port ?? 7878;
  const hostHint = () => {
    const status = server.status();
    if (status.state !== "running") return server.inspection()?.hostProblem ?? `Once Pikibun runs, ${computerName} runs your sessions on it.`;
    if (status.host === "off") return server.inspection()?.hostProblem ?? hostLabels.off;
    return hostLabels[status.host];
  };
  function start() {
    void action.run(async () => {
      const outcome = await server.start(pendingGitHub());
      if (!outcome.ok) throw new Error(outcome.error ?? "Pikibun didn't start.");
      clearGitHub();
    });
  }
  function stop() {
    void action.run(async () => {
      const outcome = await server.stop();
      if (!outcome.ok) throw new Error(outcome.error ?? "Pikibun didn't stop.");
    });
  }
  return (
    <Section title={`Pikibun on ${computerName}`} testID="self-host-server"
      info={`Runs Pikibun's server on ${computerName} for you alone, as pikibun serve does in a terminal: reachable from this computer only, with ${computerName} as the host that runs your sessions. It runs while this app is open, and starts again at the next launch if it was running when the app quit.`}>
      <Row title="Your own Pikibun" hint={origin() ? displayOrigin(origin()!) : `Serves 127.0.0.1:${port()} on ${computerName}`} trailing={stateBadge(server)} />
      <Row title={`${computerTitle} as its host`} hint={hostHint()} testID="self-host-host" />
      <CardBody>
        <If when={server.error() && server.status().state === "stopped"}><Banner tone="danger" testID="self-host-error">{server.error()}</Banner></If>
        <If when={origin() && server.claimFor(origin()!)}>
          <Small testID="self-host-unclaimed">Nobody has signed in to it yet: the GitHub account you sign in with becomes its owner, and the only one that can sign in.</Small>
        </If>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <If when={server.status().state === "stopped"}
            else={<Button variant="outline" testID="self-host-stop" label="Stop" disabled={action.busy() || server.status().state !== "running"} onPress={stop} />}>
            <Button variant="primary" testID="self-host-start" label={action.busy() ? "Starting" : "Start Pikibun"} busy={action.busy()}
              disabled={Boolean(server.problem()) && server.problem()!.kind !== "failed"} onPress={start} />
          </If>
          <If when={origin() && origin() !== props.signedInTo}>
            <Button variant="primary" testID="self-host-use" label="Sign in to it" onPress={() => void props.onUse(origin()!)} />
          </If>
        </View>
        <If when={origin() && origin() === props.signedInTo}><Small testID="self-host-signed-in">This app is signed in to it.</Small></If>
        <Feedback error={action.error()} notice={action.notice()} />
      </CardBody>
    </Section>
  );
}

const githubId = signal("");
const githubSecret = signal("");
const replacing = signal(false);
function pendingGitHub() {
  const clientId = githubId().trim();
  const clientSecret = githubSecret().trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}
function clearGitHub() { githubSecret.set(""); replacing.set(false); }

function GitHubSection(props: { server: ThisServer }) {
  const server = props.server;
  const saved = () => server.inspection()?.githubClientId;
  const stopped = () => server.status().state === "stopped";
  return (
    <Section title="GitHub sign-in" testID="self-host-github"
      info={`Pikibun on ${computerName} signs you in with GitHub through an OAuth app of your own. Its client secret is kept with the server's private state on ${computerName}, and sent nowhere else.`}>
      <If when={saved() && !replacing()}
        else={
          <CardBody testID="self-host-github-form">
            <Small>Register an OAuth app once on GitHub with these two addresses (GitHub accepts the callback on any port of 127.0.0.1), generate a client secret, then enter both here.</Small>
            <Field label="Homepage URL"><CopyField value={LOCAL_HOMEPAGE} label="Copy" /></Field>
            <Field label="Authorization callback URL"><CopyField value={LOCAL_CALLBACK} label="Copy" /></Field>
            <View style={{ flexDirection: "row" }}>
              <Button small variant="outline" icon="external-link" label="Register it on GitHub" testID="self-host-github-open" onPress={() => openExternal(GITHUB_APP_PAGE)} />
            </View>
            <Field label="Client ID">
              <TextField testID="self-host-client-id" value={githubId()} onChange={value => githubId.set(value)} autoCapitalize="none" autoCorrect={false} monospace maxLength={100}
                placeholder="Ov23li…" disabled={!stopped()} />
            </Field>
            <Field label="Client secret">
              <TextField testID="self-host-client-secret" value={githubSecret()} onChange={value => githubSecret.set(value)} masked monospace maxLength={200} disabled={!stopped()} />
            </Field>
            <Small>{saved() ? "Saved, replacing the current app, when Pikibun next starts." : "Saved when Pikibun starts."}</Small>
            <If when={saved()}>
              <View style={{ flexDirection: "row" }}><Button small variant="ghost" label="Keep the current app" onPress={() => { clearGitHub(); githubId.set(""); }} /></View>
            </If>
          </CardBody>
        }>
        <Row title="OAuth app" hint={<Value monospace testID="self-host-github-saved">{saved()!}</Value>}
          trailing={<Button small variant="ghost" label="Replace" testID="self-host-github-replace" disabled={!stopped()} onPress={() => replacing.set(true)} />} />
      </If>
    </Section>
  );
}

function ActivitySection(props: { server: ThisServer }) {
  const server = props.server;
  return (
    <Section title="Server" testID="self-host-activity"
      action={<Button small variant="ghost" icon="refresh" label="Refresh" testID="self-host-refresh" disabled={server.inspecting()} onPress={() => void server.refresh()} />}>
      <If when={server.inspection()?.stateDir}>{dir => <Row title="State directory" hint={<Value monospace>{dir()}</Value>} />}</If>
      <CollapsibleRow title="Recent activity" hint={server.logs().length ? undefined : "Nothing yet"} testID="self-host-logs">
        <Each of={server.logs().slice(-50).reverse()} key="index">
          {line => <Note>{`${new Date(line().time).toLocaleTimeString()} ${line().level === "info" ? "" : `${line().level}: `}${line().message}`}</Note>}
        </Each>
      </CollapsibleRow>
    </Section>
  );
}
