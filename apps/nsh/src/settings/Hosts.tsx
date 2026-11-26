import { computed, effect, signal, untracked, View } from "nsh";
import type { ConnectorInfo, ConnectorPairing } from "../../../../packages/shared/src/connector";
import type { WorkspaceRepositoryList } from "../../../../packages/shared/src/repositories";
import { modelKey, segment, type Workspace } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { timestamp } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import { ConnectionStatus, createConnections, HostCapabilities, hostTone } from "../hosts";
import { CheckControl, Field, TextField } from "../form";
import {
  Badge, Banner, Button, CardBody, CollapsibleRow, confirm, CopyField, EmptyState, Feedback, FormSheet, IconButton, Note, ResourceState, Row, Section, Small, StatusDot,
} from "../ui";
import { Card } from "./accounts";
import { HostAdminsSection, HostCommandGrantsSection, HostCompactionSection, HostConfigSection, ModelsSection } from "./host-sections";
import { HostExtensionsSection } from "./host-extensions";
import { SectionPage, type SectionProps } from "./parts";

const hostsInfo = "Hosts are the Pis you pair. A paired host is yours, not a workspace's: it runs a dedicated app runtime you can use in every workspace you belong to, and stays private to you until you share it with one. Whoever operates a host sees the prompts and repository files processed on it, including private source, but never receives a GitHub token. Model credentials stay in Pi on the host. Status refreshes every 10 seconds.";

const count = (value: number, singular: string, plural: string) => `${value} ${value === 1 ? singular : plural}`;
const modelCount = (connector: ConnectorInfo) => {
  const disabled = connector.disabledModels?.length ?? 0;
  return `${count(connector.models.length, "model", "models")}${disabled ? `, ${disabled} disabled` : ""}`;
};

export function Hosts(props: SectionProps) {
  const resource = createConnections(() => "/api/connectors");
  return (
    <If when={!props.id}
      else={<HostDetail id={props.id!} connectors={resource.data()?.connectors ?? null} loading={resource.loading()} error={resource.error()} refresh={resource.refresh} go={props.go} />}>
      <HostList connectors={resource.data()?.connectors ?? []} loading={resource.loading() && !resource.data()} error={resource.error()} refresh={resource.refresh} go={props.go} />
    </If>
  );
}

function HostList(props: { connectors: ConnectorInfo[]; loading: boolean; error: string; refresh: () => void; go: SectionProps["go"] }) {
  const pairing = signal(false);
  const empty = () => !props.loading && !props.error && !props.connectors.length;
  return (
    <SectionPage testID="settings-hosts">
      <Section title="Hosts" info={hostsInfo} bare={empty()}
        action={props.connectors.length ? <Button small variant="outline" icon="plus" label="Pair a host" testID="pair-host" onPress={() => pairing.set(true)} /> : undefined}>
        <ResourceState inline loading={props.loading} error={props.error} retry={props.refresh}>
          <If when={!empty()} else={<EmptyState title="No hosts yet" action={<Button variant="primary" icon="plus" label="Pair a host" testID="pair-host" onPress={() => pairing.set(true)} />} />}>
            <Each of={props.connectors} key={connector => connector.id}>
              {connector => (
                <Row testID={`host-row-${connector().id}`} leading={<StatusDot tone={hostTone(connector())} />} title={connector().name} chevron
                  hint={`${connector().role === "admin" ? `${connector().ownerName}'s host, you are an admin · ` : ""}${modelCount(connector())} · ${connector().workspaceIds.length ? `Shared with ${count(connector().workspaceIds.length, "workspace", "workspaces")}` : "Private"}`}
                  trailing={<ConnectionStatus connector={connector()} />}
                  onPress={() => props.go({ name: "settings", section: "hosts", id: connector().id })} />
              )}
            </Each>
          </If>
        </ResourceState>
      </Section>
      <SharedWithYou />
      <PairHostSheet open={pairing()} onClose={() => pairing.set(false)} refresh={props.refresh} go={props.go} />
    </SectionPage>
  );
}

function SharedWithYou() {
  const data = useAppData();
  return (
    <Section title="Shared with you" testID="hosts-shared" info="Hosts other members shared into your workspaces. You can run your own sessions on them; their operator sees your prompts and repository files. Agents, session permissions and GitHub credentials are not shared.">
      <If when={data.workspaces().length > 0} else={<Row title="Nothing shared with you" hint="Hosts members share into your workspaces appear here" />}>
        <Each of={data.workspaces()} key={workspace => workspace.id}>{workspace => <WorkspaceSharedHosts workspace={workspace()} />}</Each>
      </If>
    </Section>
  );
}

function WorkspaceSharedHosts(props: { workspace: Workspace }) {
  const { user } = untracked(session);
  const resource = createConnections(() => `/api/workspaces/${segment(props.workspace.id)}/connectors`);
  const shared = () => (resource.data()?.connectors ?? []).filter(connector => connector.ownerId !== user.id);
  return (
    <If when={!resource.error()}
      else={<Row leading={<StatusDot tone="danger" />} title={`Unable to load hosts for ${props.workspace.name}`} hint={resource.error()}
        trailing={<Button small variant="outline" label="Try again" onPress={resource.refresh} />} />}>
      <If when={resource.data() && !shared().length}><Row title={props.workspace.name} hint="No hosts shared with you here" /></If>
      <Each of={shared()} key={connector => connector.id}>
        {connector => (
          <CollapsibleRow leading={<StatusDot tone={hostTone(connector())} />} title={connector().name} hint={`${connector().ownerName} · ${props.workspace.name}`}
            trailing={<ConnectionStatus connector={connector()} />}>
            <HostCapabilities connector={connector()} />
            <Small>{connector().models.length ? connector().models.map(model => model.name).join(", ") : "No models offered"}</Small>
          </CollapsibleRow>
        )}
      </Each>
    </If>
  );
}

function PairHostSheet(props: { open: boolean; onClose: () => void; refresh: () => void; go: SectionProps["go"] }) {
  const data = useAppData();
  const name = signal("");
  const pairing = signal<ConnectorPairing | null>(null);
  const expired = signal(false);
  const action = createAction();
  effect(() => {
    const current = pairing();
    if (!current) return;
    const timer = setTimeout(() => { pairing.set(null); expired.set(true); }, Math.max(0, new Date(current.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  });
  function create() {
    if (action.busy() || !name().trim()) return;
    pairing.set(null);
    expired.set(false);
    void action.run(async () => {
      const result = await session().api<{ pairing: ConnectorPairing }>("/api/connectors/pairings", { method: "POST", body: { name: name().trim() } });
      pairing.set(result.pairing);
    });
  }
  function done() {
    pairing.set(null);
    props.refresh();
    props.onClose();
  }
  const workspace = () => data.workspaces().find(item => item.id === data.lastWorkspaceId()) ?? data.workspaces()[0] ?? null;
  const createLabel = () => (action.busy() ? "Creating code…" : pairing() ? "Create another code" : "Create pairing code");
  return (
    <FormSheet open={props.open} wide title="Pair a host" onClose={props.onClose} testID="pair-host-sheet"
      footer={<If when={pairing()} else={<Button variant="primary" label={createLabel()} disabled={action.busy() || !name().trim()} onPress={create} testID="pair-create" />}>
        <Button variant="outline" label={createLabel()} disabled={action.busy() || !name().trim()} onPress={create} />
        <Button variant="primary" label="Done" onPress={done} />
      </If>}>
      <Field label="Host name" hint="The host is yours: you can use it in every workspace you belong to, and it stays private to you until you share it with one">
        <TextField testID="pair-host-name" value={name()} onChange={value => name.set(value)} maxLength={120} placeholder="My Linux workstation" onSubmit={create} />
      </Field>
      <Feedback error={action.error()} />
      <If when={expired()}><Banner tone="warning" title="Pairing code expired">The code was cleared. Create a new code to try again.</Banner></If>
      <If when={pairing()}>
        {current => (
          <View style={{ gap: 16 }}>
            <Small>{`Code ready. Expires ${timestamp(current().expiresAt)}`}</Small>
            <Field label="Run this on your host">
              <CopyField value={`npx pikibun@latest connect --server ${session().origin} --pairing-id ${current().id}`} label="Copy command" />
            </Field>
            <Field label="Paste at the hidden prompt, not on the command line"><CopyField testID="pair-code" value={current().code} label="Copy code" /></Field>
            <Note>Single-use secret: don't share it. It is held only in this app's memory. Hiding it doesn't revoke it; an unused code stays valid until it expires.</Note>
            <If when={workspace()}>
              {target => <Button small variant="ghost" label={`Start a session in ${target().name}`} onPress={() => { done(); props.go({ name: "new", workspaceId: target().id }); }} />}
            </If>
          </View>
        )}
      </If>
      <CollapsibleRow plain title="Host requirements">
        <Note>Linux or WSL2 (native Windows is unsupported) with Node.js 24, Pi configured there with its providers and models, and bubblewrap, Python 3, Git and flock installed.</Note>
        <Note>No app checkout is needed; run from any folder. Session source downloads into private caches. Never paste a token into this app or a command.</Note>
        <Note>macOS has no sandbox: add --unsafe-no-sandbox to run agent work directly on your Mac as your user, with only Git required. The connector asks you to confirm, and Pikibun labels the host Unsandboxed: approved commands run with access to your files, credentials and network, and no resource limits.</Note>
      </CollapsibleRow>
    </FormSheet>
  );
}

function HostDetail(props: { id: string; connectors: ConnectorInfo[] | null; loading: boolean; error: string; refresh: () => void; go: SectionProps["go"] }) {
  const connector = () => props.connectors?.find(item => item.id === props.id);
  return (
    <SectionPage testID="host-detail">
      <View style={{ flexDirection: "row", marginLeft: -8, marginBottom: -16 }}>
        <Button small variant="ghost" icon="chevron-left" label="Hosts" testID="hosts-back" onPress={() => props.go({ name: "settings", section: "hosts" })} />
      </View>
      <ResourceState inline loading={props.loading && !props.connectors} error={props.error} retry={props.refresh}>
        <If when={connector()} else={<EmptyState title="Host not found" />}>
          <Each of={[props.id]} key={id => id}>{() => <HostSections connector={connector()!} connectorOf={connector} refresh={props.refresh} go={props.go} />}</Each>
        </If>
      </ResourceState>
    </SectionPage>
  );
}

function HostSections(props: { connector: ConnectorInfo; connectorOf: () => ConnectorInfo | undefined; refresh: () => void; go: SectionProps["go"] }) {
  const data = useAppData();
  const connector = () => props.connectorOf() ?? props.connector;
  const share = createAction();
  const revokeAction = createAction();
  const reconnecting = signal(false);
  const pairing = signal(false);
  const owner = () => connector().role !== "admin";
  const associated = () => [...new Set([...(connector().connectedWorkspaceIds ?? []), ...connector().workspaceIds])];
  const sharingRows = (): ShareTarget[] => {
    if (data.workspacesLoading()) return [];
    const listed = data.workspaces().filter(workspace => !workspace.personal || associated().includes(workspace.id));
    const known = new Set(listed.map(workspace => workspace.id));
    return [
      ...listed.map(workspace => ({ id: workspace.id, name: workspace.name, personal: Boolean(workspace.personal) })),
      ...associated().filter(id => !known.has(id)).map(id => ({ id, name: id, personal: false })),
    ];
  };
  const sharedCount = () => sharingRows().filter(row => connector().workspaceIds.includes(row.id)).length;
  const shareable = () => sharingRows().filter(row => !row.personal).length;
  async function remove() {
    if (!await confirm({ title: `Permanently remove ${connector().name}?`, confirmLabel: "Remove permanently", destructive: true,
      message: "This permanently removes the host from your list, invalidates its credentials and stops sharing it in all workspaces. Existing sessions and their historical host references remain, but cannot run on this host. Local files are not deleted. To use this machine again, pair it as a new host." })) return;
    await revokeAction.run(async () => {
      await session().api(`/api/connectors/${segment(connector().id)}/permanent`, { method: "DELETE" });
      props.go({ name: "settings", section: "hosts" });
      props.refresh();
    });
  }
  async function revoke() {
    if (!await confirm({ title: `Revoke ${connector().name}?`, confirmLabel: "Revoke host", destructive: true,
      message: "This disconnects its runtime and blocks work in every connected workspace, including your own sessions. Pair again to reconnect; existing session records are not deleted." })) return;
    await revokeAction.run(async () => {
      await session().api(`/api/connectors/${segment(connector().id)}`, { method: "DELETE" });
      props.refresh();
    }, "Host revoked.");
  }
  return (
    <>
      <Section title="Status" bare>
        <View style={{ gap: 8 }}>
          <Card>
            <Row title="Status" trailing={<ConnectionStatus connector={connector()} />} />
            <If when={owner() && !connector().online}>
              <Row title={connector().revokedAt ? "Pair again" : "Reconnect host"}
                hint={connector().revokedAt ? "Revoked credentials cannot be reused; create a new pairing" : "Restart the saved connection on your host machine"}
                trailing={<Button small variant="outline" label={connector().revokedAt ? "Pair again" : "Reconnect"} disabled={revokeAction.busy()}
                  onPress={() => (connector().revokedAt ? pairing.set(true) : reconnecting.set(true))} />} />
            </If>
            <Row title="Owner" trailing={connector().ownerName} />
            <Row title="Connector" hint={connector().version ? undefined : "Connectors from 0.23 and older don't report it. Update with npx pikibun@latest connect"}
              trailing={connector().version ?? "Not reported"} />
            <Row title="Paired" trailing={timestamp(connector().createdAt)} />
            <If when={connector().revokedAt}><Row title="Revoked" trailing={timestamp(connector().revokedAt!)} /></If>
          </Card>
          <HostCapabilities connector={connector()} />
        </View>
      </Section>
      <ModelsSection connector={connector()} refresh={props.refresh} modelKey={modelKey} />
      <Section title="Sharing" testID="host-sharing" info="Turn sharing on for a workspace to let its members run their own sessions on this host; you will see their prompts and repository snapshots. Turn it off to stop them: the host stays connected for your own use and existing session records are unchanged. Agents, session permissions and GitHub credentials are not shared, and personal Pi history is never imported."
        action={shareable() ? <Badge testID="host-sharing-summary" tone={sharedCount() ? "success" : "neutral"}>{sharedCount() ? `Shared with ${sharedCount()} of ${shareable()}` : "Private"}</Badge> : undefined}>
        <If when={sharingRows().length > 0}
          else={data.workspacesLoading() ? <Row title="Loading workspaces…" />
            : <Row title="No workspaces yet" hint="Create or join a workspace and add a source to it to share this host with its members" chevron
              onPress={() => props.go({ name: "settings", section: "workspaces" })} />}>
          <Each of={sharingRows()} key={row => row.id}>
            {row => <ShareToggleRow connector={connector()} target={row()} owner={owner()} busy={share.busy()} run={share.run} refresh={props.refresh} />}
          </Each>
        </If>
        <If when={share.error() || share.notice()}><CardBody><Feedback error={share.error()} notice={share.notice()} /></CardBody></If>
      </Section>
      <HostConfigSection connector={connector()} refresh={props.refresh} />
      <If when={connector().config}><HostCompactionSection connector={connector()} refresh={props.refresh} /></If>
      <If when={connector().role}><HostExtensionsSection connector={connector()} refresh={props.refresh} go={props.go} /></If>
      <If when={connector().capabilities.hostCommands}><HostCommandGrantsSection connector={connector()} refresh={props.refresh} /></If>
      <HostAdminsSection connector={connector()} refresh={props.refresh} />
      <Section title="Details">
        <CardBody><Field label="Connection ID"><CopyField value={connector().id} label="Copy connection ID" /></Field></CardBody>
      </Section>
      <If when={owner()}>
        <Section title="Danger zone" testID="host-danger">
          <Row title="Revoke host" hint={connector().revokedAt ? `Revoked ${timestamp(connector().revokedAt!)}` : "Disconnects its runtime and blocks work in every connected workspace"}
            trailing={!connector().revokedAt ? <Button small variant="outline" label={revokeAction.busy() ? "Revoking…" : "Revoke"} disabled={revokeAction.busy()} onPress={() => void revoke()} /> : undefined} />
          <Row title="Permanently remove host" hint="Remove from Pikibun and invalidate access. Session history and local files are retained."
            trailing={<Button small variant="outline" label="Remove permanently" disabled={revokeAction.busy()} onPress={() => void remove()} />} />
          <If when={revokeAction.error() || revokeAction.notice()}><CardBody><Feedback error={revokeAction.error()} notice={revokeAction.notice()} /></CardBody></If>
        </Section>
      </If>
      <PairHostSheet open={pairing()} onClose={() => pairing.set(false)} refresh={props.refresh} go={props.go} />
      <FormSheet open={reconnecting()} title={`Reconnect ${connector().name}`} onClose={() => reconnecting.set(false)}
        footer={<Button label="Done" onPress={() => { props.refresh(); reconnecting.set(false); }} />}>
        <Banner tone={connector().online ? "success" : "warning"} title={connector().online ? "Host is connected" : "Start the connection on your host"}>
          Pikibun cannot remotely start an offline host. If you use the desktop app, open it on the host and start its connection. For a CLI host, run the command below on the original machine with its saved pairing.
        </Banner>
        <Field label="Run on your host">
          <CopyField value={`npx pikibun@latest connect${connector().capabilities.unsandboxed ? " --unsafe-no-sandbox" : ""}`} label="Copy reconnect command" />
        </Field>
        <Note>Use the same OS user and any original options of the machine's own setup: --state-dir, --resources, --pi-agent-dir and --model. Everything else is this host's Configuration, here. Do not add --pairing-id or --force: the saved credentials preserve this host and its sessions. Stop any existing connector before starting another. Status refreshes every 10 seconds.</Note>
        <Note>If the saved pairing is missing, pair a new host instead. A new pairing does not reconnect this host's existing sessions.</Note>
        <Button variant="outline" label="Refresh status" onPress={props.refresh} />
      </FormSheet>
    </>
  );
}

interface ShareTarget { id: string; name: string; personal: boolean }

function ShareToggleRow(props: { connector: ConnectorInfo; target: ShareTarget; owner: boolean; busy: boolean;
  run: (task: () => Promise<void>, notice?: string) => Promise<boolean>; refresh: () => void | Promise<void> }) {
  const pending = signal<boolean | null>(null);
  const shared = () => props.connector.workspaceIds.includes(props.target.id);
  const revoked = () => Boolean(props.connector.revokedAt);
  const checked = () => pending() ?? shared();
  const sourcesPath = computed(() => (shared() || revoked() || props.target.personal ? null : `/api/workspaces/${segment(props.target.id)}/repositories`));
  const repositories = createResource<WorkspaceRepositoryList>(sourcesPath);
  const listed = () => (repositories.error() ? null : repositories.data());
  const configured = () => Boolean(listed() && (listed()!.repositories.length || listed()!.sources || !listed()!.required));
  const blocked = () => !shared() && !configured();
  async function change(on: boolean) {
    if (props.busy || on === shared()) return;
    const name = props.target.name;
    if (on) {
      if (!configured()) return;
      if (props.connector.capabilities.unsandboxed && !await confirm({ title: "Share an unsandboxed host?", confirmLabel: "Share host", destructive: true,
        message: `Share an unsandboxed Pi with ${name}? Commands of members you grant host commands will run directly on your machine as your user, with access to your files, credentials and network, and no resource limits.` })) return;
    } else if (!await confirm({ title: `Stop sharing with ${name}?`, confirmLabel: "Stop sharing",
      message: `Other members' sessions can no longer run work on this host in ${name}. It stays connected for ${props.owner ? "your" : "its owner's"} own use; existing session records are unchanged.` })) return;
    pending.set(on);
    try {
      await props.run(async () => {
        await session().api(`/api/connectors/${segment(props.connector.id)}/shares/${segment(props.target.id)}`, on ? { method: "PUT", body: {} } : { method: "DELETE" });
        await props.refresh();
      }, on ? `Shared with ${name}. Session permissions are unchanged; personal Pi history is not imported.`
        : `Stopped sharing with ${name}. ${props.owner ? "Your" : "The owner's"} private connection remains available.`);
    } finally {
      pending.set(null);
    }
  }
  const hint = () => {
    if (props.target.personal) return `Private workspace: only ${props.owner ? "you use" : "its owner uses"} this host here`;
    if (shared()) return "On: members can run their own sessions on this host";
    if (revoked()) return "Off: revoked hosts can't be shared";
    if (repositories.loading() && !repositories.data()) return "Off · Checking sources…";
    if (repositories.error()) return `Off · ${repositories.error()}`;
    if (!configured()) return "Off · No sources yet. Ask an owner or admin to add one before sharing";
    return `Off: ${props.owner ? "your" : "the owner's"} use only`;
  };
  return (
    <Row testID={`host-share-${props.target.id}`} title={props.target.name} hint={hint()}
      trailing={props.target.personal ? <Badge>Private</Badge> : <>
        <If when={!shared() && !revoked() && (repositories.error() || (listed() && !configured()))}>
          <IconButton icon="refresh" label={`Check ${props.target.name}'s sources again`} size={28} disabled={props.busy} onPress={repositories.refresh} />
        </If>
        <CheckControl testID={`host-share-toggle-${props.target.id}`} label={`Share this host with ${props.target.name}`} checked={checked()}
          disabled={props.busy || (revoked() && !shared()) || (!checked() && blocked())} onChange={value => void change(value)} />
      </>} />
  );
}
