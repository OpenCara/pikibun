import { cleanup, Clipboard, computed, effect, keyboardFrame, List, platform, safeArea, Scroll, signal, Text, untracked, View, type Accessor, type JSX, type ListRef } from "nsh";
import { AlertDialog, NavPage, Sheet } from "nsh/base";
import {
  accessUnavailable, activeStatuses, browserUnavailableText, chatOptionsBody, copyText, decidedAsHostCommand, decidesHostCommand, hostCommandWaiting,
  initialSelection, isHostCommand, managesSession, messageCut, modelUnavailable, mustConfirmAutoApprove, offersAlwaysApprove, preparingRepositories,
  REDACTED, redactSecrets, resendText, rewindable, segment, username, type ApprovalRecord, type ChatSelection, type ConnectorInfo, type EntryView,
  type SessionRecord, type SubmitResult,
} from "../shared";
import { ApprovalCard } from "../components/ApprovalCard";
import { ChatOptionsBar, confirmAutoApprove } from "../components/ChatOptionsBar";
import { Composer } from "../components/Composer";
import { RepositoryPreparationCard } from "../components/RepositoryPreparation";
import { TranscriptEntry } from "../components/TranscriptEntry";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createDraft, forgetSentDraft, restoreDraft, saveDraft } from "../lib/drafts";
import { randomId } from "../lib/format";
import { createLiveSession, type LiveSessionState } from "../lib/live-session";
import { createUsername, createWorkspacePeople, PeopleContext } from "../lib/people";
import { createAction, createResource } from "../lib/resource";
import { palette } from "../theme";
import { Badge, Banner, Button, Chip, confirm, EmptyState, Feedback, IconButton, Loading, OptionSheet, Segmented, Small } from "../ui";
import { drawsHeaders, PageHeader } from "./PageHeader";

/**
 * One session: live transcript, pending approvals and the chat box. As a page of the stack (`page`) it carries its
 * header; embedded beside the list (the wide layout) it draws its own title bar. Mounted per session id, so drafts,
 * request IDs and picks never leak between sessions.
 */
export function SessionView(props: { id: string; page: boolean; openSession: (id: string) => void; onBack?: () => void }) {
  const { user } = untracked(session);
  const data = useAppData();
  const live = createLiveSession(props.id);
  const approvalsOpen = signal(false);
  const permissions = () => live.session()?.permissions ?? [];
  // Archived sessions, and sessions that pinned their repositories when they started, are read-only on the server.
  const archived = () => live.session()?.status === "archived";
  const readOnly = () => archived() || live.session()?.frozen === true;
  const canApprove = () => permissions().includes("approve") && !readOnly();
  const isOwner = () => live.session()?.ownerId === user.id;
  const hosts = createResource<{ connectors: ConnectorInfo[] }>(() => {
    const current = live.session();
    return current?.connectorId ? `/api/workspaces/${segment(current.workspaceId)}/connectors` : null;
  }, 10_000);
  const host = () => hosts.data()?.connectors.find(item => item.id === live.session()?.connectorId);
  // A host that reconnects would otherwise wait out the live-update backoff (up to a minute).
  let previousOnline: boolean | undefined;
  effect(() => {
    const online = host()?.online;
    if (previousOnline === false && online) live.refresh();
    previousOnline = online;
  });
  const action = createAction();
  const approvalAction = createAction();
  const known = () => live.session() ?? data.sessions().find(item => item.id === props.id);
  // Everyone a session names (owner, host owner, writers, approvers) is or was a member of its workspace.
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
  const approvals = () => live.view()?.approvals ?? [];
  const pending = computed(() => approvals().filter(approval => approval.status === "pending"));
  // The workspace has the browser on but the host has no Chromium for it (yet), as on the web.
  const browserWarning = () => (readOnly() ? undefined
    : live.view()?.extensions?.unavailable?.find(item => item.source === "piki:browser" && ["missing", "failed", "downloading"].includes(item.reason)));
  const dismissedBrowser = signal(false);

  // Session lists show what this live view shows, not what they last fetched.
  effect(() => {
    const activity = live.view()?.activity;
    data.setLiveActivity(activity ? { sessionId: props.id, activity } : null);
  });
  cleanup(() => { data.setLiveActivity(null); data.refreshSessions(); });

  /** Whether the viewer decides `approval` (see the Expo app's SessionView for the rules). */
  function decides(approval: ApprovalRecord): boolean {
    const current = live.session() ?? {};
    if (readOnly()) return false;
    if (decidedAsHostCommand(approval.operation, current, approval.unbounded)) return decidesHostCommand(approval.operation, current, host(), user.id, permissions().includes("approve"));
    const ownerOnly = approval.operation.kind === "permission" || approval.operation.kind === "git.repin";
    return canApprove() && (!ownerOnly || isOwner());
  }

  async function decide(approval: ApprovalRecord, decision: "approve" | "deny", scope?: "call" | "session", always = false) {
    if (!decides(approval) || approvalAction.busy() || !approval.reviewHash || approval.status !== "pending") return;
    const name = (id: string) => username(people().person(id));
    // The card is the prompt: it shows the exact operation, who it runs as, its limits and any unsandboxed-host warning.
    const notice = approval.operation.kind === "permission"
      ? decision === "deny" ? "Not allowed" : scope === "session" ? "Allowed for the rest of the session" : "Allowed for this call"
      : always ? `Approved. ${name(approval.requestedBy)}'s requests here now run without asking; stop it under Approvals.`
      : decision === "approve" ? "Approval decision recorded" : "Operation denied";
    await approvalAction.run(async () => {
      await session().api(`/api/sessions/${segment(props.id)}/approvals/${segment(approval.id)}`, { method: "POST", body: { decision, reviewHash: approval.reviewHash, ...(scope ? { scope } : {}), ...(always ? { alwaysApprove: true } : {}) } });
      live.refresh();
    }, notice);
  }

  function unarchive() {
    void action.run(async () => {
      await session().api(`/api/sessions/${segment(props.id)}/unarchive`, { method: "POST" });
      live.refresh();
      data.refreshSessions();
    }, "Session unarchived");
  }

  const copyId = () => void action.run(() => Clipboard.writeText(props.id), "Session ID copied");

  // A failed start explains itself in the conversation area, where the chat box restarts it.
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <IconButton testID="session-approvals" icon="🛡" label={pending().length ? `Approvals, ${pending().length} pending` : "Approvals"} badge={pending().length}
        onPress={() => approvalsOpen.set(true)} disabled={!live.view()} />
      <IconButton testID="session-copy-id" icon="⧉" label="Copy session ID" onPress={copyId} />
    </View>
  );

  const pendingApprovalCard = (approval: Accessor<ApprovalRecord>) => {
    const permission = () => approval().operation.kind === "permission";
    const hostCommand = () => isHostCommand(approval().operation, live.session() ?? {});
    const hostDecided = () => decidedAsHostCommand(approval().operation, live.session() ?? {}, approval().unbounded);
    const ownerOnly = () => permission() || approval().operation.kind === "git.repin";
    const disabled = () => approvalAction.busy() || !approval().reviewHash;
    const always = () => {
      const current = live.session();
      return Boolean(current && offersAlwaysApprove(approval(), current, host(), user.id));
    };
    return (
      <ApprovalCard approval={approval()}>
        <If when={decides(approval())}
          else={<Small>{hostDecided() ? hostCommandWaiting(approval().operation, host()) : ownerOnly() ? "Waiting for the session owner" : "Waiting for an authorized approver"}</Small>}>
          <If when={!approval().reviewHash}>
            <Banner tone="warning" title="No verified review commitment" actions={<Button small label="Refresh approval" disabled={approvalAction.busy()} onPress={live.refresh} />}>
              Refresh before deciding; the server must bind the displayed operation and requester.
            </Banner>
          </If>
          <If when={permission()}
            else={
              <>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Button testID="approval-approve" small variant="primary" label="Approve" disabled={disabled()} onPress={() => void decide(approval(), "approve")} />
                  <If when={always()}>
                    <Button testID="approval-always" small label={`Always approve ${username(people().person(approval().requestedBy))}`} disabled={disabled()}
                      onPress={() => void decide(approval(), "approve", undefined, true)} />
                  </If>
                  <Button testID="approval-deny" small label="Deny" disabled={disabled()} onPress={() => void decide(approval(), "deny")} />
                </View>
                <Small testID="approval-hint">
                  {`Runs as ${hostCommand() ? "the host OS user (outside the sandbox)" : live.view()?.owner.displayName ?? ""} · each approval covers one exact operation and its arguments`}
                </Small>
              </>
            }>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button small variant="primary" label="Allow once" disabled={disabled()} onPress={() => void decide(approval(), "approve", "call")} />
              {/* Each host command asks again: it runs outside the sandbox. */}
              <If when={!(approval().operation.kind === "permission" && (approval().operation as { tool?: string }).tool === "host_bash")}>
                <Button small label="Allow for this session" disabled={disabled()} onPress={() => void decide(approval(), "approve", "session")} />
              </If>
              <Button small label="Deny" disabled={disabled()} onPress={() => void decide(approval(), "deny")} />
            </View>
          </If>
        </If>
      </ApprovalCard>
    );
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
            actions={<Button small label="Dismiss" onPress={() => dismissedBrowser.set(true)} />}>
            {`The workspace has the browser tool on, but this session can't use it. ${browserUnavailableText(warning().reason)}`}
          </Banner>
        )}
      </If>
      <If when={live.session()?.hostUnsandboxed && (permissions().includes("write") || canApprove())}>
        <If when={live.session()?.hostEnvironment}
          else={<Banner tone="danger" title="Unsandboxed host">This session's host runs without a sandbox. Approved commands and commits execute directly on the host owner's machine with their full user permissions, network access and no resource limits.</Banner>}>
          <Banner tone="danger" title="Runs on the host">This session runs directly on its host, without the sandbox. Approved commands and commits execute on the host owner's machine with their full user permissions, network access and no resource limits; only the host owner, or members they granted host commands, decide them.</Banner>
        </If>
      </If>
      <Each of={pending()} key={approval => approval.id}>{approval => pendingApprovalCard(approval)}</Each>
      <Feedback error={approvalAction.error()} notice={approvalAction.notice()} />
    </View>
  );

  const content = (
    <PeopleContext.Provider value={people}>
      <View style={{ flex: 1, backgroundColor: palette().background }}>
        <If when={!props.page}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, minHeight: 52, borderBottomWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
            <Text style={{ flex: 1, numberOfLines: 1, fontSize: 17, fontWeight: "700", color: palette().text }}>{title()}</Text>
            {headerActions()}
          </View>
        </If>
        <If when={live.session()}>
          {current => (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderColor: palette().border }}>
              <If when={workspace()?.name}>{name => <Small>{name()}</Small>}</If>
              <Badge tone={badge().tone} dot={badge().dot}>{badge().text}</Badge>
              <Badge>{current().visibility === "workspace" ? "Workspace-visible" : "Private"}</Badge>
              <If when={current().linkShared}><Badge tone="info">Link shared</Badge></If>
              <If when={host() && !host()!.online}><Badge tone="warning" dot>Host offline</Badge></If>
              <SessionPeople session={current()} host={host()} />
            </View>
          )}
        </If>
        <If when={archived() || (live.error() && !startFailed()) || action.error() || action.notice()}>
          <View style={{ gap: 8, paddingHorizontal: 16, paddingTop: 8 }}>
            <If when={archived()}>
              <Banner title="Archived" actions={<If when={manages()}><Button small label="Unarchive" disabled={action.busy()} onPress={unarchive} /></If>}>
                {`This session is read-only. ${manages() ? "Unarchive it to continue the work." : "Only its owner, or the workspace's owner or an admin, can unarchive it."}`}
              </Banner>
            </If>
            <If when={live.error() && !startFailed()}>
              <Banner tone="danger" title={live.session() ? "Live updates interrupted" : "Unable to open session"} actions={<Button small label="Reconnect and check access" onPress={live.reconnect} />}>
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
          <Conversation id={props.id} live={live} host={host} pinned={pinned}
            openSession={target => { data.refreshSessions(); props.openSession(target); }} />
        </If>
        <ApprovalsSheet open={approvalsOpen()} approvals={approvals()} olderApprovals={live.view()?.olderApprovals} onClose={() => approvalsOpen.set(false)}
          onOpenSession={target => { approvalsOpen.set(false); data.refreshSessions(); props.openSession(target); }} session={live.session()} onChanged={live.refresh} />
      </View>
    </PeopleContext.Provider>
  );

  if (!props.page) return content;
  return (
    <NavPage title={title()} headerRight={drawsHeaders ? undefined : headerActions()}
      header={drawsHeaders ? <PageHeader title={title()} onBack={props.onBack} actions={headerActions()} /> : undefined}>
      {content}
    </NavPage>
  );
}

/** Who the work runs as and whose machine it runs on, as the web's session panel names them. */
function SessionPeople(props: { session: SessionRecord; host: ConnectorInfo | undefined }) {
  const { user } = untracked(session);
  const name = createUsername();
  const hostOwner = () => props.host?.ownerName ?? (props.session.connectorOwnerId ? name(props.session.connectorOwnerId) : "unknown");
  return (
    <Text testID="session-people" style={{ width: "100%", numberOfLines: 2, fontSize: 13, lineHeight: 18, color: palette().muted }}>
      {`Owned by ${name(props.session.ownerId, true)}${props.session.connectorId
        ? ` · ${props.host?.name ?? "Pinned host"}, hosted by ${hostOwner()}${props.session.connectorOwnerId === user.id ? " (you)" : ""}`
        : " · Operator-managed session"}`}
    </Text>
  );
}

/** Every approval of the session, pending first, with what each decided one did. */
function ApprovalsSheet(props: {
  open: boolean; approvals: ApprovalRecord[]; olderApprovals?: number; onClose: () => void; onOpenSession: (id: string) => void;
  session: SessionRecord | null; onChanged: () => void;
}) {
  const { user } = untracked(session);
  const name = createUsername();
  const stopping = createAction();
  const always = () => props.session?.autoApprovedRequesters ?? [];
  function stop(requester: string) {
    const current = props.session;
    if (!current || stopping.busy()) return;
    void stopping.run(async () => {
      await session().api(`/api/sessions/${segment(current.id)}/auto-approved-requesters/${segment(requester)}`, { method: "DELETE" });
      props.onChanged();
    }, `${name(requester)}'s requests ask again.`);
  }
  const sorted = () => [...props.approvals].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  return (
    <Sheet open={props.open} side={platform.desktop ? "right" : "bottom"} closeOnSwipe onOpenChange={event => { if (!event.open) props.onClose(); }}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={platform.desktop
        ? { width: 480, maxWidth: "100%", height: "100%", backgroundColor: palette().background }
        : { height: "90%", borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: palette().background }}>
      <View testID="approvals-sheet" style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, minHeight: 52, borderBottomWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "700", color: palette().text }}>Approvals</Text>
          <Button small variant="ghost" label="Done" onPress={props.onClose} />
        </View>
        <Scroll style={{ flex: 1 }} contentStyle={{ gap: 12, padding: 16 }}>
          <If when={props.session && always().length > 0}>
            <Banner title="Auto-approved requesters">
              {`Requests from ${always().map(id => name(id)).join(", ")} run without asking.`}
            </Banner>
            <If when={props.session?.ownerId === user.id}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Each of={always()}>{requester => <Button small label={`Stop for ${name(requester())}`} disabled={stopping.busy()} onPress={() => stop(requester())} />}</Each>
              </View>
            </If>
            <Feedback error={stopping.error()} notice={stopping.notice()} />
          </If>
          <Small>Commands that ran under auto-approve are marked on their tool calls in the conversation.</Small>
          <If when={sorted().length > 0} else={<EmptyState title="No approvals yet">Commands, commits and pushes that need a decision appear here.</EmptyState>}>
            <Each of={sorted()} key={approval => approval.id}>
              {approval => <ApprovalCard approval={approval()} onOpenSession={props.onOpenSession} />}
            </Each>
          </If>
          <If when={(props.olderApprovals ?? 0) > 0}>
            <Small>{`${props.olderApprovals} older approvals are on the web app's session page.`}</Small>
          </If>
        </Scroll>
      </View>
    </Sheet>
  );
}

type MessageAction = "copy" | "revert" | "fork";

function Conversation(props: { id: string; live: LiveSessionState; host: Accessor<ConnectorInfo | undefined>; pinned: JSX.Element; openSession: (id: string) => void }) {
  const { user } = untracked(session);
  const data = useAppData();
  const askAutoApprove = confirmAutoApprove(data);
  const current = () => props.live.session()!;
  const view = () => props.live.view()!;
  const owner = () => current().ownerId === user.id;
  // Initialised once per session; view refreshes never reset the user's picks.
  const selection = signal<ChatSelection>(untracked(() => initialSelection(view(), owner())));
  const mode = signal<"write" | "ask">("write");
  // The unsent text is remembered until it is sent, so switching to another session and back keeps it.
  const content = createDraft(props.id);
  const conversationId = signal("");
  const pickingConversation = signal(false);
  const queueOpen = signal(false);
  let request: { key: string; id: string } | null = null;
  // Set while the owner decides on Auto-approve, so a second tap can't send the message twice.
  let confirming = false;
  const submission = createAction();
  const stopping = createAction();
  const rewinding = createAction();
  const receipt = signal<SubmitResult | null>(null);
  const list = signal<ListRef>();
  const expanded = signal<ReadonlySet<string>>(new Set());
  const permissions = () => current().permissions ?? [];
  const canWrite = () => permissions().includes("write");
  const canAsk = () => permissions().includes("ask");
  const actualMode = () => (mode() === "ask" && !canAsk() ? "write" : mode());
  const readOnly = () => current().status === "archived" || current().frozen === true;
  const permitted = () => !readOnly() && (actualMode() === "write" ? canWrite() : canAsk());
  const unsandboxed = () => Boolean(current().hostUnsandboxed || props.host()?.capabilities.unsandboxed);
  const queue = () => view().queue ?? [];
  const activeQueue = computed(() => queue().filter(item => activeStatuses.includes(item.status)));
  const recentSubmissions = () => queue().filter(item => !activeStatuses.includes(item.status)).slice(-5).reverse();
  // Stopping takes the running message and everything queued; hosts that predate it don't offer it.
  const canStop = () => Boolean(view().stoppable) && current().status !== "archived" && canWrite() && activeQueue().length > 0;
  const stopPending = () => queue().some(item => item.status === "stopping");
  const sideConversations = computed(() => view().conversations.filter(item => item.mode === "ask" && (!item.actorId || item.actorId === user.id)));
  const shownConversation = (conversation: { id: string; mode?: string; actorId?: string } | undefined) => (actualMode() === "ask"
    ? conversation?.mode === "ask" && (!conversation.actorId || conversation.actorId === user.id) && (!conversationId() || conversation.id === conversationId())
    : conversation?.mode !== "ask");
  const entries = computed(() => {
    const conversations = view().conversations;
    return view().entries.filter(entry => {
      if (entry.role === "system" && !entry.text.trim()) return false;
      return shownConversation(conversations.find(item => item.id === entry.conversationId));
    });
  });
  // In a workspace that loads transcripts latest first: the shown conversations with earlier entries still to read.
  const olderConversations = () => view().conversations.filter(conversation => (conversation.olderEntries ?? 0) > 0 && shownConversation(conversation));
  const olderCount = () => olderConversations().reduce((total, conversation) => total + (conversation.olderEntries ?? 0), 0);
  const loadingOlder = signal(false);
  function loadEarlier() {
    if (loadingOlder() || !olderConversations().length) return;
    loadingOlder.set(true);
    void Promise.all(olderConversations().map(conversation => props.live.loadOlder(conversation.id))).finally(() => loadingOlder.set(false));
  }
  // Switching conversations starts at their newest entry; the list keeps to the end as entries arrive.
  effect(() => {
    actualMode();
    conversationId();
    list()?.scrollToEnd({ animated: false });
  });

  async function submit() {
    const text = content();
    if (!permitted() || !text.trim() || submission.busy() || confirming) return;
    const host = props.host();
    const kind = actualMode() === "ask" ? "ask" : "submit";
    const options = chatOptionsBody(host, selection(), kind);
    const unavailable = accessUnavailable(host, selection(), kind) ?? modelUnavailable(host, selection());
    // The owner's chat box can start on Auto-approve without asking, and it merges too: the first message that would asks.
    if (!unavailable && host && mustConfirmAutoApprove(options, data.autoApproveConfirmed())) {
      confirming = true;
      const confirmed = await askAutoApprove(host, unsandboxed()).finally(() => { confirming = false; });
      if (!confirmed) { selection.update(value => ({ ...value, access: "approval" })); return; }
    }
    receipt.set(null);
    const sent = text;
    // Changing the options is a different request, so it needs a new idempotency key.
    const key = `${kind}:${JSON.stringify(options ?? null)}:${sent}`;
    // Retry the same failed submission with the same idempotency key, not a duplicate turn.
    if (request?.key !== key) request = { key, id: randomId() };
    const requestId = request.id;
    void submission.run(async () => {
      if (unavailable) throw new Error(unavailable);
      const result = await session().api<SubmitResult>(`/api/sessions/${segment(props.id)}/${kind}`, { method: "POST", body: { content: sent, requestId, ...(options ? { options } : {}) } });
      receipt.set(result);
      if (options) data.rememberChat(host, selection(), view().agent);
      if (kind === "ask") conversationId.set(result.conversationId);
      forgetSentDraft(props.id, sent);
      request = null;
      props.live.refresh();
      list()?.scrollToEnd({ animated: true });
    });
  }

  function stop() {
    if (!canStop() || stopping.busy()) return;
    void stopping.run(async () => {
      await session().api(`/api/sessions/${segment(props.id)}/stop`, { method: "POST", body: {} });
      props.live.refresh();
    });
  }

  const working = () => view().busy || activeQueue().length > 0;

  /** A message's actions, in the platform's own action sheet: copy it; go back to it; fork a new session from it. */
  async function showActions(entry: EntryView) {
    const cut = rewindable(view()) && actualMode() === "write" && !readOnly() ? messageCut(entry) : undefined;
    const actions: { id: MessageAction; label: string; role?: "destructive" }[] = [
      { id: "copy", label: "Copy message" },
      ...(cut && canWrite() ? [{ id: "revert" as const, label: cut.before ? "Go back to before this message" : "Go back to this reply", role: "destructive" as const }] : []),
      ...(cut && owner() ? [{ id: "fork" as const, label: "Fork a new session from here" }] : []),
    ];
    const result = await AlertDialog.show({ title: "Message", presentation: "actionSheet", actions: [...actions, { id: "cancel", label: "Cancel", role: "cancel" }] });
    const choice = result.action as MessageAction | "cancel" | null | undefined;
    if (choice === "copy") { void rewinding.run(() => Clipboard.writeText(copyText(entry)), "Message copied"); return; }
    if (!cut || (choice !== "revert" && choice !== "fork")) return;
    if (choice === "revert") await revert(entry, cut.entryId, cut.before);
    else await fork(entry, cut.entryId, cut.before);
  }

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
    const confirmed = await confirm({
      title: "Fork a new session from here?",
      message: `A new session of yours starts on the same host and model with this conversation up to ${before ? "just before this message, which goes into its chat box" : "this reply"}. This session stays as it is. Like every new session, the fork's worktree starts empty: its agent clones the workspace's repositories again.`,
      confirmLabel: "Fork session",
    });
    if (!confirmed) return;
    void rewinding.run(async () => {
      const result = await session().api<{ session: SessionRecord }>(`/api/sessions/${segment(props.id)}/fork`, { method: "POST", body: { entryId } });
      if (before) saveDraft(result.session.id, resendText(entry));
      props.openSession(result.session.id);
    });
  }

  // The transcript hides secrets from everyone, but the agent and its host receive the message as typed.
  const draftHasSecret = () => Boolean(content().trim()) && redactSecrets(content()) !== content();
  const queueLabel = () => {
    const queued = activeQueue().length > 0 ? ` · ${activeQueue().length} queued` : "";
    return preparingRepositories(view()) ? `Preparing repositories...${queued}`
      : stopPending() ? `Stopping...${queued}`
      // A call waiting on a card holds its message until someone decides.
      : view().busy ? `${view().activity === "waiting" ? "Waiting for a decision" : "Working"}...${queued}`
      : activeQueue().length ? `${activeQueue().length} queued` : "Idle";
  };
  const name = createUsername();
  const sideIndex = () => sideConversations().findIndex(item => item.id === conversationId());
  const hint = () => current().status === "archived" ? "Read-only · this session is archived"
    : current().frozen ? "Read-only · this session pinned its repositories when it started"
    : !permitted() ? (canAsk() ? "Read-only · switch to Side ask to ask questions" : "Read-only · submitting needs write permission")
    : actualMode() === "ask" ? "Read-only · anyone who can view this session can see side asks"
    : `Runs as ${view().owner.displayName}${view().owner.id === user.id ? " (you)" : ""}`;
  // Phones keep the chat box above the software keyboard and the home indicator.
  const bottomInset = () => (platform.desktop ? 8 : Math.max(keyboardFrame().height, safeArea().bottom, 8));

  return (
    <>
      <List each={entries()} keyExtractor={entry => entry.id} ref={list} style={{ flex: 1 }} contentStyle={{ padding: 16 }}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 80 }} testID="transcript"
        accessibilityLabel={actualMode() === "ask" ? "Side ask history" : "Shared session history"}
        header={() => (
          <If when={olderCount() > 0}>
            <View style={{ alignItems: "center", paddingBottom: 12 }}>
              <Button small variant="ghost" icon="↑" busy={loadingOlder()} onPress={loadEarlier} label={`Show earlier messages (${olderCount()})`} testID="load-earlier" />
            </View>
          </If>
        )}
        empty={() => (
          <EmptyState title={actualMode() === "ask" ? "A question on the side" : "The conversation begins here"}>
            {actualMode() === "ask" ? "Ask about the work without changing it" : "Committed messages and tool results will appear here"}
          </EmptyState>
        )}
        footer={() => props.pinned}>
        {entry => (
          <TranscriptEntry entry={entry()} userId={user.id} expanded={id => expanded().has(id)} onActions={entry => void showActions(entry)}
            toggle={id => expanded.update(set => { const next = new Set(set); if (!next.delete(id)) next.add(id); return next; })} />
        )}
      </List>
      <View style={{ gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: bottomInset(), borderTopWidth: 1, borderColor: palette().border, backgroundColor: palette().background }}>
        <View testID="queue-line" role="button" onPress={() => queueOpen.update(open => !open)} style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 4 }}>
          <Small>{queueLabel()}</Small>
          <Small>{queueOpen() ? "Hide" : "Details"}</Small>
        </View>
        <If when={queueOpen()}>
          <View style={{ gap: 6, paddingHorizontal: 4 }}>
            <Small>Submissions and side asks share one queue; permissions are checked again before work runs. You can leave this screen: accepted work continues while the host is online and authorized.</Small>
            <If when={props.live.error()}><Small>This is the last received queue view; live host status is not confirmed.</Small></If>
            <If when={receipt()}>
              {last => <Small>{`Last receipt ${last().submissionId} · ${last().status}${last().queuePosition !== undefined ? ` · queue position ${last().queuePosition}` : ""}`}</Small>}
            </If>
            <Each of={activeQueue()} key={item => item.submissionId}>
              {(item, index) => <Small>{`${index() + 1}. ${item().mode === "ask" ? "Read-only side ask" : "Shared submission"} · ${item().status} · by ${name(item().actorId, true)}`}</Small>}
            </Each>
            <Each of={recentSubmissions()} key={item => item.submissionId}>
              {item => <Small>{`${item().status} · ${item().mode === "ask" ? "Side ask" : "Shared submission"} · by ${name(item().actorId, true)}`}</Small>}
            </Each>
            <View style={{ flexDirection: "row" }}><Button small icon="↻" label="Refresh queue" onPress={props.live.refresh} /></View>
          </View>
        </If>
        <Composer value={content()} onChange={value => content.set(value)} onSubmit={() => void submit()} busy={submission.busy()} disabled={!permitted()}
          onStop={canStop() ? stop : undefined} stopping={stopping.busy()}
          placeholder={!permitted() ? "Read-only" : actualMode() === "ask" ? "Ask without changing anything" : "Message the agent"}
          sendLabel={actualMode() === "ask" ? "Send side ask" : "Submit to session"}
          hint={hint()}
          tools={
            <If when={canAsk() || permitted()}>
              <If when={canAsk()}>
                <Segmented testID="composer-mode" value={actualMode()} onChange={value => mode.set(value)}
                  options={[{ value: "write", label: "Shared" }, { value: "ask", label: "Side ask" }]} />
              </If>
              <If when={actualMode() === "ask" && sideConversations().length > 0}>
                <Chip label={sideIndex() < 0 ? "All my side asks" : `Side ask ${sideIndex() + 1}`} onPress={() => pickingConversation.set(true)} />
              </If>
              <If when={permitted()}>
                <ChatOptionsBar host={props.host()} value={selection()} onChange={value => selection.set(value)} owner={owner()} showAccess={actualMode() === "write"}
                  unsandboxed={unsandboxed()} data={data} />
              </If>
            </If>
          } />
        <If when={draftHasSecret()}>
          <Small testID="draft-secret">{`This message looks like it holds a secret. Everyone, you included, sees it as ${REDACTED} in the transcript, but the agent and its host receive it as typed.`}</Small>
        </If>
        <Feedback error={submission.error() || stopping.error() || rewinding.error()} notice={rewinding.notice()} />
      </View>
      <OptionSheet<string> open={pickingConversation()} title="Side conversation" value={conversationId()} onClose={() => pickingConversation.set(false)}
        onSelect={value => conversationId.set(value)}
        options={[{ value: "", label: "All my side asks" }, ...sideConversations().map((conversation, index) => ({ value: conversation.id, label: `Side ask ${index + 1}`, hint: conversation.id.slice(0, 8) }))]} />
    </>
  );
}

/**
 * Shown when the transcript cannot load. A session whose start failed is restarted by its owner's next message:
 * restart re-provisions on the pinned host, then the message is submitted.
 */
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
    // Same text retried after a failure keeps its idempotency key.
    if (request?.content !== sent) request = { content: sent, id: randomId() };
    const requestId = request.id;
    void action.run(async () => {
      const { api } = session();
      await api(`/api/sessions/${segment(props.id)}/restart`, { method: "POST" });
      try {
        await api<SubmitResult>(`/api/sessions/${segment(props.id)}/submit`, { method: "POST", body: { content: sent, requestId } });
      } catch (reason) {
        // The session is running again; hand the unsent text to the live conversation.
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
      <View style={{ gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: platform.desktop ? 8 : Math.max(keyboardFrame().height, safeArea().bottom, 8), borderTopWidth: 1, borderColor: palette().border }}>
        <Composer value={content()} onChange={value => content.set(value)} onSubmit={send} busy={action.busy()} disabled={!canRestart()}
          placeholder={canRestart() ? "Message the agent to start the session again" : "Message the agent"}
          sendLabel={canRestart() ? "Restart and send" : "Sending is unavailable"}
          hint={action.busy() ? "Starting the session and preparing repositories..." : canRestart() ? "Restarts the session, then sends" : failed() ? "Only the owner can restart this session" : canWrite() ? "Waiting for the host" : "Read-only — submitting needs write permission"} />
        <Feedback error={action.error()} />
      </View>
    </>
  );
}
