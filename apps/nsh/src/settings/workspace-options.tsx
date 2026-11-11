import { effect, signal, View } from "nsh";
import type { Workspace } from "../shared";
import { segment } from "../shared";
import { transcriptPage, type ToolOutput } from "../../../../packages/shared/src/transcript-display";
import type { ChildSessionSettings as ChildSettings } from "../../../../packages/shared/src/cross-session";
import { automaticPackingDays, type PackingSettings as Packing } from "../../../../packages/shared/src/packing";
import { fileUploadLimits, formatBytes } from "../../../../packages/shared/src/file-uploads";
import { networkLimits, type NetworkMode, type NetworkPolicy } from "../../../../packages/shared/src/network";
import { session } from "../lib/auth";
import { createAction, createResource, type Action } from "../lib/resource";
import { Checkbox, CheckControl, Field, Select, TextField } from "../form";
import { Badge, Button, CardBody, Feedback, Note, ResourceState, Row, Section, Segmented } from "../ui";

function put(path: string, action: Action, refresh: () => void, body: Record<string, unknown>, notice: string) {
  void action.run(async () => {
    await session().api(path, { method: "PUT", body });
    refresh();
  }, notice);
}

function Toggle(props: { title: string; hint: string; label: string; value: boolean; admin: boolean; busy: boolean; onChange: (value: boolean) => void; testID?: string }) {
  return (
    <Row title={props.title} hint={props.hint}
      trailing={props.admin ? <CheckControl testID={props.testID} label={props.label} checked={props.value} disabled={props.busy} onChange={props.onChange} />
        : <Badge tone={props.value ? "success" : "neutral"}>{props.value ? "On" : "Off"}</Badge>} />
  );
}

const adminOnly = <Note>Only workspace owners and admins can change this.</Note>;

export function TranscriptSettings(props: { workspace: Workspace; admin: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/transcripts`;
  const resource = createResource<{ settings: { paging: boolean; toolOutput: ToolOutput } }>(path);
  const action = createAction();
  const settings = () => resource.data()?.settings;
  return (
    <Section title="Transcripts" info={<View style={{ gap: 8 }}>
      <If when={!props.admin}>{adminOnly}</If>
      <Note>{`With latest messages first, a session opens with the newest ${transcriptPage.size} entries of each conversation, and earlier ones load as you scroll up. Long sessions open much faster this way.`}</Note>
      <Note>Full tool output sets how new sessions here start: with every tool result in full, or with one line per tool result and long tool calls cut short. Each session's owner can still change their session's under its Details, and changing this leaves existing sessions as they are.</Note>
      <Note>Hosts still send Pikibun whole transcripts; these change only what reaches each viewer.</Note>
    </View>}>
      <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={settings()}>
          {current => (
            <>
              <Toggle title="Latest messages first" label="Load latest messages first" admin={props.admin} busy={action.busy()} value={current().paging}
                hint={current().paging ? `Sessions open with the newest ${transcriptPage.size} entries of each conversation` : "Sessions open with their whole transcript"}
                onChange={paging => put(path(), action, resource.refresh, { paging }, paging ? "Transcripts load latest messages first. Open sessions switch within a few seconds." : "Transcripts load whole again. Open sessions switch within a few seconds.")} />
              <Toggle title="Full tool output" label="Full tool output for new sessions" admin={props.admin} busy={action.busy()} value={current().toolOutput !== "brief"}
                hint={current().toolOutput !== "brief" ? "New sessions show every tool result in full" : "New sessions show one line per tool result"}
                onChange={full => put(path(), action, resource.refresh, { toolOutput: full ? "full" : "brief" }, full ? "New sessions start with full tool output. Existing sessions keep theirs." : "New sessions start with brief tool output. Existing sessions keep theirs.")} />
            </>
          )}
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

export function ChildSessionSettings(props: { workspace: Workspace; admin: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/child-sessions`;
  const resource = createResource<{ settings: ChildSettings }>(path);
  const action = createAction();
  return (
    <Section title="Sub-task sessions" info={<View style={{ gap: 8 }}>
      <If when={!props.admin}>{adminOnly}</If>
      <Note>A session's agent can start other sessions for sub-tasks with its sessions tool. With this on, it chooses each one's model, among those the person it works for can use here, and the reasoning level its first message runs at. What it leaves out is the same as its own session's.</Note>
      <Note>With this off, every session an agent starts runs on its parent session's current model and reasoning level. People still choose models and reasoning in any session's chat themselves.</Note>
    </View>}>
      <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={resource.data()}>
          {data => (
            <Toggle title="Agents choose models for sub-tasks" label="Let agents choose the model and reasoning level of sessions they start" admin={props.admin} busy={action.busy()}
              value={data().settings.childModels}
              hint={data().settings.childModels ? "Each session an agent starts runs on the model and reasoning level it chose for its task" : "Sessions agents start run on their parent's model and reasoning level"}
              onChange={next => put(path(), action, resource.refresh, { childModels: next }, next ? "Agents now choose the model and reasoning level of each session they start, to suit its task."
                : "Sessions that agents start now run on their parent session's model and reasoning level.")} />
          )}
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

export function PackingSettings(props: { workspace: Workspace; admin: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/packing`;
  const resource = createResource<{ settings: Packing }>(path);
  const action = createAction();
  return (
    <Section title="Archived sessions" info={<View style={{ gap: 8 }}>
      <If when={!props.admin}>{adminOnly}</If>
      <Note>{`An archived session's files stay on its host: its clones, their dependencies and caches, often tens of thousands of files. With this on, ${automaticPackingDays} days after a session is archived its host packs them into one compressed file, as its owner can sooner with Pack files.`}</Note>
      <Note>A pack keeps the clones' branches, uncommitted changes and ignored files such as .env files, and leaves out dependencies and build output (node_modules, .venv, dist and the like), which are installed again when needed. Unarchiving unpacks it. Sessions a pack can't keep in full, or whose host can't pack, are left as they are.</Note>
    </View>}>
      <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={resource.data()}>
          {data => (
            <Toggle title="Pack archived sessions" label="Pack archived sessions' files automatically" admin={props.admin} busy={action.busy()} value={data().settings.automatic}
              hint={data().settings.automatic ? `Their files are packed on their hosts ${automaticPackingDays} days after archiving` : "Their files stay as they are until their owners pack them"}
              onChange={next => put(path(), action, resource.refresh, { automatic: next }, next ? `Archived sessions' files are now packed ${automaticPackingDays} days after archiving.`
                : "Archived sessions' files now stay as they are until their owners pack them.")} />
          )}
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

const MB = 1024 * 1024;
const sizes = [1, 2, 5, 10, 20, 25, 50].map(value => value * MB).filter(value => value >= fileUploadLimits.minBytes && value <= fileUploadLimits.maxBytes);

export function AttachmentSettings(props: { workspace: Workspace; admin: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/attachments`;
  const resource = createResource<{ settings: { maxFileBytes: number } }>(path);
  const action = createAction();
  const limit = () => resource.data()?.settings.maxFileBytes;
  const options = () => (limit() === undefined || sizes.includes(limit()!) ? sizes : [...sizes, limit()!].sort((a, b) => a - b));
  return (
    <Section title="Attachments" info={<View style={{ gap: 8 }}>
      <If when={!props.admin}>{adminOnly}</If>
      <Note>{`Files attached to a message, other than the images the model looks at, are uploaded into the session's worktree, under attachments/, before the message is sent, and the message tells the agent where they are. This is the largest file one message may carry; it is ${formatBytes(fileUploadLimits.defaultBytes)} until changed, and at most ${formatBytes(fileUploadLimits.maxBytes)}.`}</Note>
    </View>}>
      <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={limit() !== undefined}>
          <Row title="Largest attached file" hint="Each file attached to a message, uploaded into the session's worktree"
            trailing={props.admin
              ? <Select<number> compact label="Largest attached file" value={limit()} disabled={action.busy()} options={options().map(value => ({ value, label: formatBytes(value) }))}
                onChange={next => { if (next !== limit()) put(path(), action, resource.refresh, { maxFileBytes: next }, `Files up to ${formatBytes(next)} can now be attached to messages here.`); }} />
              : <Badge>{formatBytes(limit()!)}</Badge>} />
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

const modeLabel: Record<NetworkMode, string> = { off: "Off", allowlist: "Allowlist", open: "Open" };
const modeHint: Record<NetworkMode, string> = {
  off: "Sandboxed commands reach only this workspace's repositories",
  allowlist: "The workspace's repositories, plus the domains below",
  open: "The workspace's repositories, plus any public host",
};

export function NetworkAccess(props: { workspace: Workspace; admin: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/network-policy`;
  const resource = createResource<{ policy: NetworkPolicy; packageRegistryDomains: string[] }>(path);
  const action = createAction();
  const mode = signal<NetworkMode>("off");
  const domains = signal("");
  const registries = signal(true);
  const saved = () => resource.data()?.policy;
  effect(() => {
    const policy = saved();
    if (!policy) return;
    mode.set(policy.mode);
    domains.set(policy.domains.join("\n"));
    registries.set(policy.packageRegistries);
  });
  const list = () => domains().split(/[\s,]+/).map(domain => domain.trim().toLowerCase()).filter(Boolean);
  const changed = () => Boolean(saved() && (mode() !== saved()!.mode || registries() !== saved()!.packageRegistries || list().join("\n") !== saved()!.domains.join("\n")));
  function save() {
    if (!props.admin || action.busy()) return;
    put(path(), action, resource.refresh, { mode: mode(), domains: list(), packageRegistries: registries() }, "Network access saved. Running sessions pick it up within a minute.");
  }
  return (
    <Section title="Network access" testID="workspace-network" info={<View style={{ gap: 8 }}>
      <If when={!props.admin}>{adminOnly}</If>
      <Note>Sandboxed shell commands have no direct network. Everything goes through the host's egress proxy: Git reads of this workspace's repositories always work, with the session owner's own account, which never leaves Pikibun.</Note>
      <Note>This setting decides what else is reachable over HTTPS. Addresses inside the host's own networks are never reachable. Hosts running without the sandbox aren't confined by it.</Note>
      <Note>Web search and page reading come from the workspace's extensions, which run on the host outside the sandbox: this setting doesn't confine them.</Note>
    </View>}>
      <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={saved()}>
          <Row title="Access" hint={modeHint[mode()]} trailing={props.admin
            ? <Segmented small value={mode()} onChange={value => mode.set(value)} options={(["off", "allowlist", "open"] as const).map(value => ({ value, label: modeLabel[value] }))} />
            : <Badge tone={saved()!.mode === "off" ? "neutral" : "success"}>{modeLabel[saved()!.mode]}</Badge>} />
          <If when={mode() === "allowlist"}>
            <CardBody>
              <Field label="Allowed domains" hint={`One per line, up to ${networkLimits.domains}. *.example.com allows its subdomains.`}>
                <TextField multiline monospace disabled={!props.admin} value={domains()} onChange={value => domains.set(value)} placeholder="docs.example.com" />
              </Field>
              <Checkbox label="Allow package registries (npm, PyPI, crates.io, Go, RubyGems, Maven, NuGet, Packagist)" checked={registries()} disabled={!props.admin}
                onChange={value => registries.set(value)} />
            </CardBody>
          </If>
          <If when={props.admin && (changed() || action.error() || action.notice())}>
            <CardBody>
              <Feedback error={action.error()} notice={action.notice()} />
              <If when={changed()}><View style={{ flexDirection: "row" }}><Button small variant="primary" label="Save network access" disabled={action.busy()} onPress={save} /></View></If>
            </CardBody>
          </If>
        </If>
      </ResourceState>
    </Section>
  );
}
