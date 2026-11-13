import { computed, effect, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { Switch } from "nsh/base";
import {
  AUTO_TASK_LIMIT, canCreateSessions, chatOptionsBody, errorMessage, preferredSelection, segment, type AccessMode, type AutoChoiceAnswer,
  type AutoChoiceRequest, type ChatSelection, type ConnectorInfo, type ModelDefinition, type SessionRecord, type ThinkingLevel, type Workspace,
  type WorkspaceRepositoryList,
} from "../shared";
import { ChatOptionsBar } from "../components/ChatOptionsBar";
import { Composer } from "../components/Composer";
import { NewWorkspaceSheet } from "../components/NewWorkspaceSheet";
import { HostDetails, UnsandboxedHost } from "../hosts";
import { useAppData, type AutoPreference } from "../lib/app-data";
import { AUTO, createAutoMode } from "../lib/auto-mode";
import { createAttachments, createFileOptions, encodeImages, handOverAttachments, imagesUnavailable, withFilesNote } from "../lib/attachments";
import { session } from "../lib/auth";
import { createDraft, forgetSentDraft, newSessionDraftId, saveDraft } from "../lib/drafts";
import { randomId } from "../lib/format";
import type { PageRoute } from "../lib/page";
import { createAction, createResource } from "../lib/resource";
import { thisComputerHostId } from "../lib/this-computer";
import { OwnJoinRequests } from "../settings/join-requests";
import { control, palette, radius, text } from "../theme";
import { Logo } from "../logo";
import { Banner, Button, Chip, EmptyState, Feedback, IconButton, Loading, Note, Picker, Small } from "../ui";

const TITLE_LIMIT = 80;

function deriveTitle(content: string, fallback: string): string {
  const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
  return Array.from(firstLine).slice(0, TITLE_LIMIT).join("").trim() || fallback;
}

const sameModel = (a: { provider: string; modelId: string }, b: { provider: string; modelId: string }) => a.provider === b.provider && a.modelId === b.modelId;

export function NewSessionForm(props: { onStarted: (sessionId: string) => void; workspaceId?: string; home?: boolean; go?: (route: PageRoute) => void }) {
  const data = useAppData();
  const workspaces = () => data.workspaces().filter(item => canCreateSessions(item.role));
  const chosen = signal(props.workspaceId ?? "");
  const workspace = () => workspaces().find(item => item.id === (chosen() || data.lastWorkspaceId())) ?? workspaces()[0];
  const creating = signal(false);
  const workspacePicker = (current: Workspace) => (
    <Picker<string> title="Workspace" value={current.id} onSelect={value => chosen.set(value)} placement="bottom"
      trigger={<Chip small testID="new-workspace" icon="users" label={current.name} disabled={workspaces().length < 2} />}
      options={workspaces().map(item => ({ value: item.id, label: item.name, hint: item.role, icon: "users" }))} />
  );
  return (
    <If when={!data.workspacesLoading()} else={<Loading />}>
      <If when={!data.workspacesError()}
        else={
          <View style={{ padding: 20 }}>
            <Banner tone="danger" title="Unable to load workspaces" actions={<Button small variant="outline" label="Retry" onPress={data.refreshWorkspaces} />}>{data.workspacesError()}</Banner>
          </View>
        }>
        <If when={workspace()}
          else={
            <If when={data.workspaces().length > 0}
              else={
                <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}>
                  <View style={{ gap: 14, width: "100%", maxWidth: 520, alignSelf: "center", alignItems: "center" }}>
                    <Logo size={40} />
                    <Text role="header" style={{ fontSize: text.heading, fontWeight: "300", color: palette().text, textAlign: "center" }}>Welcome to Pikibun</Text>
                    <Text style={{ fontSize: text.reading, lineHeight: 22, color: palette().muted, textAlign: "center" }}>
                      Create a workspace for your team, add a repository and pair a host to start your first session.
                    </Text>
                    <Button testID="home-new-workspace" variant="primary" large label="New workspace" onPress={() => creating.set(true)} />
                    <Small center>Joining a team? Open the invite link an owner or admin shared, or ask them to add you with your User ID from Settings.</Small>
                    <View style={{ alignSelf: "stretch" }}><OwnJoinRequests /></View>
                  </View>
                  <NewWorkspaceSheet open={creating()} onClose={() => creating.set(false)} created={created => chosen.set(created.id)} />
                </Scroll>
              }>
              <EmptyState title="Viewer only">You're a viewer in every workspace you belong to, so you can follow their shared sessions but not start one. Ask a workspace owner or admin for the member role.</EmptyState>
            </If>
          }>
          {current => (
            <Each of={[current()]} key={item => item.id}>
              {item => <Form workspace={item()} onStarted={props.onStarted} home={props.home} workspacePicker={workspacePicker(item())} go={props.go} />}
            </Each>
          )}
        </If>
      </If>
    </If>
  );
}

function Form(props: { workspace: Workspace; onStarted: (sessionId: string) => void; home?: boolean; workspacePicker: JSX.Element; go?: (route: PageRoute) => void }) {
  const { user } = untracked(session);
  const data = useAppData();
  const workspacePath = `/api/workspaces/${segment(props.workspace.id)}`;
  const models = createResource<{ models: ModelDefinition[] }>(() => `${workspacePath}/models`);
  const connections = createResource<{ connectors: ConnectorInfo[] }>(() => `${workspacePath}/connectors`, 10_000);
  const repos = createResource<WorkspaceRepositoryList>(() => `${workspacePath}/repositories`);
  const choice = signal("");
  const draftId = newSessionDraftId(props.workspace.id);
  const content = createDraft(draftId);
  const visibility = signal<"workspace" | "private">("workspace");
  const trustedHost = signal("");
  const onHost = signal<boolean | null>(null);
  const personal = () => props.workspace.personal === true;
  const action = createAction();

  const modelList = () => models.data()?.models;
  const connectors = () => connections.data()?.connectors;
  const repositories = () => repos.data()?.repositories ?? null;
  const repositoriesRequired = () => repos.data()?.required ?? true;
  const hosts = computed(() => {
    const offering = new Set((modelList() ?? []).map(model => model.connectorId));
    return (connectors() ?? []).filter(host => offering.has(host.id) && !host.revokedAt)
      .sort((a, b) => Number(b.ownerId === user.id) - Number(a.ownerId === user.id));
  });
  const thisComputerHost = () => { const id = personal() ? thisComputerHostId() : undefined; return id ? hosts().find(item => item.id === id && item.online) : undefined; };
  const manualHost = () => hosts().find(item => item.id === choice()) ?? thisComputerHost() ?? hosts().find(item => item.id === data.lastChat()?.connectorId)
    ?? hosts().find(item => item.online) ?? hosts()[0];
  const autoMode = createAutoMode(() => props.workspace.id);
  const autoPick = signal<AutoPreference | null>(null);
  const autoWanted = () => autoPick() ?? data.lastAuto();
  const autoHost = () => autoMode.enabled() && autoWanted().host;
  const autoModel = () => autoMode.enabled() && autoWanted().model;
  const autoOn = () => autoHost() || autoModel();
  const setAuto = (value: AutoPreference) => { autoPick.set(value); data.rememberAuto(value); };
  const kept = signal<ChatSelection | null>(null);
  const autoExtras = signal<{ thinkingLevel?: ThinkingLevel; access: AccessMode }>({ access: "auto" });
  const resolution = signal<{ key: string; choice: AutoChoiceAnswer } | null>(null);
  const autoError = signal("");
  const autoRequest = (): AutoChoiceRequest | null => {
    if (!autoOn()) return null;
    const fixedHost = autoHost() ? undefined : manualHost();
    if (!autoHost() && !fixedHost) return null;
    const keptModel = autoHost() && !autoModel() ? kept()?.model : undefined;
    return { task: content().trim().slice(0, AUTO_TASK_LIMIT), ...(fixedHost ? { connectorId: fixedHost.id } : {}), ...(keptModel ? { model: keptModel } : {}) };
  };
  const host = () => {
    if (!autoHost()) return manualHost();
    const chosen = resolution()?.choice.connectorId;
    return chosen ? hosts().find(item => item.id === chosen) : undefined;
  };
  const hostModel = (wanted?: { provider: string; modelId: string }) => {
    const current = host();
    return wanted && current && current.models.some(item => sameModel(item, wanted)) ? modelList()?.find(item => item.connectorId === current.id && sameModel(item, wanted)) : undefined;
  };
  const chat = signal<{ key: string; value: ChatSelection } | null>(null);
  const manualSelection = (): ChatSelection => {
    const current = host();
    const picked = chat();
    return current && picked?.key === current.id ? picked.value
      : preferredSelection(current, data.lastChat(), current?.models.map(item => hostModel(item)).find(Boolean), item => Boolean(hostModel(item)));
  };
  const autoSelection = (): ChatSelection => {
    const choice = resolution()?.choice;
    const extras = autoExtras();
    if (!choice || choice.connectorId !== host()?.id) return { access: extras.access };
    const thinkingLevel = extras.thinkingLevel ?? choice.thinkingLevel;
    return { model: { provider: choice.provider, modelId: choice.modelId }, ...(thinkingLevel ? { thinkingLevel } : {}), access: extras.access };
  };
  const selection = (): ChatSelection => (autoModel() ? autoSelection() : autoHost() ? kept() ?? autoSelection() : manualSelection());
  const changeSelection = (value: ChatSelection) => {
    const extras = () => autoExtras.set({ ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}), access: value.access });
    if (autoModel()) { extras(); return; }
    if (autoHost()) {
      const chosen = autoSelection().model;
      if (!kept() && chosen && value.model && sameModel(chosen, value.model)) { extras(); return; }
      kept.set(value);
      return;
    }
    const current = host();
    if (current) chat.set({ key: current.id, value });
  };
  const model = () => hostModel(selection().model);
  const foreign = () => Boolean(host() && host()!.ownerId !== user.id);
  const availableModel = () => Boolean(model() && host()?.models.some(item => sameModel(item, model()!)));
  const available = () => {
    const current = host();
    return Boolean(current?.online && !current.revokedAt && availableModel() && (current.ownerId === user.id || current.workspaceIds.includes(props.workspace.id)));
  };
  const sourceCount = () => { const list = repos.data(); return list ? list.sources ?? list.repositories.length : 0; };
  const repositoriesReady = () => Boolean(repositories() && !repos.error() && !repos.loading() && (sourceCount() || !repositoriesRequired()));
  const trusted = () => !foreign() || Boolean(host() && trustedHost() === host()!.id);
  const hostSessions = () => Boolean(host()?.hostSessions);
  const runOnHost = () => hostSessions() && (onHost() ?? personal());
  const canStart = () => Boolean(model() && host() && available() && repositoriesReady() && trusted() && !action.busy());
  const attachments = createAttachments({ imagesUnavailable: () => imagesUnavailable(host()), fileOptions: createFileOptions(() => props.workspace.id, host) });
  let trustKey: string | undefined;
  effect(() => {
    const key = JSON.stringify([host()?.id ?? null, host()?.ownerId ?? null, (repositories() ?? []).map(repository => repository.id)]);
    if (trustKey !== undefined && key !== trustKey) trustedHost.set("");
    trustKey = key;
  });
  let environmentHost: string | null | undefined;
  effect(() => {
    const id = host()?.id ?? null;
    if (environmentHost !== undefined && id !== environmentHost) onHost.set(null);
    environmentHost = id;
  });
  let autoAsked = false;
  effect(() => {
    const request = autoRequest();
    if (!request) { resolution.set(null); autoError.set(""); autoAsked = false; return; }
    const key = JSON.stringify(request);
    if (untracked(resolution)?.key === key) return;
    const controller = new AbortController();
    const run = () => {
      autoMode.choose(request, controller.signal).then(
        choice => { if (!controller.signal.aborted) { resolution.set({ key, choice }); autoError.set(""); } },
        reason => { if (!controller.signal.aborted) autoError.set(errorMessage(reason)); },
      );
    };
    if (!autoAsked) { autoAsked = true; run(); return () => controller.abort(); }
    const timer = setTimeout(run, 600);
    return () => { controller.abort(); clearTimeout(timer); };
  });
  async function resolveAuto(): Promise<boolean> {
    const request = autoRequest();
    if (!request) return !autoOn();
    const key = JSON.stringify(request);
    if (untracked(resolution)?.key === key) return true;
    try {
      resolution.set({ key, choice: await autoMode.choose(request) });
      autoError.set("");
      return true;
    } catch (reason) {
      autoError.set(errorMessage(reason));
      return false;
    }
  }

  async function start() {
    if (autoOn() && !await resolveAuto()) return;
    const current = host();
    const picked = model();
    if (!canStart() || !picked || !current) return;
    const typed = content();
    const message = typed.trim();
    const pasted = untracked(attachments.images);
    const attached = untracked(attachments.files);
    const options = chatOptionsBody(current, selection(), "submit");
    const hostEnvironment = runOnHost();
    const chosenByAuto = autoOn();
    void action.run(async () => {
      const { api } = session();
      const images = await encodeImages(pasted);
      const result = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: {
        workspaceId: props.workspace.id, modelId: picked.id, title: deriveTitle(typed, picked.name), visibility: visibility(),
        ...(foreign() ? { trustedConnectorId: current.id } : {}), ...(hostEnvironment ? { hostEnvironment: true } : {}),
      } });
      const sessionId = result.session.id;
      data.setLastWorkspaceId(props.workspace.id);
      if (!chosenByAuto) data.rememberChat(current, selection());
      if (message || images.length || attached.length) {
        try {
          const note = await attachments.upload(sessionId, attached);
          await api(`/api/sessions/${segment(sessionId)}/submit`, { method: "POST", body: {
            content: withFilesNote(message, note), requestId: randomId(), ...(options ? { options } : {}), ...(images.length ? { images } : {}),
          } });
        } catch {
          saveDraft(sessionId, message);
          handOverAttachments(sessionId, pasted, attached);
        }
      }
      forgetSentDraft(draftId, typed);
      attachments.sent(pasted, attached);
      data.refreshSessions();
      props.onStarted(sessionId);
    });
  }

  const loading = () => models.loading() || connections.loading();
  const refreshHost = () => <Button small variant="outline" label="Refresh host status" onPress={connections.refresh} />;
  const settings = (route: PageRoute, label: string, testID: string) => (props.go ? <Button testID={testID} small variant="outline" label={label} onPress={() => props.go!(route)} /> : undefined);
  const workspaceSettings: PageRoute = { name: "settings", section: "workspaces", id: props.workspace.id };
  const hostState = (item: ConnectorInfo) => item.revokedAt ? "Revoked" : !item.online ? "Offline" : item.capabilities.unsandboxed ? "Unsandboxed"
    : !item.capabilities.sandbox ? "Sandbox unverified" : "Online";
  const blocking = (): { tone: "danger" | "warning" | "info"; title: string; text: string; retry?: () => void; refresh?: boolean; trust?: ConnectorInfo; action?: JSX.Element } | null => {
    if (repos.error()) return { tone: "warning", title: "Unable to load sources", text: repos.error(), retry: repos.refresh };
    if (repositories() && !sourceCount() && repositoriesRequired()) {
      return { tone: "warning", title: "No sources in this workspace", text: "Sessions need at least one source, such as a repository or a Notion page. Workspace owners and admins add them in workspace settings.",
        action: settings(workspaceSettings, "Add a source", "new-add-source") };
    }
    if (models.error()) return { tone: "danger", title: "Unable to load models", text: models.error(), retry: models.refresh };
    if (connections.error()) return { tone: "warning", title: "Unable to check host", text: connections.error(), refresh: true };
    if (loading() || !modelList() || !connectors()) return null;
    if (!hosts().length) {
      return { tone: "info", title: "No host to chat with yet", text: "Pair your own Pi to chat with its models, or ask a workspace member to share their host here.",
        action: settings({ name: "settings", section: "hosts" }, "Pair a host", "new-pair-host") };
    }
    if (autoOn() && autoError()) {
      return { tone: "warning", title: "Auto couldn't choose", text: `${autoError()} Choose a host and model yourself, or try again.`, retry: () => { resolution.set(null); autoError.set(""); void resolveAuto(); } };
    }
    const current = host();
    if (!current) return null;
    if (!model()) return { tone: "warning", title: `No model on ${current.name}`, text: `${current.name} offers no model you can use in this workspace.`, refresh: true };
    if (!availableModel()) return { tone: "warning", title: "Model no longer offered", text: `This model is no longer offered by ${current.name}. Ask the host owner to restore it; no substitute will be chosen.`, refresh: true };
    if (!available()) return { tone: "warning", title: `${current.name} is unavailable`, text: current.revokedAt ? "This host was revoked." : !current.online ? "It must reconnect before work can run." : "This host isn't shared with this workspace.", refresh: true };
    if (foreign()) return { tone: "warning", title: `Hosted by ${current.ownerName}`, text: "", trust: current };
    return null;
  };

  const hostLabel = () => {
    const current = host();
    if (autoHost()) return current ? `Auto · ${current.name}` : autoError() ? "Auto" : "Auto · choosing…";
    return current ? current.name : loading() ? "Loading…" : "No host";
  };
  const selectHost = (value: string) => {
    if (value === AUTO) { kept.set(null); setAuto({ ...autoWanted(), host: true }); return; }
    choice.set(value);
    if (autoHost()) setAuto({ ...autoWanted(), host: false });
  };
  const hostPicker = () => (
    <Picker<string> title="Host" value={autoHost() ? AUTO : host()?.id} onSelect={selectHost} placement="bottom"
      trigger={<Chip small testID="new-host" icon={autoHost() ? "sparkles" : "monitor"} label={hostLabel()} disabled={(hosts().length < 2 && !autoMode.enabled()) || action.busy()}
        tone={host() && !host()!.online ? "warning" : undefined} />}
      options={[
        ...(autoMode.enabled() ? [{ value: AUTO, label: "Auto", icon: "sparkles" as const,
          hint: "Chooses the host for the task: online, shared here, yours first, the least busy, with a GPU or the model the task needs" }] : []),
        ...hosts().map(item => ({ value: item.id, label: item.name, icon: "monitor" as const, hint: `${item.ownerId === user.id ? "Your host" : `${item.ownerName}'s host`} · ${hostState(item)}` })),
      ]} />
  );
  const autoModelOption = () => (autoMode.enabled() ? {
    selected: autoModel(),
    hint: "Chooses the model and reasoning for the task: a light model for simple ones, a frontier model with more reasoning for complex ones",
    onSelect: () => { autoExtras.set({ access: selection().access }); setAuto({ ...autoWanted(), model: true }); },
    onLeave: () => setAuto({ ...autoWanted(), model: false }),
  } : undefined);
  const autoReasons = () => (autoOn() && resolution() && host()?.id === resolution()!.choice.connectorId ? resolution()!.choice.reasons.join(" ") : "");
  const environmentPicker = () => (
    <Picker<"sandbox" | "host"> title="Where it runs" value={runOnHost() ? "host" : "sandbox"} onSelect={value => onHost.set(value === "host")} placement="bottom"
      trigger={<Chip small testID="new-environment" icon={runOnHost() ? "server" : "shield"} label={runOnHost() ? "On host" : "Sandbox"} tone={runOnHost() ? "danger" : undefined} disabled={action.busy()} />}
      options={[
        { value: "sandbox", label: "Sandbox", icon: "shield", hint: "Isolated, with the workspace's network access" },
        { value: "host", label: "On this host", icon: "server", hint: "No sandbox: runs as the host's user" },
      ]} />
  );

  const trustSwitch = (trustHost: ConnectorInfo) => (
    <Switch testID="new-trust" checked={trustedHost() === trustHost.id} disabled={action.busy()}
      onChange={event => trustedHost.set(event.checked ? trustHost.id : "")}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}
      trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary" thumbClass="w-5 h-5 m-0.5 rounded-full bg-background checked:translate-x-4">
      <Text style={{ flex: 1, minWidth: 0, fontSize: text.small, lineHeight: 19, color: palette().text }}>
        {`I trust ${trustHost.ownerName}'s host (${trustHost.name}) to process this session's prompts and repository files, including private repository snapshots; its operator can read them. Repository access uses my GitHub identity, not the host owner's or a workspace admin's. I remain the session owner.`}
      </Text>
    </Switch>
  );
  const visibilityPicker = () => (
    <Picker<"workspace" | "private"> title="Who can see it" value={visibility()} onSelect={value => visibility.set(value)} placement="bottom"
      trigger={<Chip small testID="new-visibility" icon={visibility() === "workspace" ? "users" : "lock"} label={visibility() === "workspace" ? "Workspace" : "Private"} disabled={action.busy()} />}
      options={[
        { value: "workspace", label: "Workspace", icon: "users", hint: "Members can view the transcript; collaborators can message it." },
        { value: "private", label: "Private", icon: "lock", hint: "Only you, the workspace's owner and admins, and people you give a session role." },
      ]} />
  );
  const repositoryCount = () => { const count = repositories()?.length ?? 0; return count ? count === 1 ? "1 repository" : `${count} repositories` : ""; };
  const showDetails = signal(false);

  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: props.home ? "center" : "flex-start", paddingHorizontal: 20, paddingVertical: props.home ? 40 : 24 }}>
      <View style={{ gap: 12, width: "100%", maxWidth: 720, alignSelf: "center" }}>
        <View style={{ alignItems: props.home ? "center" : "flex-start", gap: 14, paddingBottom: 10 }}>
          <If when={props.home}><Logo size={40} /></If>
          <Text role="header" style={{ fontSize: props.home ? 26 : 22, fontWeight: "300", color: palette().text, textAlign: props.home ? "center" : "auto" }}>What should we work on?</Text>
        </View>
        <Composer testID="new-message" sendTestID="new-start" value={content()} onChange={value => content.set(value)} onSubmit={() => void start()}
          busy={action.busy()} ready={canStart()} minHeight={72} sendLabel="Start session" attachments={attachments}
          placeholder="Describe a task, or start without one"
          hint=""
          tools={
            <If when={host() || !autoHost()} else={<Chip testID="chat-model" icon="sparkles" label={autoError() ? "Auto" : "Auto · choosing…"} disabled />}>
              <ChatOptionsBar host={host()} value={selection()} onChange={changeSelection} auto={autoModelOption()} />
            </If>
          } />
        <View testID="new-context" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 4, columnGap: 2, paddingHorizontal: 4 }}>
          {props.workspacePicker}
          {hostPicker()}
          <If when={hostSessions()}>{environmentPicker()}</If>
          {visibilityPicker()}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginLeft: "auto" }}>
            <If when={repositoryCount()}>
              {count => <Text style={{ fontSize: text.small, color: palette().faint, paddingHorizontal: 8 }}>{count()}</Text>}
            </If>
            <If when={host()}>
              <Chip small testID="new-host-details" label="Host details" expanded={showDetails()} onPress={() => showDetails.update(open => !open)} />
            </If>
            <If when={props.go}>
              <IconButton testID="new-workspace-settings" icon="settings" label="Workspace settings" size={control.xsmall} onPress={() => props.go!(workspaceSettings)} />
            </If>
          </View>
        </View>
        <If when={autoReasons()}>
          {reasons => <View style={{ paddingHorizontal: 8 }}><Small testID="new-auto-reasons">{`Auto: ${reasons()}`}</Small></View>}
        </If>
        <If when={showDetails() && !action.busy() ? host() : undefined}>
          {current => (
            <View testID="new-host-details-panel" style={{ gap: 10, padding: 16, borderWidth: 1, borderColor: palette().border, borderRadius: radius.large }}>
              <Note>{`${current().name}: ${hostState(current())} · ${foreign() ? `Hosted by ${current().ownerName}` : "Your host"}, ${current().workspaceIds.includes(props.workspace.id) ? "shared with this workspace" : "private"}${model() ? ` · ${model()!.name}` : ""}.`}</Note>
              <HostDetails connector={current()} />
            </View>
          )}
        </If>
        <If when={blocking()}>
          {alert => (
            <Banner tone={alert().tone} title={alert().title}
              actions={alert().trust ? trustSwitch(alert().trust!) : alert().retry ? <Button small variant="outline" label="Retry" onPress={alert().retry!} /> : alert().refresh ? refreshHost() : alert().action}>
              {alert().trust ? undefined : <Text>{alert().text}</Text>}
            </Banner>
          )}
        </If>
        <If when={runOnHost() ? host() : undefined}>
          {current => (
            <Banner testID="new-on-host" tone="warning" title={foreign() ? `Runs on ${current().ownerName}'s host, without the sandbox` : "Runs on your host, without the sandbox"}>
              {`${foreign() ? `${current().ownerName} granted you sessions on ${current().name}. ` : ""}Its commands run on ${current().name} as its user, with its files, credentials, network and GPU, and no resource limits; the workspace's network access doesn't apply. Approve them as you would commands you run yourself: ${foreign()
                ? `people you share the session with can decide them only if they also hold host commands on ${current().name}.`
                : "people you share the session with can't decide them unless you granted them host commands."}`}
            </Banner>
          )}
        </If>
        <If when={host() && !action.busy() ? host() : undefined}>{current => <UnsandboxedHost connector={current()} />}</If>
        <Feedback error={action.error()} />
        <If when={action.busy()}>
          <Small>Resolving repository commits and downloading snapshots to the Pi host's private session cache. The agent starts once every repository is ready.</Small>
        </If>
      </View>
    </Scroll>
  );
}
