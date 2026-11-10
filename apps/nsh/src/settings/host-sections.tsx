import { computed, effect, signal, Text, untracked, View } from "nsh";
import type { ConnectorInfo, HostCommandGrant, LocalModelSummary } from "../../../../packages/shared/src/connector";
import {
  defaultHostConfig, hostConfigLimits, ownerOnlyHostConfig, type CompactionTokens, type HostCompaction, type HostConfig, type RepositoryCacheMode,
} from "../../../../packages/shared/src/host-config";
import type { HostCommandLevel } from "../../../../packages/shared/src/types";
import { memberPerson, segment, usernameWithId, type WorkspaceMember } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { timestamp } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import { palette, text } from "../theme";
import { Checkbox, Select, TextField } from "../form";
import { Badge, Button, CardBody, CollapsibleRow, confirm, Feedback, Note, Row, Section, Segmented, Small } from "../ui";
import { Card } from "./accounts";

const timeouts = [30, 60, 120, 300, 600, 1800, 3600];
const lifetimes = [900, 1800, 3600, 7200, 14_400, 28_800, 43_200, 86_400];

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "1 minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

const settings = (Object.keys(defaultHostConfig) as (keyof HostConfig)[]).filter(key => key !== "compaction" && key !== "builtinExtensions" && key !== "browser" && key !== "tunnel");

const cacheLabels: Record<RepositoryCacheMode, string> = { off: "Off", host: "Shared", owner: "Per owner" };
const cacheHints: Record<RepositoryCacheMode, string> = {
  off: "Each session downloads its clones itself",
  host: "One mirror of each repository, which every session's clones borrow from",
  owner: "A separate mirror of each repository for each session owner",
};

const configInfo = (
  <View style={{ gap: 8 }}>
    <Note>How this host runs sessions. Its owner and admins change the command time limit and the GPU; only its owner decides whether it uses its Git credentials, keeps a repository cache, runs their sessions without the sandbox or trusts a fake-IP proxy on it.</Note>
    <Note>Running sessions pick up a change within a minute. A repository cache change applies when the host's connector next connects.</Note>
    <Note>The service lifetime bounds a session service: a server a session keeps running after the call that started it, such as the one the tunnel tool puts online. It stops then, and goes offline.</Note>
    <Note>A longer time limit also lifts the per-process limits of short commands (25 seconds of CPU, 64 MiB files, 256 open files) so builds fit. Without provisioned resource limits on the host (connect --resources), a command can use the whole machine for that long.</Note>
  </View>
);

export function HostConfigSection(props: { connector: ConnectorInfo; refresh: () => void }) {
  const owner = () => props.connector.role !== "admin";
  const saved = () => props.connector.config ?? defaultHostConfig;
  const config = signal<HostConfig>(untracked(saved));
  let shown = untracked(saved);
  effect(() => {
    const next = saved();
    untracked(() => {
      const replaced = settings.filter(key => next[key] !== shown[key]);
      shown = next;
      if (replaced.length) config.update(current => ({ ...current, ...Object.fromEntries(replaced.map(key => [key, next[key]])) }));
    });
  });
  const action = createAction();
  const changes = () => settings.filter(key => config()[key] !== saved()[key] && (owner() || !ownerOnlyHostConfig.includes(key)));
  const editable = () => !props.connector.revokedAt && !action.busy();
  const capabilities = () => props.connector.capabilities;
  const set = (change: Partial<HostConfig>) => config.update(current => ({ ...current, ...change }));
  async function save() {
    const next = config();
    const before = saved();
    const name = props.connector.name;
    if (next.gitCredentials && !before.gitCredentials && !await confirm({ title: "Use this host's Git credentials?", confirmLabel: "Turn on", destructive: true,
      message: `Pushes in your own sessions on ${name} will use the credentials Git on that machine would use (its credential helpers), wherever a workspace's push access chooses the host's Git credentials. Other members' sessions never use them.` })) return;
    if (next.repositoryCache !== "off" && before.repositoryCache === "off" && !await confirm({ title: "Keep a repository cache on this host?", confirmLabel: "Keep a cache",
      message: `${name} will keep a full mirror of each repository its sessions clone, in its state directory, and their clones will borrow objects from it. It fills the mirrors straight from the repositories' hosts with the credentials Git on that machine would use (its credential helpers), and a session borrows from one only once Pikibun confirms that the session's owner can read the repository with their own account.` })) return;
    if (next.hostSessions && !before.hostSessions && capabilities().ownerHostSessions && !await confirm({ title: "Let members' sessions run directly on this host?", confirmLabel: "Allow", destructive: true,
      message: `Members you grant sessions on the host under Host command access will be able to start sessions on ${name} without the sandbox. Their commands then run as that machine's user, with its files, credentials, network and GPU, and no resource limits, and only you, or members you granted host commands, decide them. Members without that grant stay in the sandbox. Your own sessions can run on the host either way.` })) return;
    if (next.hostSessions && !before.hostSessions && !capabilities().ownerHostSessions && !await confirm({ title: "Let your sessions run directly on this host?", confirmLabel: "Allow", destructive: true,
      message: `When you start a session on ${name}, you'll be able to run it without the sandbox. Its commands then run as that machine's user, with its files, credentials, network and GPU, and no resource limits, and only you, or members you granted host commands, decide them. Other members' sessions stay in the sandbox, and so do yours unless you choose otherwise when you start one.` })) return;
    if (next.fakeIpTunnels && !before.fakeIpTunnels && !await confirm({ title: "Trust this host's fake-IP proxy for every host?", confirmLabel: "Trust it", destructive: true,
      message: `Sessions on ${name} will reach any host their workspace's network policy allows even where ${name}'s DNS answers with a local proxy's fake-IP addresses (198.18.0.0/15, as Clash, mihomo, sing-box or Surge give in a fake-IP or TUN mode). Pikibun can't check where that proxy then connects: a name a session picks that really points at this machine or its local network (its router, a NAS, an intranet) is reached on port 443 through it. Without this, only hosts the policy names exactly and package registries go through such addresses.` })) return;
    if (next.gpu && !before.gpu && !await confirm({ title: "Lend this host's GPU to sandboxed commands?", confirmLabel: "Lend GPU", destructive: true,
      message: `Shell commands in every session on ${name} will be able to use its GPU for rendering and compute. They get its render device only, never the screen, windows or input, but its driver is more of the kernel exposed to them, and they share the GPU with everything else on the machine.` })) return;
    await action.run(async () => {
      await session().api(`/api/connectors/${segment(props.connector.id)}/config`, { method: "PATCH", body: Object.fromEntries(changes().map(key => [key, next[key]])) });
      props.refresh();
    }, "Configuration saved. Running sessions pick it up within a minute.");
  }
  const choices = () => [...new Set([...timeouts, saved().commandTimeoutSeconds])].sort((a, b) => a - b);
  const lifetimeChoices = () => [...new Set([...lifetimes, saved().serviceLifetimeSeconds])].sort((a, b) => a - b);
  const gpuHint = () => (capabilities().unsandboxed ? "Commands on an unsandboxed host already run on the machine itself"
    : !capabilities().gpu ? "No GPU render device found on this host (WSL's /dev/dxg or Linux render nodes)"
    : `${capabilities().gpu === "dxg" ? "WSL GPU (/dev/dxg)" : "Linux render nodes (/dev/dri)"}: rendering and compute, never the screen, windows or input`);
  return (
    <Section title="Configuration" info={configInfo} testID="host-configuration">
      <Row title="Command time limit" hint={capabilities().unsandboxed ? "How long a shell command may run before it is stopped" : "How long a shell command may run in the sandbox before it is stopped"}
        trailing={<Select<number> compact label="Command time limit" value={config().commandTimeoutSeconds} disabled={!editable()}
          options={choices().map(seconds => ({ value: seconds, label: duration(seconds), ...(seconds === defaultHostConfig.commandTimeoutSeconds ? { hint: "Default" } : {}) }))}
          onChange={value => set({ commandTimeoutSeconds: value })} />} />
      <If when={!capabilities().unsandboxed}>
        <Row title="Service lifetime" hint="The longest a session's server keeps running after the call that started it, online through its tunnel, before it is stopped"
          trailing={<Select<number> compact label="Service lifetime" value={config().serviceLifetimeSeconds} disabled={!editable()}
            options={lifetimeChoices().map(seconds => ({ value: seconds, label: duration(seconds), ...(seconds === defaultHostConfig.serviceLifetimeSeconds ? { hint: "Default" } : {}) }))}
            onChange={value => set({ serviceLifetimeSeconds: value })} />} />
      </If>
      <Row title="GPU" hint={gpuHint()} trailing={<Checkbox label="Lend to sandboxed commands" checked={config().gpu}
        disabled={!editable() || (!config().gpu && (!capabilities().gpu || capabilities().unsandboxed))} onChange={gpu => set({ gpu })} />} />
      <Row title="Git credentials" hint={owner() ? "Pushes in your own sessions may use this machine's Git credential helpers, where a workspace's push access chooses the host's Git credentials" : "Only the host's owner changes this"}
        trailing={owner() ? <Checkbox label="Use for my pushes" checked={config().gitCredentials} disabled={!editable()} onChange={gitCredentials => set({ gitCredentials })} />
          : <Badge tone={saved().gitCredentials ? "warning" : "neutral"}>{saved().gitCredentials ? "On" : "Off"}</Badge>} />
      <Row title="Repository cache" hint={owner() ? `${cacheHints[config().repositoryCache]}. Applies when the host next connects.` : "Only the host's owner changes this"}
        trailing={owner() && editable()
          ? <Segmented small value={config().repositoryCache} onChange={repositoryCache => set({ repositoryCache })}
            options={(["off", "host", "owner"] as const).map(value => ({ value, label: cacheLabels[value] }))} />
          : <Badge tone={saved().repositoryCache === "off" ? "neutral" : "success"}>{cacheLabels[saved().repositoryCache]}</Badge>} />
      <Row title="Sessions on the host" hint={capabilities().unsandboxed ? "This host runs every session without the sandbox"
        : !owner() ? "Only the host's owner changes this"
        : capabilities().ownerHostSessions ? "You may always start sessions that run directly on this machine, without the sandbox, as its user. Members you grant it under Host command access may too while this is on. Turning it off stops their commands within half a minute"
        : "You, and members you grant it under Host command access, may start sessions that run directly on this machine, without the sandbox, as its user. Turning it off stops their commands within half a minute"}
        trailing={capabilities().unsandboxed ? <Badge tone="danger">Every session</Badge>
          : owner() ? <Checkbox label={capabilities().ownerHostSessions ? "Allow members' sessions on the host" : "Allow sessions on the host"} checked={config().hostSessions} disabled={!editable()} onChange={hostSessions => set({ hostSessions })} />
          : <Badge tone={saved().hostSessions ? "danger" : "neutral"}>{saved().hostSessions ? "On" : "Off"}</Badge>} />
      <If when={!capabilities().unsandboxed}>
        <Row title="Fake-IP proxy" hint={!owner() ? "Only the host's owner changes this"
          : !capabilities().fakeIpTunnels ? "This host's connector predates this setting: update it (npx pikibun@latest connect) for it to apply"
          : "Where this machine's DNS answers with a local proxy's fake-IP addresses (198.18.0.0/15: Clash, mihomo, sing-box, Surge), sessions reach any host the network policy allows through them, not only hosts it names exactly and package registries. That proxy then connects where Pikibun can't check"}
          trailing={owner() ? <Checkbox label="Trust for every host" checked={config().fakeIpTunnels} disabled={!editable() || (!config().fakeIpTunnels && !capabilities().fakeIpTunnels)}
            onChange={fakeIpTunnels => set({ fakeIpTunnels })} />
            : <Badge tone={saved().fakeIpTunnels ? "warning" : "neutral"}>{saved().fakeIpTunnels ? "On" : "Off"}</Badge>} />
      </If>
      <If when={!capabilities().hostConfig}>
        <Row title="Update the host's connector" hint="This host's connector predates configuration in Pikibun and keeps its connect options until it is updated (npx pikibun@latest connect). What you save here applies then." />
      </If>
      <If when={changes().length > 0 || action.error() || action.notice()}>
        <CardBody>
          <Feedback error={action.error()} notice={action.notice()} />
          <If when={changes().length > 0}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button small variant="primary" label="Save configuration" disabled={action.busy()} onPress={() => void save()} testID="host-config-save" />
              <Button small variant="ghost" label="Discard" disabled={action.busy()} onPress={() => config.set(saved())} />
            </View>
          </If>
        </CardBody>
      </If>
    </Section>
  );
}

type Draft = { reserveTokens: string; keepRecentTokens: string };
type Drafts = { overall: Draft; models: Record<string, Draft> };
const tokenKeys = ["reserveTokens", "keepRecentTokens"] as const;
const emptyDraft: Draft = { reserveTokens: "", keepRecentTokens: "" };
const draft = (tokens: CompactionTokens | undefined): Draft => ({ reserveTokens: tokens?.reserveTokens?.toString() ?? "", keepRecentTokens: tokens?.keepRecentTokens?.toString() ?? "" });
const drafts = (compaction: HostCompaction): Drafts => ({ overall: draft(compaction), models: Object.fromEntries(Object.entries(compaction.modelOverrides ?? {}).map(([model, tokens]) => [model, draft(tokens)])) });

function count(value: string): number | null | undefined {
  const digits = value.trim().replace(/[,_\s]/g, "");
  if (!digits) return null;
  if (!/^\d{1,9}$/.test(digits)) return undefined;
  const parsed = Number(digits);
  return parsed <= hostConfigLimits.compactionTokens.max ? parsed : undefined;
}

function tokens(value: Draft): CompactionTokens | undefined {
  const result: CompactionTokens = {};
  for (const key of tokenKeys) {
    const parsed = count(value[key]);
    if (parsed === undefined) return undefined;
    if (parsed !== null) result[key] = parsed;
  }
  return result;
}

function compactionOf(value: Drafts): HostCompaction | undefined {
  const overall = tokens(value.overall);
  if (!overall) return undefined;
  const overrides: Record<string, CompactionTokens> = {};
  for (const model of Object.keys(value.models).sort()) {
    const own = tokens(value.models[model]!);
    if (!own) return undefined;
    if (Object.keys(own).length) overrides[model] = own;
  }
  return Object.keys(overrides).length ? { ...overall, modelOverrides: overrides } : overall;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function TokenInputs(props: { value: Draft; onChange: (value: Draft) => void; disabled: boolean; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
      <Each of={tokenKeys}>
        {key => (
          <View style={{ gap: 2, width: 104 }}>
            <Text style={{ fontSize: text.caption, color: palette().muted }}>{key() === "reserveTokens" ? "Reserve" : "Keep recent"}</Text>
            <TextField compact keyboardType="number-pad" placeholder="Host's Pi" value={props.value[key()]} disabled={props.disabled}
              accessibilityLabel={`${key() === "reserveTokens" ? "Reserve" : "Keep recent"} tokens, ${props.label}`}
              onChange={value => props.onChange({ ...props.value, [key()]: value })} />
          </View>
        )}
      </Each>
    </View>
  );
}

export function HostCompactionSection(props: { connector: ConnectorInfo; refresh: () => void }) {
  const saved = () => props.connector.config?.compaction ?? {};
  const savedJson = computed(() => JSON.stringify(saved()));
  const value = signal<Drafts>(drafts(untracked(saved)));
  let shown = untracked(savedJson);
  effect(() => {
    const json = savedJson();
    untracked(() => { if (json !== shown) { shown = json; value.set(drafts(JSON.parse(json) as HostCompaction)); } });
  });
  const action = createAction();
  const editable = () => Boolean(props.connector.role) && !props.connector.revokedAt && !action.busy();
  const current = () => compactionOf(value());
  const changed = () => current() === undefined || JSON.stringify(current()) !== savedJson();
  const offered = () => [...props.connector.models, ...(props.connector.disabledModels ?? [])]
    .sort((a, b) => byCodeUnit(a.provider, b.provider) || byCodeUnit(a.modelId, b.modelId));
  const others = () => {
    const keys = new Set(offered().map(model => `${model.provider}/${model.modelId}`));
    return Object.keys(value().models).filter(model => !keys.has(model)).sort(byCodeUnit);
  };
  const overridden = () => Object.keys(current()?.modelOverrides ?? {}).length;
  function save() {
    const next = current();
    if (!next) return;
    void action.run(async () => {
      await session().api(`/api/connectors/${segment(props.connector.id)}/config`, { method: "PATCH", body: { compaction: next } });
      props.refresh();
    }, "Compaction saved. Sessions on the host pick it up within a minute.");
  }
  const modelRow = (model: LocalModelSummary | string) => {
    const key = typeof model === "string" ? model : `${model.provider}/${model.modelId}`;
    return (
      <Row title={typeof model === "string" ? model : model.name} hint={typeof model === "string" ? "Not offered by this host now" : `${model.provider} / ${model.modelId}`}
        trailing={<TokenInputs label={key} value={value().models[key] ?? emptyDraft} disabled={!editable()}
          onChange={own => value.update(form => ({ ...form, models: { ...form.models, [key]: own } }))} />} />
    );
  };
  return (
    <Section title="Compaction" testID="host-compaction" info={<View style={{ gap: 8 }}>
      <Note>Pi summarizes a long conversation once it comes within reserve tokens of the model's context window, and keeps the most recent keep-recent tokens word for word. The summary may use up to 80% of the reserve, thinking included.</Note>
      <Note>Counts set here replace those of Pi's settings.json on the host (compaction.reserveTokens, compaction.keepRecentTokens and compaction.modelOverrides); an empty one keeps the host's setting, or the default. A model's own count wins over the one for all models, here or in the host's settings.</Note>
      <Note>By default a reasoning model reserves a tenth of its context window, from 16K to 64K tokens. If messages fail because Pi's summary hit its token limit, raise the reserve for that model.</Note>
      <Note>Sessions on the host pick up a change within a minute, from the next message they send after it.</Note>
    </View>}>
      <Row title="All models" hint="Tokens kept free for compaction, and recent tokens kept unsummarized. Empty keeps the host's Pi setting"
        trailing={<TokenInputs label="all models" value={value().overall} disabled={!editable()} onChange={overall => value.update(form => ({ ...form, overall }))} />} />
      <If when={offered().length + others().length > 0}>
        <CollapsibleRow title="Per model" hint={overridden() ? `${overridden()} ${overridden() === 1 ? "model has its" : "models have their"} own counts` : "Counts for one model, over those for all models"}>
          <Card>
            <Each of={offered()} key={model => `${model.provider}/${model.modelId}`}>{model => modelRow(model())}</Each>
            <Each of={others()}>{model => modelRow(model())}</Each>
          </Card>
        </CollapsibleRow>
      </If>
      <If when={props.connector.capabilities.hostConfig && !props.connector.capabilities.compactionConfig}>
        <Row title="Update the host's connector" hint="This host's connector predates compaction settings in Pikibun and follows its Pi settings alone until it is updated (npx pikibun@latest connect). What you save here applies then." />
      </If>
      <If when={changed() || action.error() || action.notice()}>
        <CardBody>
          <Feedback error={action.error()} notice={action.notice()} />
          <If when={!current()}><Small>{`Token counts are whole numbers from 0 to ${hostConfigLimits.compactionTokens.max}.`}</Small></If>
          <If when={changed()}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button small variant="primary" label="Save compaction" disabled={action.busy() || !current()} onPress={save} />
              <Button small variant="ghost" label="Discard" disabled={action.busy()} onPress={() => value.set(drafts(saved()))} />
            </View>
          </If>
        </CardBody>
      </If>
    </Section>
  );
}

const levelLabels: Record<HostCommandLevel, { label: string; hint: string }> = {
  approve: { label: "Approve host commands", hint: "Decides each host command in sessions they can approve" },
  auto: { label: "Auto-approve host commands", hint: "Also runs the host commands of their own Auto-approve messages without asking" },
};
const expiries = [
  { value: "never", label: "No expiry", days: 0 }, { value: "1", label: "1 day", days: 1 }, { value: "7", label: "7 days", days: 7 }, { value: "30", label: "30 days", days: 30 },
] as const;
type Expiry = (typeof expiries)[number]["value"];
const EVERYONE = "*";

function createMembers(workspaceId: () => string | undefined) {
  return createResource<{ members: WorkspaceMember[] }>(() => { const id = workspaceId(); return id ? `/api/workspaces/${segment(id)}/members` : null; });
}

export function HostAdminsSection(props: { connector: ConnectorInfo; refresh: () => void }) {
  const data = useAppData();
  const { user } = untracked(session);
  const action = createAction();
  const owner = () => props.connector.role === "owner";
  const admins = () => props.connector.admins ?? [];
  const connected = () => data.workspaces().filter(workspace => (props.connector.connectedWorkspaceIds ?? props.connector.workspaceIds).includes(workspace.id));
  const workspaceId = signal("");
  const source = () => connected().find(workspace => workspace.id === workspaceId()) ?? connected()[0];
  const members = createMembers(() => (owner() ? source()?.id : undefined));
  const candidates = () => (members.data()?.members ?? []).filter(member => member.userId !== props.connector.ownerId && !admins().some(admin => admin.userId === member.userId));
  const userId = signal("");
  const chosen = () => candidates().find(member => member.userId === userId()) ?? candidates()[0];
  async function add() {
    const member = chosen();
    if (!member) return;
    if (!await confirm({ title: `Make ${usernameWithId(memberPerson(member))} an admin?`, confirmLabel: "Add admin", destructive: true,
      message: `They will manage ${props.connector.name}'s sharing: share it with workspaces you both belong to, and grant members host commands there, including themselves. Host commands run on your machine with your files, credentials and network. They will also choose which of its models it offers, to everyone including you. Only you can add admins, revoke or remove the host.` })) return;
    await action.run(async () => {
      await session().api(`/api/connectors/${segment(props.connector.id)}/admins/${segment(member.userId)}`, { method: "PUT", body: {} });
      props.refresh();
    }, "Admin added.");
  }
  async function remove(adminId: string) {
    const self = adminId === user.id;
    if (!await confirm({ title: self ? "Stop managing this host?" : "Remove this admin?", confirmLabel: self ? "Step down" : "Remove admin",
      message: self ? "You will no longer manage its sharing. Grants already given stay until someone removes them." : "They will no longer manage its sharing. Grants they gave stay until someone removes them." })) return;
    await action.run(async () => {
      await session().api(`/api/connectors/${segment(props.connector.id)}/admins/${segment(adminId)}`, { method: "DELETE" });
      props.refresh();
    }, self ? "You no longer manage this host." : "Admin removed.");
  }
  return (
    <Section title="Admins" testID="host-admins" info="Admins manage this host's sharing for you: its workspace shares and host command grants, and which of its models it offers. They hold no host command access of their own unless a grant gives it to them, and only the owner can add admins, revoke or remove the host.">
      <If when={admins().length > 0} else={<Row title="No admins" hint={owner() ? "Only you manage this host" : undefined} />}>
        <Each of={admins()} key={admin => admin.userId}>
          {admin => (
            <Row title={admin().name || admin().userId} hint={`Admin since ${timestamp(admin().createdAt)}`}
              trailing={owner() || admin().userId === user.id
                ? <Button small variant="outline" label={admin().userId === user.id ? "Step down" : "Remove"} disabled={action.busy()} onPress={() => void remove(admin().userId)} />
                : undefined} />
          )}
        </Each>
      </If>
      <If when={owner() && !props.connector.revokedAt}>
        <If when={connected().length > 0} else={<Row title="Add admin" hint="Connect the host to a workspace first" />}>
          <Row title="Add admin" hint={members.loading() ? "Loading members…" : !candidates().length ? `No other members in ${source()?.name ?? "this workspace"}` : "A member of a workspace this host is connected to"}
            trailing={<>
              <If when={connected().length > 1}>
                <Select<string> compact label="Workspace" value={source()?.id} options={connected().map(workspace => ({ value: workspace.id, label: workspace.name }))}
                  onChange={value => { workspaceId.set(value); userId.set(""); }} disabled={action.busy()} />
              </If>
              <If when={candidates().length > 0}>
                <Select<string> compact label="Member" value={chosen()?.userId} options={candidates().map(member => ({ value: member.userId, label: usernameWithId(memberPerson(member)) }))}
                  onChange={value => userId.set(value)} disabled={action.busy()} />
              </If>
              <Button small variant="outline" label="Add" disabled={action.busy() || !chosen()} onPress={() => void add()} />
            </>} />
        </If>
      </If>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

export function HostCommandGrantsSection(props: { connector: ConnectorInfo; refresh: () => void }) {
  const data = useAppData();
  const action = createAction();
  const owner = () => props.connector.role === "owner";
  const grants = () => props.connector.hostGrants ?? [];
  const names = () => new Map(data.workspaces().map(workspace => [workspace.id, workspace.name]));
  const shared = () => data.workspaces().filter(workspace => props.connector.workspaceIds.includes(workspace.id));
  const workspaceId = signal("");
  const target = () => shared().find(workspace => workspace.id === workspaceId()) ?? shared()[0];
  const members = createMembers(() => target()?.id);
  const eligible = () => (members.data()?.members ?? []).filter(member => member.userId !== props.connector.ownerId && member.role !== "viewer");
  const grantee = signal(EVERYONE);
  const level = signal<HostCommandLevel>("approve");
  const expiry = signal<Expiry>("7");
  const capabilities = () => props.connector.capabilities;
  const accepting = () => props.connector.config?.hostSessions === true && !capabilities().unsandboxed;
  const unlimited = () => !capabilities().productionShell && !capabilities().unsandboxed;
  const lendsShell = () => unlimited() && capabilities().unboundedShellGrants === true;
  const outdatedSessions = () => owner() && grants().some(item => item.hostSessions) && capabilities().hostGrants && !capabilities().hostSessionGrants;
  const member = () => eligible().find(item => item.userId === grantee());
  const who = () => (member() ? usernameWithId(memberPerson(member()!)) : `every member of ${target()?.name ?? "the workspace"}`);
  const existing = () => grants().find(item => item.workspaceId === target()?.id && (item.userId ?? EVERYONE) === (member()?.userId ?? EVERYONE));
  const grantKey = () => `${target()?.id ?? ""}:${member()?.userId ?? EVERYONE}`;
  const sessionsChoice = signal<{ key: string; value: boolean } | null>(null);
  const sessions = () => (sessionsChoice()?.key === grantKey() ? sessionsChoice()!.value : existing()?.hostSessions === true);
  async function grant() {
    const workspace = target();
    if (!workspace) return;
    const auto = level() === "auto";
    const withSessions = owner() && sessions();
    const dropsSessions = owner() && !sessions() && existing()?.hostSessions === true;
    const name = props.connector.name;
    if (!await confirm({
      title: withSessions ? "Grant sessions on the host?" : auto ? "Grant automatic host commands?" : "Grant host command approval?",
      message: (auto
        ? `${who()} will be able to run host commands on ${name}, such as its extensions' tools, OUTSIDE the sandbox without anyone approving each command, whenever they send a message with Auto-approve. Commands run on the owner's machine as its user, with its files, credentials and network, and no resource limits.`
        : `${who()} will be able to approve host commands on ${name}, such as its extensions' tools, which run OUTSIDE the sandbox on the owner's machine with its files, credentials and network.`)
        + (withSessions ? ` They will also be able to start their own sessions directly on ${name}, without the sandbox: every command of those sessions runs as its user${auto ? ", without asking under their Auto-approve" : ", once approved"}, and their clones use its Git and credentials.` : "")
        + (lendsShell() ? ` As ${name} has no resource limits for commands, the shell commands of their own sandboxed sessions will run there without them too${auto ? ", without asking under their Auto-approve" : ", each once approved like a host command"}.` : "")
        + (dropsSessions ? ` This replaces their current grant, which includes sessions on the host: they will no longer start sessions directly on ${name}, and the next command of any they have there will stop.` : ""),
      confirmLabel: "Grant", destructive: auto || withSessions,
    })) return;
    const days = expiries.find(item => item.value === expiry())!.days;
    await action.run(async () => {
      await session().api(`/api/connectors/${segment(props.connector.id)}/host-grants/${segment(workspace.id)}`, { method: "PUT", body: {
        ...(member() ? { userId: member()!.userId } : {}), level: level(), ...(owner() ? { hostSessions: sessions() } : {}),
        ...(days ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
      } });
      sessionsChoice.set(null);
      props.refresh();
    }, "Host command access granted.");
  }
  function revoke(item: HostCommandGrant) {
    void action.run(async () => {
      const query = item.userId ? `?userId=${encodeURIComponent(item.userId)}` : "";
      await session().api(`/api/connectors/${segment(props.connector.id)}/host-grants/${segment(item.workspaceId)}${query}`, { method: "DELETE" });
      props.refresh();
    }, "Host command access removed.");
  }
  return (
    <Section title="Host command access" testID="host-grants" info="Host commands, such as the tools of this host's extensions, run OUTSIDE the sandbox, on this machine as its user. By default only the owner decides those commands. Grant members of a shared workspace the right to approve them, or to run their own without asking under Auto-approve. The owner may also let them start their own sessions directly on the host, without the sandbox. On a host without resource limits, a grant also lets the member's own sandboxed sessions run shell commands without them, decided like host commands. Grants end when they expire, when you remove them, or when the host stops being shared there.">
      <If when={grants().length > 0} else={<Row title="Only the owner" hint="No one else decides host commands on this host" />}>
        <Each of={grants()} key={item => `${item.workspaceId}:${item.userId ?? ""}`}>
          {item => (
            <Row title={`${item().userId ? item().userName ?? item().userId : "All members"} · ${names().get(item().workspaceId) ?? item().workspaceId}`}
              hint={`${levelLabels[item().level].hint}${item().hostSessions ? " · may start sessions on the host" : ""}${item().expiresAt ? ` · expires ${timestamp(item().expiresAt!)}` : " · no expiry"}`}
              trailing={<>
                <Badge tone={item().level === "auto" ? "warning" : "neutral"}>{item().level === "auto" ? "Auto-approve" : "Approve"}</Badge>
                <If when={item().hostSessions}><Badge tone="danger">Sessions on host</Badge></If>
                <Button small variant="outline" label="Remove" disabled={action.busy()} onPress={() => revoke(item())} />
              </>} />
          )}
        </Each>
      </If>
      <If when={!props.connector.revokedAt}>
        <If when={shared().length > 0} else={<Row title="Grant access" hint="Share the host with a workspace first" />}>
          <Row title="Grant access" hint={members.loading() ? "Loading members…" : levelLabels[level()].hint} trailing={<>
            <If when={shared().length > 1}>
              <Select<string> compact label="Workspace" value={target()?.id} options={shared().map(workspace => ({ value: workspace.id, label: workspace.name }))}
                onChange={value => { workspaceId.set(value); grantee.set(EVERYONE); }} disabled={action.busy()} />
            </If>
            <Select<string> compact label="Member" value={member() ? member()!.userId : EVERYONE} disabled={action.busy()} onChange={value => grantee.set(value)}
              options={[{ value: EVERYONE, label: "All members" }, ...eligible().map(item => ({ value: item.userId, label: usernameWithId(memberPerson(item)) }))]} />
            <Select<HostCommandLevel> compact label="Access" value={level()} disabled={action.busy()} onChange={value => level.set(value)}
              options={(["approve", "auto"] as const).map(value => ({ value, label: levelLabels[value].label }))} />
            <If when={owner() && !capabilities().unsandboxed}>
              <Checkbox label="Sessions on the host" checked={sessions()} disabled={action.busy()} onChange={value => sessionsChoice.set({ key: grantKey(), value })}
                hint={accepting() ? undefined : "Applies once Configuration → Sessions on the host is on"} />
            </If>
            <Select<Expiry> compact label="Expires" value={expiry()} disabled={action.busy()} onChange={value => expiry.set(value)}
              options={expiries.map(item => ({ value: item.value, label: item.label }))} />
            <Button small variant="outline" label="Grant" disabled={action.busy() || !target()} onPress={() => void grant()} />
          </>} />
        </If>
      </If>
      <If when={owner() && grants().some(item => item.hostSessions) && !accepting()}>
        <Row title="Sessions on the host are off" hint="Grants that include sessions on the host apply only while Configuration → Sessions on the host is on." />
      </If>
      <If when={outdatedSessions()}>
        <Row title="Update the host's connector" hint="This host's connector runs only your own sessions on the host: until it is updated (npx pikibun@latest connect), members you granted that get the sandbox." />
      </If>
      <If when={!outdatedSessions() && grants().length > 0 && unlimited() && capabilities().hostGrants && !capabilities().unboundedShellGrants}>
        <Row title="Update the host's connector" hint="This host has no resource limits, and its connector refuses every command of other members' sandboxed sessions: until it is updated (npx pikibun@latest connect), the members you granted host commands can't run commands, or clone, in their own." />
      </If>
      <If when={!capabilities().hostGrants}>
        <Row title="Update the host's connector" hint="This host's connector predates grants: until it is updated (npx pikibun@latest connect), only the owner decides its host commands." />
      </If>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

export function ModelsSection(props: { connector: ConnectorInfo; refresh: () => void; modelKey: (model: LocalModelSummary) => string }) {
  const action = createAction();
  const disabled = () => new Set((props.connector.disabledModels ?? []).map(props.modelKey));
  const models = () => [...props.connector.models, ...(props.connector.disabledModels ?? [])]
    .sort((a, b) => byCodeUnit(a.provider, b.provider) || byCodeUnit(a.modelId, b.modelId));
  const manage = () => Boolean(props.connector.role) && !props.connector.revokedAt;
  function setEnabled(model: LocalModelSummary, enabled: boolean) {
    if (action.busy() || !manage()) return;
    void action.run(async () => {
      await session().api(`/api/connectors/${segment(props.connector.id)}/models`, { method: "PATCH", body: { provider: model.provider, modelId: model.modelId, enabled } });
      props.refresh();
    }, enabled ? `${model.name} enabled.` : `${model.name} disabled. No new session or message can use it.`);
  }
  return (
    <Section title="Models" testID="host-models" info={<View style={{ gap: 8 }}>
      <Note>The models Pi on this host offers. Configure providers and models in Pi on the host; credentials never leave it.</Note>
      <Note>The owner and admins can disable a model: no session starts from it and no message switches to it, for everyone who uses this host, the owner included, in every workspace. Sessions already on it keep their history and continue on another model.</Note>
    </View>}>
      <If when={models().length > 0} else={<Row title="No models advertised" hint="Configure models in Pi on the host" />}>
        <Each of={models()} key={model => props.modelKey(model)}>
          {model => (
            <Row title={model().name} hint={`${model().provider} / ${model().modelId}`}
              trailing={<Checkbox label="Enabled" checked={!disabled().has(props.modelKey(model()))} disabled={!manage() || action.busy()}
                onChange={value => setEnabled(model(), value)} />} />
          )}
        </Each>
      </If>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

