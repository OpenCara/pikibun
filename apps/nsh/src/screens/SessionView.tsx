import { cleanup, Clipboard, computed, effect, Keyboard, keyboardFrame, List, platform, safeArea, Scroll, signal, Text, untracked, View, type Accessor, type JSX, type ListRef } from "nsh";
import { Button as BaseButton, NavPage } from "nsh/base";
import {
  accessUnavailable, activeStatuses, browserUnavailableText, chatOptionsBody, copyText,
  initialSelection, managesSession, messageCut, modelUnavailable, pairToolResults, preparingRepositories,
  REDACTED, redactSecrets, resendText, rewindable, seesEntryImages, segment, type ChatSelection, type ConnectorInfo, type EntryView,
  type SessionRecord, type SubmitResult,
} from "../shared";
import { RenameSheet } from "../components/SessionMenu";
import { ChatOptionsBar } from "../components/ChatOptionsBar";
import { Composer } from "../components/Composer";
import { PullRequestLink } from "../components/PullRequest";
import { RepositoryPreparationCard } from "../components/RepositoryPreparation";
import { TranscriptEntry, type MessageActions } from "../components/TranscriptEntry";
import { createAttachments, createFileOptions, encodeImages, imageBlobs, imagesUnavailable, restoreImages, withFilesNote } from "../lib/attachments";
import type { ChatImage } from "../../../../packages/shared/src/chat-images";
import type { AutoChoiceAnswer } from "../../../../packages/shared/src/auto-mode";
import { createAutoMode } from "../lib/auto-mode";
import type { WithdrawResult } from "../../../../packages/shared/src/types";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createDraft, forgetSentDraft, restoreDraft, saveDraft } from "../lib/drafts";
import { randomId } from "../lib/format";
import { createLiveSession, type LiveSessionState } from "../lib/live-session";
import { createUsername, createWorkspacePeople, PeopleContext } from "../lib/people";
import { createAction, createResource } from "../lib/resource";
import { Icon } from "../icons";
import { palette, radius, text } from "../theme";
import { Badge, Banner, Button, Chip, confirm, DropdownMenu, EmptyState, Feedback, IconButton, Loading, phoneWidth, Picker, Small, type MenuAction } from "../ui";
import { drawsHeaders, headerInPage, PageFrame, PageHeader, pageStyle } from "./PageHeader";
import type { PageRoute } from "../lib/page";
import { SessionPanel } from "../session-panel";
import { createSessionActions } from "../lib/session-actions";

const releaseChatBox = platform.desktop ? () => Keyboard.dismiss() : undefined;

export function SessionView(props: { id: string; page: boolean; openSession: (id: string) => void; onBack?: () => void; go: (route: PageRoute) => void }) {
  const { user } = untracked(session);
  const data = useAppData();
  const live = createLiveSession(props.id);
  const panelOpen = signal(false);
  const permissions = () => live.session()?.permissions ?? [];
  const archived = () => live.session()?.status === "archived";
  const readOnly = () => archived() || live.session()?.frozen === true;
  const isOwner = () => live.session()?.ownerId === user.id;
  const hosts = createResource<{ connectors: ConnectorInfo[] }>(() => {
    const current = live.session();
    return current?.connectorId ? `/api/workspaces/${segment(current.workspaceId)}/connectors` : null;
  }, 10_000);
  const host = () => hosts.data()?.connectors.find(item => item.id === live.session()?.connectorId);
  let previousOnline: boolean | undefined;
  effect(() => {
    const online = host()?.online;
    if (previousOnline === false && online) live.refresh();
    previousOnline = online;
  });
  const action = createAction();
  const known = () => live.session() ?? data.sessions().find(item => item.id === props.id);
  const people = createWorkspacePeople(() => known()?.workspaceId ?? null);
  const title = () => known()?.title ?? "Session";
  const workspace = () => {
    const current = known();
    return current ? data.workspaces().find(item => item.id === current.workspaceId) : undefined;
  };
  const manages = () => {
    const current = live.session();
    return Boolean(current && managesSession(user.id, current.ownerId, workspace()?.role));
  };
  const backupBlocked = () => {
    const current = live.view();
    return readOnly() || !current || Boolean(live.error()) || current.busy || (current.queue ?? []).some(item => activeStatuses.includes(item.status));
  };
  const actions = createSessionActions({ session: live.session, manages, backupBlocked,
    onChange: () => { live.refresh(); data.refreshSessions(); } });
  const pullRequest = () => data.sessions().find(item => item.id === props.id)?.pullRequest ?? live.session()?.pullRequest;
  const renaming = signal(false);
  const menu = (): (MenuAction | "separator")[] => {
    const current = live.session();
    const items: (MenuAction | "separator")[] = [{ label: "Copy session ID", icon: "copy", testID: "session-copy-id", onSelect: copyId }];
    if (current && manages() && !archived()) {
      items.push({ label: "Rename", icon: "pencil", testID: "session-rename", disabled: actions.action.busy(), onSelect: () => renaming.set(true) });
      items.push({ label: current.visibility === "workspace" ? "Make private" : "Make workspace-visible", icon: current.visibility === "workspace" ? "lock" : "globe",
        disabled: actions.action.busy(), onSelect: actions.changeVisibility });
      if (isOwner() && !current.frozen) {
        items.push({ label: "Create backup", icon: "archive", disabled: actions.backupsOff() || actions.backupsPending() || backupBlocked() || actions.action.busy(),
          hint: actions.backupsOff() ? "Backups are off" : backupBlocked() ? "Session busy" : undefined, onSelect: () => actions.createBackup() });
        items.push({ label: "Back up conversation only", icon: "archive",
          disabled: actions.backupsOff() || actions.backupsPending() || backupBlocked() || actions.conversationOnlyOff() || actions.action.busy(),
          hint: actions.backupsOff() ? "Backups are off" : backupBlocked() ? "Session busy" : actions.conversationOnlyOff() ? "Update the host's connector" : undefined,
          onSelect: () => actions.createBackup({ conversationOnly: true }) });
      }
      items.push({ label: "Archive", icon: "archive", testID: "session-archive", disabled: actions.action.busy(), onSelect: actions.archive });
    }
    if (current && manages() && archived()) {
      items.push({ label: "Unarchive", icon: "archive", disabled: actions.action.busy(), onSelect: actions.unarchive });
      if (isOwner() && !current.packed && !current.frozen && !current.hostEnvironment) items.push({ label: "Pack files", icon: "archive", disabled: actions.action.busy(), onSelect: actions.pack });
    }
    const workspaceId = known()?.workspaceId;
    if (workspaceId) items.push("separator", { label: "Open in workspace settings", icon: "settings", onSelect: () => props.go({ name: "settings", section: "workspaces", id: workspaceId }) });
    return items;
  };
  const browserWarning = () => (readOnly() ? undefined
    : live.view()?.extensions?.unavailable?.find(item => item.source === "piki:browser" && ["missing", "failed", "downloading"].includes(item.reason)));
  const dismissedBrowser = signal(false);

  effect(() => {
    const activity = live.view()?.activity;
    data.setLiveActivity(activity ? { sessionId: props.id, activity } : null);
  });
  cleanup(() => { data.setLiveActivity(null); data.refreshSessions(); });

  function unarchive() {
    const packed = Boolean(live.session()?.packed);
    void action.run(async () => {
      await session().api(`/api/sessions/${segment(props.id)}/unarchive`, { method: "POST" });
      live.refresh();
      data.refreshSessions();
    }, packed ? "Session unarchived, its files unpacked" : "Session unarchived");
  }
  const archivedText = () => {
    const current = live.session();
    if (current?.packed) {
      return manages() ? "This session is read-only. Its files are packed on its host. Unarchiving unpacks them and clones its repositories again, so its host must be online."
        : "This session is read-only. Its files are packed on its host. Only its owner, or the workspace's owner or an admin, can unarchive it.";
    }
    return `This session is read-only. ${manages() ? "Unarchive it to continue the work." : "Only its owner, or the workspace's owner or an admin, can unarchive it."}`;
  };

  const copyId = () => void action.run(() => Clipboard.writeText(props.id), "Session ID copied");

  const startFailed = () => !live.view() && Boolean(live.session() && (live.session()!.status === "error" || live.session()!.status === "provisioning"));
  const badge = (): { tone?: "danger" | "running" | "warning" | "success"; text: string; dot: boolean } => {
    if (archived()) return { text: "Archived", dot: false };
    if (startFailed()) return live.session()?.status === "error" ? { tone: "danger", text: "Not started", dot: true } : { tone: "running", text: "Starting", dot: true };
    if (!live.view() && live.error()) return { tone: "warning", text: "Unavailable", dot: true };
    switch (live.status()) {
      case "online": return { tone: "success", text: "Live", dot: true };
      case "reconnecting": return { tone: "warning", text: "Reconnecting", dot: true };
      case "offline": return { tone: "danger", text: "Disconnected", dot: true };
      default: return { text: "Connecting", dot: true };
    }
  };

  const headerActions = () => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <If when={!props.page}>
        <View style={{ paddingRight: 6 }}><Badge testID="session-connection" tone={badge().tone} dot={badge().dot}>{badge().text}</Badge></View>
      </If>
      <If when={live.session() ? pullRequest() : undefined}>
        {pull => <View style={{ paddingRight: 4 }}><PullRequestLink pull={pull()} compact={props.page} /></View>}
      </If>
      <DropdownMenu label="Session actions" testID="session-actions" items={menu()} />
      <IconButton testID="session-details" icon="panel-right" label="Session details" onPress={() => panelOpen.set(true)} active={panelOpen()} />
    </View>
  );
  const subtitle = () => {
    const current = live.session();
    const parts = [workspace()?.name, host() ? `${host()!.name}${host()!.online ? "" : " (offline)"}` : undefined];
    if (current) {
      parts.push(current.visibility === "workspace" ? "Workspace-visible" : "Private", ...(current.linkShared ? ["Link shared"] : []),
        ...(current.packed ? ["Files packed"] : []));
    }
    return parts.filter(Boolean).join(" · ");
  };


  const pinned = (
    <View style={{ gap: 10, paddingTop: 4 }}>
      <If when={live.view()?.repositories}>
        {preparation => (
          <RepositoryPreparationCard sessionId={props.id} preparation={preparation()}
            canRestart={isOwner() && !archived() && permissions().includes("manage")} onRestarted={() => { live.refresh(); data.refreshSessions(); }} />
        )}
      </If>
      <If when={browserWarning() && permissions().includes("write") && !dismissedBrowser() ? browserWarning() : null}>
        {warning => (
          <Banner tone={warning().reason === "downloading" ? "info" : "warning"} title={warning().reason === "downloading" ? "The browser isn't ready yet" : "No browser on this host"}
            actions={<Button small variant="outline" label="Dismiss" onPress={() => dismissedBrowser.set(true)} />}>
            {`The workspace has the browser tool on, but this session can't use it. ${browserUnavailableText(warning().reason)}`}
          </Banner>
        )}
      </If>
      <If when={live.session()?.hostUnsandboxed && permissions().includes("write")}>
        <If when={live.session()?.hostEnvironment}
          else={<Banner tone="danger" title="Unsandboxed host">This session's host runs without a sandbox. Its commands and commits run directly on the host owner's machine with their full user permissions, network access and no resource limits.</Banner>}>
          <Banner tone="danger" title="Runs on the host">This session runs directly on its host, without the sandbox. Its commands and commits run on the host owner's machine with their full user permissions, network access and no resource limits, for the host owner and members they granted host commands only.</Banner>
        </If>
      </If>
    </View>
  );

  const content = (
    <PeopleContext.Provider value={people}>
      <View style={{ flex: 1, backgroundColor: palette().background }}>
        <If when={!props.page}>
          <PageHeader title={title()} subtitle={subtitle()} actions={headerActions()} testID="session-header" />
        </If>
        <If when={props.page && live.session()}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: 1, borderColor: palette().border }}>
            <Badge testID="session-connection" tone={badge().tone} dot={badge().dot}>{badge().text}</Badge>
            <Text style={{ flex: 1, numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>{subtitle()}</Text>
          </View>
        </If>
        <If when={archived() || live.session()?.frozen || live.session()?.cloneUnavailable || (live.error() && !startFailed()) || action.error() || action.notice()}>
          <View style={{ gap: 8, paddingHorizontal: 16, paddingTop: 10, width: "100%", maxWidth: 800, alignSelf: "center" }}>
            <If when={live.session()?.frozen && !archived()}>
              <Banner testID="session-frozen" title="Read-only">
                This session pinned its repositories when it started, which sessions no longer do. Its conversation and backups stay viewable, but it no longer runs. Start a new session to continue the work.
              </Banner>
            </If>
            <If when={!live.session()?.frozen ? live.session()?.cloneUnavailable : undefined}>
              {reason => <Banner testID="session-clone-unavailable" tone="warning" title="Can't clone repositories">{reason()}</Banner>}
            </If>
            <If when={archived()}>
              <Banner title="Archived" actions={<If when={manages()}><Button small variant="outline" label="Unarchive" disabled={action.busy()} onPress={unarchive} /></If>}>
                {archivedText()}
              </Banner>
            </If>
            <If when={live.error() && !startFailed()}>
              <Banner tone="danger" title={live.session() ? "Live updates interrupted" : "Unable to open session"} actions={<Button small variant="outline" label="Reconnect and check access" onPress={live.reconnect} />}>
                {live.error()}
              </Banner>
            </If>
            <Feedback error={action.error()} notice={action.notice()} />
          </View>
        </If>
        <If when={live.view() && live.session()}
          else={
            <If when={live.error()} else={<Loading />}>
              <If when={live.session()} else={<View style={{ flex: 1 }} />}>
                {current => <UnavailableConversation id={props.id} session={current()} error={live.error()} recovered={() => { live.reconnect(); data.refreshSessions(); }} />}
              </If>
            </If>
          }>
          <Conversation id={props.id} live={live} host={host} pinned={pinned} dock={null}
            openSession={target => { data.refreshSessions(); props.openSession(target); }} />
        </If>
        <SessionPanel open={panelOpen()} onClose={() => panelOpen.set(false)} sessionId={props.id} session={live.session} view={live.view}
          refresh={() => { live.refresh(); data.refreshSessions(); }} go={route => { panelOpen.set(false); props.go(route); }}
          actions={actions} hosts={() => hosts.data()?.connectors ?? null} hostsLoading={hosts.loading} />
        <RenameSheet open={renaming()} title={live.session()?.title ?? ""} busy={actions.action.busy()} error={actions.action.error()} onClose={() => renaming.set(false)}
          onSave={title => void actions.rename(title).then(saved => { if (saved) renaming.set(false); })} />
      </View>
    </PeopleContext.Provider>
  );

  if (!props.page) return content;
  if (headerInPage) {
    return (
      <NavPage title={title()} headerVisible={false} style={pageStyle()}>
        <PageFrame>
          <PageHeader title={title()} onBack={props.onBack} actions={headerActions()} testID="session-header" />
          {content}
        </PageFrame>
      </NavPage>
    );
  }
  return (
    <NavPage title={title()} style={pageStyle()} headerRight={drawsHeaders ? undefined : headerActions()}
      header={drawsHeaders ? <PageHeader title={title()} onBack={props.onBack} actions={headerActions()} testID="session-header" /> : undefined}>
      {content}
    </NavPage>
  );
}

function Conversation(props: { id: string; live: LiveSessionState; host: Accessor<ConnectorInfo | undefined>; pinned: JSX.Element; dock: JSX.Element; openSession: (id: string) => void }) {
  const { user } = untracked(session);
  const data = useAppData();
  const current = () => props.live.session()!;
  const view = () => props.live.view()!;
  const owner = () => current().ownerId === user.id;
  const selection = signal<ChatSelection>(untracked(() => initialSelection(view())));
  const mode = signal<"write" | "ask">("write");
  const content = createDraft(props.id);
  const conversationId = signal("");
  const queueOpen = signal(false);
  let request: { key: string; id: string; images?: ChatImage[]; choice?: AutoChoiceAnswer } | null = null;
  const autoMode = createAutoMode(() => current().workspaceId);
  const autoChat = signal(false);
  const autoChosen = signal<string | undefined>(undefined);
  const autoChatOn = () => autoMode.enabled() && autoChat();
  const submission = createAction();
  const stopping = createAction();
  const rewinding = createAction();
  const copying = createAction();
  const receipt = signal<SubmitResult | null>(null);
  const list = signal<ListRef>();
  const expanded = signal<ReadonlySet<string>>(new Set());
  const permissions = () => current().permissions ?? [];
  const canWrite = () => permissions().includes("write");
  const canAsk = () => permissions().includes("ask");
  const imagesOf = () => (seesEntryImages(current()) ? current().id : undefined);
  const fileOptions = createFileOptions(() => current().workspaceId, props.host, canWrite);
  const attachments = createAttachments({ imagesUnavailable: () => imagesUnavailable(props.host()), fileOptions, sessionId: props.id });
  const withdrawing = createAction();
  const withdrawNotice = signal("");
  const actualMode = () => (mode() === "ask" && !canAsk() ? "write" : mode());
  const readOnly = () => current().status === "archived" || current().frozen === true;
  const permitted = () => !readOnly() && (actualMode() === "write" ? canWrite() : canAsk());
  const queue = () => view().queue ?? [];
  const activeQueue = computed(() => queue().filter(item => activeStatuses.includes(item.status)));
  const recentSubmissions = () => queue().filter(item => !activeStatuses.includes(item.status)).slice(-5).reverse();
  const canStop = () => Boolean(view().stoppable) && current().status !== "archived" && canWrite() && activeQueue().length > 0;
  const stopPending = () => queue().some(item => item.status === "stopping");
  const editable = computed(() => (view().withdrawable && !readOnly()
    ? activeQueue().filter(item => item.actorId === user.id && item.status === "queued" && (item.mode === "ask" ? canAsk() : canWrite())) : []));
  const editBlocked = () => attachments.images().length > 0;
  const sideConversations = computed(() => view().conversations.filter(item => item.mode === "ask" && (!item.actorId || item.actorId === user.id)));
  const shownConversation = (conversation: { id: string; mode?: string; actorId?: string } | undefined) => (actualMode() === "ask"
    ? conversation?.mode === "ask" && (!conversation.actorId || conversation.actorId === user.id) && (!conversationId() || conversation.id === conversationId())
    : conversation?.mode !== "ask");
  const transcript = computed(() => {
    const conversations = view().conversations;
    return pairToolResults(view().entries.filter(entry => {
      if (entry.role === "system" && !entry.text.trim()) return false;
      return shownConversation(conversations.find(item => item.id === entry.conversationId));
    }));
  });
  const entries = () => transcript().entries;
  const olderConversations = () => view().conversations.filter(conversation => (conversation.olderEntries ?? 0) > 0 && shownConversation(conversation));
  const olderCount = () => olderConversations().reduce((total, conversation) => total + (conversation.olderEntries ?? 0), 0);
  const loadingOlder = signal(false);
  function loadEarlier() {
    if (loadingOlder() || !olderConversations().length) return;
    loadingOlder.set(true);
    void Promise.all(olderConversations().map(conversation => props.live.loadOlder(conversation.id))).finally(() => loadingOlder.set(false));
  }
  effect(() => {
    actualMode();
    conversationId();
    list()?.scrollToEnd({ animated: false });
  });

  async function submit() {
    const text = content();
    const pasted = untracked(attachments.images);
    const attached = untracked(attachments.files);
    if (!permitted() || (!text.trim() && !pasted.length && !attached.length) || submission.busy()) return;
    const host = props.host();
    const kind = actualMode() === "ask" ? "ask" : "submit";
    const auto = autoChatOn() && host?.capabilities.chatOptions === true;
    const options = chatOptionsBody(host, selection(), kind);
    const unavailable = accessUnavailable(host, selection(), kind) ?? (auto ? undefined : modelUnavailable(host, selection()));
    receipt.set(null);
    withdrawNotice.set("");
    const sent = text;
    const key = `${kind}:${auto ? `auto:${selection().access}` : JSON.stringify(options ?? null)}:${[...pasted, ...attached].map(item => item.id).join(",")}:${sent}`;
    if (request?.key !== key) request = { key, id: randomId() };
    const pending = request;
    void submission.run(async () => {
      if (unavailable) throw new Error(unavailable);
      let chosen = selection();
      let sending = options;
      if (auto && host) {
        const choice = pending.choice ??= await autoMode.choose({ task: sent, connectorId: host.id });
        chosen = { ...chosen, model: { provider: choice.provider, modelId: choice.modelId }, thinkingLevel: choice.thinkingLevel };
        sending = chatOptionsBody(host, chosen, kind);
        autoChosen.set(host.models.find(item => item.provider === choice.provider && item.modelId === choice.modelId)?.name);
      }
      const images = pending.images ??= await encodeImages(pasted);
      const note = await attachments.upload(props.id, attached);
      const result = await session().api<SubmitResult>(`/api/sessions/${segment(props.id)}/${kind}`, { method: "POST",
        body: { content: withFilesNote(sent, note), requestId: pending.id, ...(sending ? { options: sending } : {}), ...(images.length ? { images } : {}) } });
      receipt.set(result);
      if (sending) data.rememberChat(host, chosen, view().agent);
      if (kind === "ask") conversationId.set(result.conversationId);
      forgetSentDraft(props.id, sent);
      attachments.sent(pasted, attached);
      request = null;
      props.live.refresh();
      list()?.scrollToEnd({ animated: true });
    });
  }

  function edit(submissionId: string) {
    if (withdrawing.busy() || submission.busy() || editBlocked()) return;
    withdrawNotice.set("");
    void withdrawing.run(async () => {
      const result = await session().api<WithdrawResult>(`/api/sessions/${segment(props.id)}/withdraw`, { method: "POST", body: { submissionId } });
      restoreDraft(props.id, result.content);
      restoreImages(props.id, imageBlobs(result.images ?? []));
      if (result.imagesLost) withdrawNotice.set("Its images were no longer on the host: attach them again before sending.");
      mode.set(result.mode);
      props.live.refresh();
    });
  }
  const recall = () => {
    const latest = untracked(editable).at(-1);
    if (latest) edit(latest.submissionId);
  };

  const scrolledUp = signal(false);
  function jumpToLatest() {
    scrolledUp.set(false);
    list()?.scrollToEnd({ animated: true });
  }

  function stop() {
    if (!canStop() || stopping.busy()) return;
    void stopping.run(async () => {
      await session().api(`/api/sessions/${segment(props.id)}/stop`, { method: "POST", body: {} });
      props.live.refresh();
    });
  }

  const working = () => view().busy || activeQueue().length > 0;

  async function copyMessage(entry: EntryView) {
    if (!await copying.run(() => Clipboard.writeText(copyText(entry)), "Message copied")) throw new Error("Not copied");
  }

  const messageActions: MessageActions = entry => {
    const cut = rewindable(view()) && actualMode() === "write" && !readOnly() ? messageCut(entry) : undefined;
    if (!cut) return {};
    const busy = rewinding.busy();
    return {
      ...(canWrite() ? { revert: { label: cut.before ? "Go back to before this message" : "Go back to this reply", disabled: busy, run: () => void revert(entry, cut.entryId, cut.before) } } : {}),
      ...(owner() || (canWrite() && view().memberForks === true) ? { fork: { label: "Fork a new session from here", disabled: busy, run: () => void fork(entry, cut.entryId, cut.before) } } : {}),
    };
  };

  async function revert(entry: EntryView, entryId: string, before: boolean) {
    if (working()) { void rewinding.run(async () => { throw new Error("Stop the session's work to go back to an earlier message."); }); return; }
    const confirmed = await confirm({
      title: before ? "Go back to before this message?" : "Go back to this reply?",
      message: `${before ? "This message and everything after it leave" : "Everything after this reply leaves"} the shared conversation, for everyone, and the agent continues from there.${before ? " The message goes back into your chat box, below anything typed there, to edit and send again." : ""} Only the conversation goes back: files, commits and pushes stay as they are.`,
      confirmLabel: "Go back", destructive: true,
    });
    if (!confirmed) return;
    void rewinding.run(async () => {
      await session().api(`/api/sessions/${segment(props.id)}/revert`, { method: "POST", body: { entryId } });
      if (before) restoreDraft(props.id, resendText(entry));
      props.live.refresh();
    });
  }

  async function fork(entry: EntryView, entryId: string, before: boolean) {
    const host = props.host();
    const hostOwner = host && host.ownerId !== user.id ? ` The host is ${host.ownerName}'s: it can access the new session, as it does this one.` : "";
    const confirmed = await confirm({
      title: "Fork a new session from here?",
      message: `A new session of yours starts on the same host and model with this conversation up to ${before ? "just before this message, which goes into its chat box" : "this reply"}, with this session's visibility. This session stays as it is.${hostOwner} Like every new session, the fork's worktree starts empty: its agent clones the workspace's repositories again.`,
      confirmLabel: "Fork session",
    });
    if (!confirmed) return;
    void rewinding.run(async () => {
      const result = await session().api<{ session: SessionRecord }>(`/api/sessions/${segment(props.id)}/fork`, { method: "POST", body: { entryId } });
      if (before) saveDraft(result.session.id, resendText(entry));
      props.openSession(result.session.id);
    });
  }

  const draftHasSecret = () => Boolean(content().trim()) && redactSecrets(content()) !== content();
  const queueLabel = () => {
    const queued = activeQueue().length > 0 ? ` · ${activeQueue().length} queued` : "";
    return preparingRepositories(view()) ? `Preparing repositories…${queued}`
      : stopPending() ? `Stopping…${queued}`
      : view().busy ? `${view().activity === "waiting" ? "Waiting for a decision" : "Working"}…${queued}`
      : activeQueue().length ? `${activeQueue().length} queued` : "Idle";
  };
  const name = createUsername();
  const sideIndex = () => sideConversations().findIndex(item => item.id === conversationId());
  const hint = () => current().status === "archived" ? "Read-only · this session is archived"
    : current().frozen ? "Read-only · this session pinned its repositories when it started"
    : !permitted() ? (canAsk() ? "Read-only · switch to Side ask to ask questions" : "Read-only · submitting needs write permission")
    : actualMode() === "ask" ? "Read-only · anyone who can view this session can see side asks"
    : `Runs as ${view().owner.displayName}${view().owner.id === user.id ? " (you)" : ""}`;
  const runsAsYou = () => hint().startsWith("Runs as") && view().owner.id === user.id;
  const bottomInset = () => (platform.desktop ? 12 : Math.max(keyboardFrame().height, safeArea().bottom, 12));

  const statusShown = () => working() || activeQueue().length > 0 || queueOpen();
  const statusTone = () => (stopPending() ? "warning" : view().busy && view().activity === "waiting" ? "warning" : "running");

  return (
    <>
      <View style={{ flex: 1 }} onTouchStart={releaseChatBox}>
      <List each={entries()} keyExtractor={entry => entry.id} ref={list} style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 }}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 80 }} testID="transcript"
        accessibilityLabel={actualMode() === "ask" ? "Side ask history" : "Shared session history"}
        scrollEventThrottle={100}
        onScroll={event => {
          const up = event.contentSize.height - event.offset.y - event.size.height > 240;
          if (up !== untracked(scrolledUp)) scrolledUp.set(up);
        }}
        onLoadMoreAtStart={() => { if (olderCount() > 0) loadEarlier(); }}
        header={() => (
          <If when={olderCount() > 0}>
            <View style={{ alignItems: "center", paddingBottom: 16 }}>
              <Button small variant="ghost" icon="chevron-up" busy={loadingOlder()} onPress={loadEarlier} label={`Show earlier messages (${olderCount()})`} testID="load-earlier" />
            </View>
          </If>
        )}
        empty={() => (
          <EmptyState title={actualMode() === "ask" ? "A question on the side" : "The conversation begins here"}>
            {actualMode() === "ask" ? "Ask about the work without changing it. Only you, and people who can view this session, see side asks." : "Messages, the agent's replies and its tool calls appear here."}
          </EmptyState>
        )}
        footer={() => <View style={{ width: "100%", maxWidth: 760, alignSelf: "center" }}>{props.pinned}</View>}>
        {entry => (
          <View style={{ width: "100%", maxWidth: 760, alignSelf: "center" }}>
            <TranscriptEntry entry={entry()} userId={user.id} imagesOf={imagesOf()} expanded={id => expanded().has(id)} onCopy={copyMessage} actions={messageActions}
              results={transcript().results.get(entry().id)}
              toggle={id => expanded.update(set => { const next = new Set(set); if (!next.delete(id)) next.add(id); return next; })} />
          </View>
        )}
      </List>
      <If when={scrolledUp()}>
        <View style={{ position: "absolute", bottom: 12, left: 0, right: 0, alignItems: "center" }}>
          <BaseButton testID="jump-to-latest" accessibilityLabel="Jump to the latest message" onPress={jumpToLatest}
            style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: palette().borderStrong,
              backgroundColor: palette().surfaceRaised }}
            hoverStyle={{ backgroundColor: palette().hoverStrong }} activeStyle={{ opacity: 0.8 }}>
            <Icon name="arrow-down" size={16} color={palette().text} />
          </BaseButton>
        </View>
      </If>
      </View>
      {props.dock}
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: bottomInset(), backgroundColor: palette().background }}>
        <View style={{ gap: 6, width: "100%", maxWidth: 800, alignSelf: "center" }}>
          <If when={statusShown()}>
            <BaseButton testID="queue-line" accessibilityLabel={`${queueLabel()}, ${queueOpen() ? "hide details" : "show details"}`} onPress={() => queueOpen.update(open => !open)}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", paddingHorizontal: 8, height: 26, borderRadius: radius.pill,
                backgroundColor: palette().tones[statusTone()].background }}
              hoverStyle={{ opacity: 0.85 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette().tones[statusTone()].text }} />
              <Text style={{ fontSize: text.caption, color: palette().tones[statusTone()].text }}>{queueLabel()}</Text>
              <Icon name={queueOpen() ? "chevron-up" : "chevron-down"} size={12} color={palette().tones[statusTone()].text} />
            </BaseButton>
          </If>
          <If when={queueOpen()}>
            <View style={{ gap: 6, padding: 12, borderRadius: radius.large, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
              <Small>Submissions and side asks share one queue; permissions are checked again before work runs. You can leave this screen: accepted work continues while the host is online and authorized.</Small>
              <If when={props.live.error()}><Small>This is the last received queue view; live host status is not confirmed.</Small></If>
              <If when={receipt()}>
                {last => <Small>{`Last receipt ${last().submissionId} · ${last().status}${last().queuePosition !== undefined ? ` · queue position ${last().queuePosition}` : ""}`}</Small>}
              </If>
              <Each of={activeQueue()} key={item => item.submissionId}>
                {(item, index) => (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <View style={{ flex: 1, minWidth: 200 }}>
                      <Small>{`${index() + 1}. ${item().mode === "ask" ? "Read-only side ask" : "Shared submission"} · ${item().status} · by ${name(item().actorId, true)} · receipt ${item().submissionId}`}</Small>
                    </View>
                    <If when={editable().some(candidate => candidate.submissionId === item().submissionId)}>
                      <Button testID="queue-edit" small variant="outline" icon="pencil" label="Edit" disabled={withdrawing.busy() || submission.busy() || editBlocked()}
                        onPress={() => edit(item().submissionId)} />
                    </If>
                  </View>
                )}
              </Each>
              <If when={editable().length > 0 && editBlocked()}>
                <Small>Remove the images from your chat box to edit a queued message there.</Small>
              </If>
              <Each of={recentSubmissions()} key={item => item.submissionId}>
                {item => <Small>{`${item().status} · ${item().mode === "ask" ? "Side ask" : "Shared submission"} · by ${name(item().actorId, true)} · receipt ${item().submissionId}`}</Small>}
              </Each>
              <View style={{ flexDirection: "row" }}><Button small icon="refresh" label="Refresh queue" onPress={props.live.refresh} /></View>
            </View>
          </If>
          <Composer value={content()} onChange={value => content.set(value)} onSubmit={() => void submit()} busy={submission.busy()} disabled={!permitted()}
            onStop={canStop() ? stop : undefined} stopping={stopping.busy()} attachments={attachments}
            onRecall={permitted() && editable().length > 0 && !editBlocked() ? recall : undefined}
            placeholder={!permitted() ? "Read-only" : editable().length && !editBlocked() ? (platform.desktop ? "Press ↑ to edit your queued message" : "Edit your queued message from the queue above")
              : actualMode() === "ask" ? "Ask a side question without changing anything" : "Message the agent"}
            sendLabel={actualMode() === "ask" ? "Send side ask" : "Submit to session"}
            hint={hint()}
            phoneHint={runsAsYou() ? "" : undefined}
            tools={
              <If when={canAsk() || permitted()}>
                <If when={canAsk()}>
                  <Picker<"write" | "ask"> title="Send as" value={actualMode()} onSelect={value => mode.set(value)}
                    trigger={<Chip testID="composer-mode" dense={phoneWidth()} icon={actualMode() === "ask" ? "message-question" : "users"} label={actualMode() === "ask" ? "Side ask" : "Shared"} />}
                    options={[
                      { value: "write", label: "Shared", icon: "users", hint: "Goes into the shared conversation; the agent can change the work" },
                      { value: "ask", label: "Side ask", icon: "message-question", hint: "A question on the side that doesn't change the work" },
                    ]} />
                </If>
                <If when={actualMode() === "ask" && sideConversations().length > 0}>
                  <Picker<string> title="Side conversation" value={conversationId()} onSelect={value => conversationId.set(value)}
                    trigger={<Chip dense={phoneWidth()} label={sideIndex() < 0 ? "All my side asks" : `Side ask ${sideIndex() + 1}`} />}
                    options={[{ value: "", label: "All my side asks" }, ...sideConversations().map((conversation, index) => ({ value: conversation.id, label: `Side ask ${index + 1}`, hint: conversation.id.slice(0, 8) }))]} />
                </If>
                <If when={permitted()}>
                  <ChatOptionsBar host={props.host()} value={selection()} onChange={value => selection.set(value)} showAccess={actualMode() === "write"}
                    auto={autoMode.enabled() ? { selected: autoChat(), chosen: autoChosen(), perMessage: true,
                      hint: "Chooses the model and reasoning for each message from how complex it looks, on this session's host",
                      onSelect: () => autoChat.set(true), onLeave: () => autoChat.set(false) } : undefined} />
                </If>
              </If>
            } />
          <If when={draftHasSecret()}>
            <Small testID="draft-secret" tone="warning">{`This message looks like it holds a secret. Everyone, you included, sees it as ${REDACTED} in the transcript, but the agent and its host receive it as typed.`}</Small>
          </If>
          <Feedback error={submission.error() || stopping.error() || withdrawing.error() || rewinding.error() || copying.error()} notice={withdrawNotice() || rewinding.notice() || copying.notice()} />
        </View>
      </View>
    </>
  );
}

function UnavailableConversation(props: { id: string; session: SessionRecord; error: string; recovered: () => void }) {
  const { user } = untracked(session);
  const content = createDraft(props.id);
  let request: { content: string; id: string } | null = null;
  const action = createAction();
  const failed = () => props.session.status === "error" || props.session.status === "provisioning";
  const canRestart = () => failed() && props.session.ownerId === user.id && Boolean(props.session.permissions?.includes("manage"));
  const canWrite = () => Boolean(props.session.permissions?.includes("write"));
  function send() {
    const sent = content();
    if (request?.content !== sent) request = { content: sent, id: randomId() };
    const requestId = request.id;
    void action.run(async () => {
      const { api } = session();
      await api(`/api/sessions/${segment(props.id)}/restart`, { method: "POST" });
      try {
        await api<SubmitResult>(`/api/sessions/${segment(props.id)}/submit`, { method: "POST", body: { content: sent, requestId } });
      } catch (reason) {
        saveDraft(props.id, sent);
        props.recovered();
        throw reason;
      }
      request = null;
      forgetSentDraft(props.id, sent);
      props.recovered();
    });
  }
  const title = () => props.session.status === "error" ? "This session didn't start" : props.session.status === "provisioning" ? "This session is still starting" : "This session can't be reached";
  const body = () => canRestart() ? "Send a message to start it again on its host. Your message runs once it's ready."
    : failed() ? "Only the session owner can start it again."
    : canWrite() ? "Messages can be sent once the host is back online."
    : "The conversation appears once the host is back online.";
  return (
    <>
      <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1 }}>
        <EmptyState title={title()}>{body()}</EmptyState>
        <If when={failed() && props.error}>
          <Small center>{props.error}</Small>
        </If>
      </Scroll>
      <View style={{ gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: platform.desktop ? 12 : Math.max(keyboardFrame().height, safeArea().bottom, 12), width: "100%", maxWidth: 800, alignSelf: "center" }}>
        <Composer value={content()} onChange={value => content.set(value)} onSubmit={send} busy={action.busy()} disabled={!canRestart()}
          placeholder={canRestart() ? "Message the agent to start the session again" : "Message the agent"}
          sendLabel={canRestart() ? "Restart and send" : "Sending is unavailable"}
          hint={action.busy() ? "Starting the session and preparing repositories..." : canRestart() ? "Restarts the session, then sends" : failed() ? "Only the owner can restart this session" : canWrite() ? "Waiting for the host" : "Read-only — submitting needs write permission"} />
        <Feedback error={action.error()} />
      </View>
    </>
  );
}
