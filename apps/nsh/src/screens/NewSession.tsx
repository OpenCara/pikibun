import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Input, Switch } from "nsh/base";
import {
  canCreateSessions, chatOptionsBody, mustConfirmAutoApprove, preferredSelection, segment, type ChatSelection, type ConnectorInfo, type ModelDefinition,
  type SessionRecord, type Workspace, type WorkspaceRepositoryList,
} from "../shared";
import { ChatOptionsBar, confirmAutoApprove } from "../components/ChatOptionsBar";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { saveDraft } from "../lib/drafts";
import { randomId } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import { palette } from "../theme";
import { Banner, Button, Chip, EmptyState, Feedback, Loading, OptionSheet, Segmented, Small } from "../ui";

const TITLE_LIMIT = 80;

function deriveTitle(content: string, fallback: string): string {
  const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
  return Array.from(firstLine).slice(0, TITLE_LIMIT).join("").trim() || fallback;
}

const sameModel = (a: { provider: string; modelId: string }, b: { provider: string; modelId: string }) => a.provider === b.provider && a.modelId === b.modelId;

/** Pick a workspace, then a host and model in it, optionally a first message; like the web's new-session screen. */
export function NewSessionForm(props: { onStarted: (sessionId: string) => void }) {
  const data = useAppData();
  // A viewer follows a workspace's sessions but starts none there.
  const workspaces = () => data.workspaces().filter(item => canCreateSessions(item.role));
  const chosen = signal("");
  const picking = signal(false);
  const workspace = () => workspaces().find(item => item.id === (chosen() || data.lastWorkspaceId())) ?? workspaces()[0];
  return (
    <If when={!data.workspacesLoading()} else={<Loading />}>
      <If when={!data.workspacesError()}
        else={
          <View style={{ padding: 20 }}>
            <Banner tone="danger" title="Unable to load workspaces" actions={<Button small label="Retry" onPress={data.refreshWorkspaces} />}>{data.workspacesError()}</Banner>
          </View>
        }>
        <If when={workspace()}
          else={
            <If when={data.workspaces().length > 0}
              else={<EmptyState title="No workspace yet">Create a workspace on the web, add a repository and pair a host to start your first session.</EmptyState>}>
              <EmptyState title="Viewer only">You're a viewer in every workspace you belong to, so you can follow their shared sessions but not start one. Ask a workspace owner or admin for the member role.</EmptyState>
            </If>
          }>
          {current => (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderColor: palette().border }}>
                <Small>Workspace</Small>
                <Chip testID="new-workspace" icon="👥" label={current().name} disabled={workspaces().length < 2} onPress={() => picking.set(true)} />
              </View>
              {/* Keyed so host, trust and repository state never carry across workspaces. */}
              <Each of={[current()]} key={item => item.id}>
                {item => <Form workspace={item()} onStarted={props.onStarted} />}
              </Each>
              <OptionSheet<string> open={picking()} title="Workspace" value={current().id} onClose={() => picking.set(false)} onSelect={value => chosen.set(value)}
                options={workspaces().map(item => ({ value: item.id, label: item.name, hint: item.role }))} />
            </>
          )}
        </If>
      </If>
    </If>
  );
}

function Form(props: { workspace: Workspace; onStarted: (sessionId: string) => void }) {
  const { user } = untracked(session);
  const data = useAppData();
  const askAutoApprove = confirmAutoApprove(data);
  let confirming = false;
  const workspacePath = `/api/workspaces/${segment(props.workspace.id)}`;
  const models = createResource<{ models: ModelDefinition[] }>(() => `${workspacePath}/models`);
  const connections = createResource<{ connectors: ConnectorInfo[] }>(() => `${workspacePath}/connectors`, 10_000);
  const repos = createResource<WorkspaceRepositoryList>(() => `${workspacePath}/repositories`);
  const choice = signal("");
  const pickingHost = signal(false);
  const content = signal("");
  const visibility = signal<"workspace" | "private">("workspace");
  const trustedHost = signal("");
  const action = createAction();

  const modelList = () => models.data()?.models;
  const connectors = () => connections.data()?.connectors;
  const repositories = () => repos.data()?.repositories ?? null;
  // Until the listing says otherwise, sessions need a repository.
  const repositoriesRequired = () => repos.data()?.required ?? true;
  // Hosts with a model you can use here, yours first.
  const hosts = computed(() => {
    const offering = new Set((modelList() ?? []).map(model => model.connectorId));
    return (connectors() ?? []).filter(host => offering.has(host.id) && !host.revokedAt)
      .sort((a, b) => Number(b.ownerId === user.id) - Number(a.ownerId === user.id));
  });
  // The host picked here, else the one last chatted on, else the first online one.
  const host = () => hosts().find(item => item.id === choice()) ?? hosts().find(item => item.id === data.lastChat()?.connectorId) ?? hosts().find(item => item.online) ?? hosts()[0];
  const hostModel = (wanted?: { provider: string; modelId: string }) => {
    const current = host();
    return wanted && current && current.models.some(item => sameModel(item, wanted)) ? modelList()?.find(item => item.connectorId === current.id && sameModel(item, wanted)) : undefined;
  };
  // Picks belong to one host; switching starts again from the model last chatted with when that host offers it.
  const chat = signal<{ key: string; value: ChatSelection } | null>(null);
  const selection = (): ChatSelection => {
    const current = host();
    const picked = chat();
    return current && picked?.key === current.id ? picked.value
      : preferredSelection(current, data.lastChat(), current?.models.map(item => hostModel(item)).find(Boolean), item => Boolean(hostModel(item)));
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
  const canStart = () => Boolean(model() && host() && available() && repositoriesReady() && trusted() && !action.busy());
  // A trust acknowledgement covers one host against one repository set.
  effect(() => {
    host()?.id;
    host()?.ownerId;
    repositories();
    trustedHost.set("");
  });

  async function start() {
    const current = host();
    const picked = model();
    if (!canStart() || !picked || !current || confirming) return;
    const message = content().trim();
    const options = chatOptionsBody(current, selection(), "submit");
    if (mustConfirmAutoApprove(options, data.autoApproveConfirmed())) {
      confirming = true;
      const confirmed = await askAutoApprove(current, Boolean(current.capabilities.unsandboxed)).finally(() => { confirming = false; });
      if (!confirmed) { chat.set({ key: current.id, value: { ...selection(), access: "approval" } }); return; }
    }
    void action.run(async () => {
      const { api } = session();
      const result = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: {
        workspaceId: props.workspace.id, modelId: picked.id, title: deriveTitle(content(), picked.name), visibility: visibility(), ...(foreign() ? { trustedConnectorId: current.id } : {}),
      } });
      const sessionId = result.session.id;
      data.setLastWorkspaceId(props.workspace.id);
      data.rememberChat(current, selection());
      if (message) {
        try {
          await api(`/api/sessions/${segment(sessionId)}/submit`, { method: "POST", body: { content: message, requestId: randomId(), ...(options ? { options } : {}) } });
        } catch {
          // The session exists; keep the unsent text for its chat box instead of failing the start.
          saveDraft(sessionId, message);
        }
      }
      data.refreshSessions();
      props.onStarted(sessionId);
    });
  }

  const loading = () => models.loading() || connections.loading();
  const refreshHost = () => <Button small label="Refresh host status" onPress={connections.refresh} />;
  const hostState = (item: ConnectorInfo) => item.revokedAt ? "Revoked" : !item.online ? "Offline" : item.capabilities.unsandboxed ? "Unsandboxed"
    : !item.capabilities.sandbox ? "Sandbox unverified" : "Online";
  /** What keeps the session from starting, the first thing first. */
  const blocking = (): { tone: "danger" | "warning" | "info"; title: string; text: string; retry?: () => void; refresh?: boolean; trust?: ConnectorInfo } | null => {
    if (repos.error()) return { tone: "warning", title: "Unable to load sources", text: repos.error(), retry: repos.refresh };
    if (repositories() && !sourceCount() && repositoriesRequired()) return { tone: "warning", title: "No sources in this workspace", text: "Sessions need at least one source, such as a repository or a Notion page. Workspace owners and admins add them in workspace settings on the web." };
    if (models.error()) return { tone: "danger", title: "Unable to load models", text: models.error(), retry: models.refresh };
    if (connections.error()) return { tone: "warning", title: "Unable to check host", text: connections.error(), refresh: true };
    if (loading() || !modelList() || !connectors()) return null;
    if (!hosts().length) return { tone: "info", title: "No host to chat with yet", text: "Pair your own Pi to chat with its models, or ask a workspace member to share their host here." };
    const current = host();
    if (!current) return null;
    if (!model()) return { tone: "warning", title: `No model on ${current.name}`, text: `${current.name} offers no model you can use in this workspace.`, refresh: true };
    if (!availableModel()) return { tone: "warning", title: "Model no longer offered", text: `This model is no longer offered by ${current.name}. Ask the host owner to restore it; no substitute will be chosen.`, refresh: true };
    if (!available()) return { tone: "warning", title: `${current.name} is unavailable`, text: current.revokedAt ? "This host was revoked." : !current.online ? "It must reconnect before work can run." : "This host isn't shared with this workspace.", refresh: true };
    if (foreign()) return { tone: "warning", title: `Hosted by ${current.ownerName}`, text: "", trust: current };
    return null;
  };

  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ gap: 12, padding: 20, width: "100%", maxWidth: 680, alignSelf: "center" }}>
      <Text style={{ fontSize: 24, fontWeight: "700", color: palette().text }}>What should we work on?</Text>
      <Input testID="new-message" value={content()} onChange={event => content.set(event.value)} multiline readonly={action.busy()} placeholder="Describe the task (optional)"
        accessibilityLabel="First message"
        style={{ borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, fontSize: 16, minHeight: 96,
          backgroundColor: palette().surface, borderColor: palette().border, color: palette().text, placeholderColor: palette().muted }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Chip testID="new-host" icon="🖥" label={host() ? host()!.name : loading() ? "Loading..." : "No host"} disabled={hosts().length < 2 || action.busy()} onPress={() => pickingHost.set(true)} />
        <ChatOptionsBar host={host()} value={selection()} onChange={value => { const current = host(); if (current) chat.set({ key: current.id, value }); }}
          owner showAccess unsandboxed={Boolean(host()?.capabilities.unsandboxed)} data={data} />
      </View>
      <Segmented testID="new-visibility" value={visibility()} onChange={value => visibility.set(value)}
        options={[{ value: "workspace", label: "Workspace" }, { value: "private", label: "Private" }]} />
      <Small>
        {visibility() === "workspace"
          ? "Workspace members can view prompts, output, tool results, and repository content shown in the transcript. Collaborators can also message it, and the workspace's owner and admins manage it; approving tool calls needs an explicit grant."
          : "Workspace membership alone does not give access to a private session: only the workspace's owner and admins, who manage every session, and people you give a session role open it."}
      </Small>
      <If when={blocking()}>
        {alert => (
          <Banner tone={alert().tone} title={alert().title}
            actions={alert().retry ? <Button small label="Retry" onPress={alert().retry!} /> : alert().refresh ? refreshHost() : undefined}>
            <If when={alert().trust} else={alert().text}>
              {trustHost => (
                <Switch testID="new-trust" checked={trustedHost() === trustHost().id} disabled={action.busy()}
                  onChange={event => trustedHost.set(event.checked ? trustHost().id : "")}
                  style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}
                  trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary" thumbClass="w-5 h-5 m-0.5 rounded-full bg-background checked:translate-x-4">
                  <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: palette().text }}>
                    {`I trust ${trustHost().ownerName}'s host (${trustHost().name}) to process this session's prompts and repository files, including private repository snapshots; its operator can read them. Repository access uses my GitHub identity, not the host owner's or a workspace admin's. I remain the session owner.`}
                  </Text>
                </Switch>
              )}
            </If>
          </Banner>
        )}
      </If>
      <If when={host()?.capabilities.unsandboxed}>
        <Banner tone="danger" title="Unsandboxed host">Agent work runs directly on the owner's machine without isolation: approved commands and commits run as their user, with access to their files, credentials and network, and no resource limits.</Banner>
      </If>
      <If when={host() && model()}>
        <Small>
          {`${hostState(host()!)} · ${host()!.name} · ${model()?.name ?? ""} · ${foreign() ? `Hosted by ${host()!.ownerName}` : "Your host"}, ${host()!.workspaceIds.includes(props.workspace.id) ? "shared with this workspace" : "private"}${repositories()?.length ? ` · ${repositories()!.length === 1 ? "1 repository" : `${repositories()!.length} repositories`}` : ""}`}
        </Small>
      </If>
      <Feedback error={action.error()} />
      <Button testID="new-start" variant="primary" icon="↑" label="Start session" busy={action.busy()} disabled={!canStart()} onPress={() => void start()} />
      <If when={action.busy()}>
        <Small>Resolving repository commits and downloading snapshots to the Pi host's private session cache. The agent starts once every repository is ready.</Small>
      </If>
      <OptionSheet<string> open={pickingHost()} title="Host" value={host()?.id} onClose={() => pickingHost.set(false)} onSelect={value => choice.set(value)}
        options={hosts().map(item => ({ value: item.id, label: item.name, hint: `${item.ownerId === user.id ? "Your host" : `${item.ownerName}'s host`} · ${hostState(item)}` }))} />
    </Scroll>
  );
}
