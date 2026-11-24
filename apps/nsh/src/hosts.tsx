import { View } from "nsh";
import type { ConnectorInfo } from "../../../packages/shared/src/connector";
import { hardwareSummary } from "../../../packages/shared/src/hardware";
import { createResource, type Resource } from "./lib/resource";
import type { Tone } from "./theme";
import { Badge, Banner, CollapsibleRow, Note } from "./ui";

export function createConnections(path: () => string | null): Resource<{ connectors: ConnectorInfo[] }> {
  return createResource<{ connectors: ConnectorInfo[] }>(path, 10_000);
}

type HostState = "Revoked" | "Offline" | "Unsandboxed" | "Sandbox unverified" | "Online";

export function hostState(connector: ConnectorInfo): HostState {
  return connector.revokedAt ? "Revoked" : !connector.online ? "Offline" : connector.capabilities.unsandboxed ? "Unsandboxed" : !connector.capabilities.sandbox ? "Sandbox unverified" : "Online";
}

export function hostTone(connector: ConnectorInfo): Tone {
  const state = hostState(connector);
  return state === "Online" ? "success" : state === "Unsandboxed" ? "danger" : "warning";
}

export function ConnectionStatus(props: { connector: ConnectorInfo }) {
  return <Badge tone={hostTone(props.connector)} dot={hostState(props.connector) === "Online"}>{hostState(props.connector)}</Badge>;
}

export function HostCapabilities(props: { connector: ConnectorInfo }) {
  return (
    <View style={{ gap: 8 }}>
      <UnsandboxedHost connector={props.connector} />
      <CollapsibleRow plain title="Host details" hint={props.connector.capabilities.platform || "Unknown platform"}>
        <HostDetails connector={props.connector} />
      </CollapsibleRow>
    </View>
  );
}

export function UnsandboxedHost(props: { connector: ConnectorInfo }) {
  return (
    <If when={props.connector.capabilities.unsandboxed}>
      <Banner collapsible tone="danger" title="Unsandboxed host">Agent work runs directly on the owner's machine without isolation: commands and commits run as their user, as soon as the agent calls them, with access to their files, credentials and network, and no resource limits. File tools are confined to the session folder by path checks only, except read, which takes a host path in a message that may run commands.</Banner>
    </If>
  );
}

export function HostDetails(props: { connector: ConnectorInfo }) {
  const capabilities = () => props.connector.capabilities;
  const config = () => props.connector.config;
  return (
    <>
      <Note>{`Platform: ${capabilities().platform || "Unknown"}.${!props.connector.online ? " Offline: it must reconnect before work can run." : ""}`}</Note>
      <Note>{props.connector.hardware ? `Hardware: ${hardwareSummary(props.connector.hardware)}.` : "Hardware: not reported; connectors report it from this release on."}</Note>
      <Note>{`Sandbox: ${capabilities().unsandboxed ? "disabled by the host owner." : !capabilities().sandbox ? "unverified (not necessarily unavailable): the host's isolation self-test didn't pass when it connected, or it runs an experimental sandbox or an older connector; the runner still checks isolation when preparing each session." : "the host's isolation self-test passed when it connected; reported by the host, not a security attestation."} Resource limits for commands: ${capabilities().productionShell ? "reported; still verified per session." : "not confirmed."}`}</Note>
      <If when={config()?.gitCredentials || capabilities().gitCredentials}><Note>Git credentials: offered by the host owner for pushes in their own sessions, where a workspace's push access uses the host's Git credentials.</Note></If>
      <If when={capabilities().repositoryCache}><Note>Repository cache: this host fetches repositories into its own cache with the host owner's Git credentials, after Pikibun confirms that the session's owner can read them with their own account.</Note></If>
      <If when={config() && config()!.buildCaches !== "off" && capabilities().buildCaches}>
        <Note>{config()?.buildCaches === "workspace"
          ? "Build caches: this host keeps workspaces' build caches. Sessions of a workspace's owner, admins and collaborators who can write files share one copy of each; everyone else's get their own."
          : "Build caches: this host keeps workspaces' build caches, a separate copy for each session owner."}</Note>
      </If>
      <If when={(config()?.hostSessions || capabilities().ownerHostSessions) && capabilities().hostConfig && !capabilities().unsandboxed}>
        <Note>{capabilities().ownerHostSessions
          ? `Sessions on the host: its owner${config()?.hostSessions ? ", and members they grant it," : ""} may start sessions that run directly on it, without the sandbox.`
          : "Sessions on the host: its owner may start sessions that run directly on it, without the sandbox."}</Note>
      </If>
      <If when={config()?.fakeIpTunnels && capabilities().fakeIpTunnels && !capabilities().unsandboxed}><Note>Fake-IP proxy: its owner trusts a local proxy's fake-IP addresses for every host a workspace's network policy allows, where Pikibun can't check where that proxy connects.</Note></If>
      <If when={config() && capabilities().hostConfig}>
        <Note>{`Commands: ${config()?.commandTimeoutUnlimited ? "no time limit" : `stopped after ${config()?.commandTimeoutSeconds} seconds`}${config()?.gpu && capabilities().gpu ? `, with the host's GPU (${capabilities().gpu === "dxg" ? "WSL /dev/dxg" : "render nodes"})` : ""}.`}</Note>
      </If>
      <If when={capabilities().hostMigration}><Note>Moves: this host accepts sessions moved to it from another connected host.</Note></If>
      <Note>The runner verifies prerequisites for every session and stops work that fails. Commands (what git, node, python and the other program tools run) need verified CPU, memory, process and storage limits in everyone's sessions. Without them, commands run unlimited, still inside the sandbox, only in the host owner's own sessions and those of members they grant host commands.</Note>
      <Note>Native Windows is unsupported: use Linux or WSL2 with Pi configured there, or macOS without isolation.</Note>
    </>
  );
}
