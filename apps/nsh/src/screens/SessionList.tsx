import { cleanup, computed, createAnimatedValue, effect, List, signal, Text, untracked, View, type AnimatedValue, type PanEvent, type ViewRef } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { writeClipboard } from "../lib/clipboard";
import { canCreateSessions, errorMessage, nestSessions, pullRequestStateLabels, sessionStatus, type SessionRecord, type SideAskSummary } from "../shared";
import { pullRequestColor, pullRequestLabel, pullRequestTitle } from "../components/PullRequest";
import { createSessionMenu, RenameSheet, type SessionMenu } from "../components/SessionMenu";
import { useAppData } from "../lib/app-data";
import { stableRows } from "../lib/stable-rows";
import { dropAt, dropIndex, movableIds, moveBy, type HeaderPlace } from "../lib/workspace-order";
import { session } from "../lib/auth";
import { type Action } from "../lib/resource";
import { Icon } from "../icons";
import { palette, radius, text, type Tone } from "../theme";
import {
  Banner, Button, DropdownMenu, EmptyState, Feedback, IconButton, IdentityBadge, Loading, RowMenu, rowPress, SearchField, StatusDot, SwipeRow, swipesRows, type MenuAction,
} from "../ui";

type Row =
  | { kind: "workspace"; key: string; id: string; title: string; count: number; archived: number; showArchived: boolean; canCreate: boolean }
  | { kind: "session"; key: string; session: SessionRecord; depth: number }
  | { kind: "ask"; key: string; session: SessionRecord; ask: SideAskSummary; depth: number }
  | { kind: "start"; key: string; workspaceId: string };

export function sessionRows(sessions: readonly SessionRecord[]): Extract<Row, { kind: "session" | "ask" }>[] {
  return nestSessions(sessions).flatMap(({ session: item, depth }) => [
    { kind: "session" as const, key: item.id, session: item, depth },
    ...(item.sideAsks ?? []).map(ask => ({ kind: "ask" as const, key: `${item.id}:ask:${ask.conversationId}`, session: item, ask, depth: Math.min(depth + 1, 4) })),
  ]);
}

export function shortAge(value: string, now = Date.now()): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10_080) return `${Math.floor(minutes / 1440)}d`;
  const date = new Date(time);
  return `${date.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()]}`;
}

export function sessionOwnerLabel(item: Pick<SessionRecord, "ownerId" | "ownerName" | "permissions">, userId: string): string {
  if (item.ownerId === userId) return "";
  const viewer = Boolean(item.permissions?.length) && item.permissions!.every(permission => permission === "read");
  const owner = item.ownerName?.trim();
  return owner ? `${owner}${viewer ? " · Viewer" : ""}` : viewer ? "Viewer" : "Shared";
}

export function forwardedLabel(item: Pick<SessionRecord, "forwarded">, severalComputers: boolean): string {
  const forwarded = item.forwarded;
  if (!forwarded) return "";
  return [...(severalComputers ? [forwarded.hostName] : []), ...(forwarded.online ? [] : ["Offline"])].join(" · ");
}

export function matchesSession(item: Pick<SessionRecord, "title" | "ownerName">, needle: string): boolean {
  return !needle || item.title.toLowerCase().includes(needle) || Boolean(item.ownerName?.toLowerCase().includes(needle));
}

export function SessionList(props: {
  selectedId?: string | null; onOpen: (id: string) => void; onNew: () => void; compact?: boolean;
  onNewIn?: (workspaceId: string) => void; onWorkspaceSettings?: (workspaceId: string) => void; onNewWorkspace?: () => void;
}) {
  const data = useAppData();
  const menu = createSessionMenu();
  const query = signal("");
  const showArchived = signal<readonly string[]>([]);
  const collapsed = signal<readonly string[]>([]);
  const swiped = signal<string | null>(null);
  const swipe = (id: string, open: boolean) => swiped.update(current => (open ? id : current === id ? null : current));
  const severalComputers = computed(() => new Set(data.sessions().flatMap(item => (item.forwarded ? [item.forwarded.hostName] : []))).size > 1);
  const groupedRows = computed<Row[]>(() => {
    const needle = query().trim().toLowerCase();
    const byWorkspace = new Map<string, SessionRecord[]>();
    const archived = new Map<string, number>();
    for (const item of data.sessions()) {
      if (!matchesSession(item, needle)) continue;
      if (item.status === "archived") {
        archived.set(item.workspaceId, (archived.get(item.workspaceId) ?? 0) + 1);
        if (!showArchived().includes(item.workspaceId)) continue;
      }
      const list = byWorkspace.get(item.workspaceId);
      if (list) list.push(item);
      else byWorkspace.set(item.workspaceId, [item]);
    }
    for (const id of [...(needle ? [] : data.workspaces().map(workspace => workspace.id)), ...archived.keys()]) if (!byWorkspace.has(id)) byWorkspace.set(id, []);
    const order = data.workspaces().map(workspace => workspace.id);
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    return [...byWorkspace.entries()].sort(([a], [b]) => rank(a) - rank(b)).flatMap(([id, sessions]): Row[] => {
      const workspace = data.workspaces().find(item => item.id === id);
      const canCreate = Boolean(workspace && canCreateSessions(workspace.role));
      const folded = collapsed().includes(id) && !needle;
      return [
        { kind: "workspace", key: `workspace:${id}`, id, count: sessions.length, archived: archived.get(id) ?? 0, showArchived: showArchived().includes(id), canCreate,
          title: workspace?.name ?? "Other workspace" },
        ...(folded ? [] : sessionRows(sessions)),
        ...(!folded && !needle && !sessions.length && canCreate && props.onNewIn ? [{ kind: "start" as const, key: `start:${id}`, workspaceId: id }] : []),
      ];
    });
  });
  const keep = stableRows<Row>();
  const rows = computed<Row[]>(() => keep(groupedRows()));
  const order = computed(() => (query().trim() ? [] : movableIds(data.workspaces())));
  const headers = new Map<ViewRef, string>();
  const dragging = signal<string | null>(null);
  const landing = signal<number | null>(null);
  let places: Promise<HeaderPlace[]> = Promise.resolve([]);
  let watch: ReturnType<typeof setInterval> | undefined;
  cleanup(() => clearInterval(watch));
  const orderError = signal("");
  const reorder = (next: string[] | null) => {
    if (!next) return;
    orderError.set("");
    data.reorderWorkspaces(next).catch(reason => orderError.set(errorMessage(reason)));
  };
  const header = (ref: ViewRef, id: string | null) => { if (id) headers.set(ref, id); else headers.delete(ref); };
  const measure = async (): Promise<HeaderPlace[]> => {
    const found = await Promise.all([...headers].map(async ([ref, id]) => {
      const place = await ref.measure().catch(() => null);
      return { ref, id, place: place ? { top: place.pagePosition.y, height: place.bounds.size.height } : null };
    }));
    const shown = new Set(found.filter(item => item.place).map(item => item.id));
    for (const item of found) if (!item.place && shown.has(item.id)) headers.delete(item.ref);
    return found.flatMap(item => (item.place ? [{ id: item.id, ...item.place }] : []));
  };
  const drag: WorkspaceDrag = {
    start(id, value, event) {
      dragging.set(id);
      landing.set(null);
      places = measure();
      clearInterval(watch);
      watch = setInterval(() => {
        void Promise.all([places, value.getValue()]).then(([found, moved]) => {
          if (untracked(dragging) === id) landing.set(dropIndex(untracked(order), id, found, event.origin.y + moved));
        }, () => undefined);
      }, 80);
    },
    async end(id, event) {
      clearInterval(watch);
      const found = await places;
      dragging.set(null);
      landing.set(null);
      if (event.cancelled) return;
      const ids = untracked(order);
      reorder(dropAt(ids, id, dropIndex(ids, id, found, event.origin.y + event.translation.y)));
    },
  };
  const dropLine = computed(() => {
    const dragged = dragging();
    const at = landing();
    if (!dragged || at === null || !dropAt(order(), dragged, at)) return null;
    return order().filter(id => id !== dragged)[at] ?? "end";
  });
  const move = (id: string, step: number) => reorder(moveBy(untracked(order), id, step));
  const flip = (id: string) => (current: readonly string[]) => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const toggle = (id: string) => collapsed.update(flip(id));
  const toggleArchived = (id: string) => {
    const showing = !untracked(showArchived).includes(id);
    showArchived.update(flip(id));
    if (showing) collapsed.update(current => current.filter(item => item !== id));
  };
  const refreshing = signal(false);
  let pulls = 0;
  function pullToRefresh() {
    const pull = ++pulls;
    refreshing.set(true);
    void Promise.all([data.refreshSessions(), data.refreshWorkspaces()]).finally(() => { if (pull === pulls) refreshing.set(false); });
  }
  const inset = () => (props.compact ? 8 : 12);

  return (
    <If when={!data.sessionsLoading()} else={<Loading />}>
      <List each={rows()} keyExtractor={row => row.key} testID="session-list" style={{ flex: 1 }} estimatedItemSize={props.compact ? 40 : 52} refreshing={refreshing()} onRefresh={pullToRefresh}
        contentStyle={{ paddingBottom: 16 }} onScrollDragStart={() => { if (untracked(swiped)) swiped.set(null); }}
        header={() => (
          <View style={{ gap: 8, paddingHorizontal: inset(), paddingTop: 4, paddingBottom: 8 }}>
            <SearchField compact={props.compact} value={query()} onChange={value => query.set(value)} placeholder="Search sessions"
              label="Search sessions by title or owner" testID="session-search" />
            <If when={data.sessionsError()}>
              <Banner tone="danger" title="Could not load sessions" actions={<Button small variant="outline" label="Try again" onPress={data.refreshSessions} />}>{data.sessionsError()}</Banner>
            </If>
            <If when={orderError()}>
              <View testID="workspace-order-feedback" style={{ paddingHorizontal: 4 }}><Feedback error={orderError()} /></View>
            </If>
            <If when={!menu.renaming() && (menu.action.error() || menu.action.notice())}>
              <View testID="session-list-feedback" style={{ paddingHorizontal: 4 }}><Feedback error={menu.action.error()} notice={menu.action.notice()} /></View>
            </If>
          </View>
        )}
        footer={() => (
          <View style={{ paddingHorizontal: inset(), paddingTop: 12, gap: 2 }}>
            <If when={dropLine() === "end"}>
              <View testID="workspace-drop-line" style={{ height: 2, borderRadius: 1, marginTop: -8, marginBottom: 6, backgroundColor: palette().tones.info.text }} />
            </If>
            <If when={props.onNewWorkspace && data.workspaces().length > 0}>
              <BaseButton testID="sidebar-new-workspace" accessibilityLabel="New workspace" onPress={() => props.onNewWorkspace?.()}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, minHeight: 34, borderRadius: radius.medium }}
                hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
                <Icon name="plus" size={14} color={palette().muted} />
                <Text style={{ fontSize: text.body, color: palette().muted }}>New workspace</Text>
              </BaseButton>
            </If>
          </View>
        )}
        empty={() => (
          <If when={data.sessions().length > 0}
            else={
              <If when={data.workspaces().length > 0 || !props.onNewWorkspace}
                else={
                  <EmptyState title="No workspaces yet" action={<Button testID="list-new-workspace" label="New workspace" icon="plus" small onPress={() => props.onNewWorkspace?.()} />}>
                    A workspace groups people, repositories, hosts and sessions.
                  </EmptyState>
                }>
                <EmptyState title="No sessions yet" action={<Button label="New session" icon="plus" variant="primary" onPress={props.onNew} />}>Start one to put an agent to work on your workspace's repositories.</EmptyState>
              </If>
            }>
            <EmptyState title="No matching sessions" />
          </If>
        )}>
        {row => (
          <View style={{ paddingHorizontal: inset() }}>
            <If when={row().kind === "session" ? row() as Extract<Row, { kind: "session" }> : null}
              else={
                <If when={row().kind === "ask" ? row() as Extract<Row, { kind: "ask" }> : null}
                  else={
                <If when={row().kind === "start" ? row() as Extract<Row, { kind: "start" }> : null}
                  else={
                    <WorkspaceRow row={row() as Extract<Row, { kind: "workspace" }>} collapsed={collapsed().includes((row() as Extract<Row, { kind: "workspace" }>).id)}
                      onToggle={toggle} onToggleArchived={toggleArchived} compact={props.compact} onNewIn={props.onNewIn} onSettings={props.onWorkspaceSettings} action={menu.action}
                      order={order()} dragging={dragging() === (row() as Extract<Row, { kind: "workspace" }>).id}
                      dropLine={dropLine() === (row() as Extract<Row, { kind: "workspace" }>).id} drag={drag} onHeader={header} onMove={move} />
                  }>
                  {start => (
                    <BaseButton testID={`workspace-start-${start().workspaceId}`} accessibilityLabel="Start a session" onPress={() => props.onNewIn?.(start().workspaceId)}
                      style={{ flexDirection: "row", alignItems: "center", minHeight: props.compact ? 34 : 44, paddingLeft: 32, paddingRight: 8, borderRadius: radius.medium }}
                      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
                      <Text style={{ fontSize: text.body, color: palette().muted }}>Start a session</Text>
                    </BaseButton>
                  )}
                </If>
                  }>
                  {ask => (
                    <SideAskRow session={ask().session} ask={ask().ask} depth={ask().depth} compact={props.compact}
                      onOpen={(sessionId, conversationId) => { data.requestSideAsk({ sessionId, conversationId }); props.onOpen(sessionId); }} />
                  )}
                </If>
              }>
              {item => (
                <SessionRow item={item().session} depth={item().depth} selected={item().session.id === props.selectedId} severalComputers={severalComputers()}
                  onOpen={id => { data.requestSideAsk({ sessionId: id, conversationId: null }); props.onOpen(id); }} compact={props.compact} menu={menu}
                  swiped={swiped() === item().session.id} onSwipe={open => swipe(item().session.id, open)} />
              )}
            </If>
          </View>
        )}
      </List>
      <RenameSheet open={menu.renaming() !== null} title={menu.renaming()?.title ?? ""} busy={menu.action.busy()} error={menu.action.error()}
        onClose={menu.closeRename} onSave={menu.rename} />
    </If>
  );
}

interface WorkspaceDrag {
  start: (id: string, value: AnimatedValue, event: PanEvent) => void;
  end: (id: string, event: PanEvent) => void;
}

function WorkspaceRow(props: {
  row: Extract<Row, { kind: "workspace" }>; collapsed: boolean; onToggle: (id: string) => void; onToggleArchived: (id: string) => void; compact?: boolean;
  onNewIn?: (workspaceId: string) => void; onSettings?: (workspaceId: string) => void; action: Action;
  order: readonly string[]; dragging: boolean; dropLine: boolean; drag: WorkspaceDrag; onHeader: (ref: ViewRef, id: string | null) => void;
  onMove: (id: string, step: number) => void;
}) {
  const y = createAnimatedValue(0);
  const header = signal<ViewRef | null>(null);
  effect(() => {
    const ref = header();
    const id = props.row.id;
    if (!ref) return;
    props.onHeader(ref, id);
    return () => props.onHeader(ref, null);
  });
  const index = () => props.order.indexOf(props.row.id);
  const movable = () => index() >= 0 && props.order.length > 1;
  const wholeRow = () => movable() && !swipesRows;
  const start = (event: PanEvent) => { if (movable()) props.drag.start(props.row.id, y, event); };
  const end = (event: PanEvent) => { y.set(0); if (movable()) props.drag.end(props.row.id, event); };
  const options = (): (MenuAction | "separator")[] => [
    ...(props.row.canCreate && props.onNewIn ? [{ label: "New session", icon: "plus" as const, testID: `workspace-menu-new-${props.row.id}`, onSelect: () => props.onNewIn!(props.row.id) }] : []),
    { label: props.collapsed ? "Expand" : "Collapse", icon: props.collapsed ? "chevron-down" : "chevron-up", testID: `workspace-fold-${props.row.id}`, onSelect: () => props.onToggle(props.row.id) },
    ...(movable() && index() > 0 ? [{ label: "Move up", icon: "arrow-up" as const, testID: `workspace-move-up-${props.row.id}`, onSelect: () => props.onMove(props.row.id, -1) }] : []),
    ...(movable() && index() < props.order.length - 1
      ? [{ label: "Move down", icon: "arrow-down" as const, testID: `workspace-move-down-${props.row.id}`, onSelect: () => props.onMove(props.row.id, 1) }] : []),
    ...(props.row.archived > 0 ? [{ label: props.row.showArchived ? "Hide archived" : `Show archived (${props.row.archived})`, icon: "archive" as const,
      testID: `workspace-archived-${props.row.id}`, onSelect: () => props.onToggleArchived(props.row.id) }] : []),
    "separator",
    { label: "Copy workspace ID", icon: "copy", testID: `workspace-copy-id-${props.row.id}`, onSelect: () => void props.action.run(() => writeClipboard(props.row.id), "Workspace ID copied") },
    ...(props.onSettings ? [{ label: "Workspace settings", icon: "settings" as const, testID: `workspace-settings-${props.row.id}`, onSelect: () => props.onSettings!(props.row.id) }] : []),
  ];
  return (
    <RowMenu items={options} testID={`workspace-menu-${props.row.id}`}>
      <View ref={ref => header.set(ref)} testID={`workspace-header-${props.row.id}`} pan={wholeRow() ? { y } : undefined}
        panActivation={{ activeOffsetY: 6, failOffsetX: 24 }} onPanStart={start} onPanEnd={end}
        style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: 8, borderRadius: radius.medium, zIndex: props.dragging ? 1 : 0, opacity: props.dragging ? 0.85 : 1,
          backgroundColor: props.dragging ? palette().surface : "transparent", transform: [{ translateY: movable() ? y : 0 }] }}>
        <If when={props.dropLine}>
          <View testID="workspace-drop-line" style={{ position: "absolute", top: -5, left: 0, right: 0, height: 2, borderRadius: 1, backgroundColor: palette().tones.info.text }} />
        </If>
        <BaseButton testID={`workspace-row-${props.row.id}`} accessibilityLabel={props.row.title} selected={!props.collapsed} onPress={rowPress(() => props.onToggle(props.row.id))}
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: props.compact ? 34 : 44, paddingHorizontal: 8, paddingVertical: 6,
            borderRadius: radius.medium }}
          hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
          <IdentityBadge name={props.row.title} id={props.row.id} />
          <Text style={{ flex: 1, numberOfLines: 1, fontSize: text.body, color: palette().text }}>{props.row.title}</Text>
          <If when={props.collapsed}>
            <Text style={{ fontSize: text.caption, color: palette().muted }}>{String(props.row.count)}</Text>
          </If>
        </BaseButton>
        <If when={props.row.canCreate && props.onNewIn}>
          <IconButton testID={`workspace-new-${props.row.id}`} icon="plus" label={`New session in ${props.row.title}`} size={28} onPress={() => props.onNewIn!(props.row.id)} />
        </If>
        <DropdownMenu label={`${props.row.title} options`} testID={`workspace-options-${props.row.id}`} items={options()} />
        <If when={movable() && swipesRows}>
          <View testID={`workspace-drag-${props.row.id}`} accessibilityLabel={`Drag to reorder ${props.row.title}`} pan={{ y }}
            panActivation={{ activeOffsetY: 4, failOffsetX: 24 }} onPanStart={start} onPanEnd={end}
            style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}>
            <Icon name="grip-vertical" size={14} color={palette().faint} />
          </View>
        </If>
      </View>
    </RowMenu>
  );
}

function SideAskRow(props: { session: SessionRecord; ask: SideAskSummary; depth: number; compact?: boolean; onOpen: (sessionId: string, conversationId: string) => void }) {
  const id = () => `side-ask-row-${props.session.id}-${props.ask.conversationId}`;
  return (
    <BaseButton testID={id()} accessibilityLabel={`Side ask: ${props.ask.preview}`} onPress={rowPress(() => props.onOpen(props.session.id, props.ask.conversationId))}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: props.compact ? 30 : 38, paddingVertical: 4, paddingRight: 8,
        paddingLeft: 32 + props.depth * 12, borderRadius: radius.medium }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ backgroundColor: palette().selection }}>
      <Icon name="message-question" size={12} color={palette().faint} />
      <Text style={{ flex: 1, numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>{props.ask.preview}</Text>
      <Text style={{ fontSize: text.caption, color: palette().faint }}>{shortAge(props.ask.createdAt)}</Text>
    </BaseButton>
  );
}

const statusColors: Partial<Record<Tone, Tone>> = { running: "info", info: "info", warning: "warning", danger: "danger" };

function SessionRow(props: {
  item: SessionRecord; depth: number; selected: boolean; onOpen: (id: string) => void; compact?: boolean; menu: SessionMenu;
  swiped: boolean; onSwipe: (open: boolean) => void; severalComputers?: boolean;
}) {
  const data = useAppData();
  const { user } = untracked(session);
  const menuOpen = signal(false);
  const swipe = computed(() => props.menu.swipe(props.item, () => menuOpen.set(true)));
  const press = rowPress(() => (props.swiped ? props.onSwipe(false) : props.onOpen(props.item.id)));
  const status = () => {
    const live = data.liveActivity();
    return sessionStatus(props.item, live?.sessionId === props.item.id ? live.activity : undefined);
  };
  const relation = () => [sessionOwnerLabel(props.item, user.id), forwardedLabel(props.item, props.severalComputers === true)].filter(Boolean).join(" · ");
  const pullColor = () => (props.item.pullRequest ? pullRequestColor(props.item.pullRequest) : palette().muted);
  const statusColor = () => {
    const tone = statusColors[status().tone];
    return tone ? palette().tones[tone].text : palette().muted;
  };
  const details = () => Boolean(status().label) || Boolean(props.item.pullRequest) || Boolean(props.item.tunnel) || Boolean(relation());
  const rowStyle = () => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: props.compact ? 34 : 44, paddingVertical: 6, paddingRight: 8,
    paddingLeft: 32 + props.depth * 12, borderRadius: radius.medium, backgroundColor: props.selected ? palette().selection : "transparent" });
  const pressedStyle = () => ({ backgroundColor: palette().selection });
  const hoveredStyle = () => ({ backgroundColor: props.selected ? palette().selection : palette().hover });
  const body = () => (
    <>
      <If when={status().icon === "clock"}
        else={<StatusDot tone={status().tone} label={status().label ? undefined : props.item.status} />}>
        <View testID={`session-scheduled-${props.item.id}`} accessibilityLabel={status().label}>
          <Icon name="clock" size={11} color={status().tone === "info" || status().tone === "running" ? palette().tones.info.text : palette().faint} />
        </View>
      </If>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ numberOfLines: 1, fontSize: text.body, color: props.selected ? palette().text : palette().muted }}>
          {`${props.depth > 0 ? "↳ " : ""}${props.item.title}`}
        </Text>
        <If when={details()}>
          <Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>
            <If when={status().label}>
              <Text testID={`session-status-${props.item.id}`} style={{ color: statusColor() }}>{status().label}</Text>
            </If>
            <If when={props.item.tunnel}>
              {tunnel => (
                <>
                  <If when={status().label}><Text>{" · "}</Text></If>
                  <Text testID={`session-tunnel-${props.item.id}`} accessibilityLabel={`Online at ${tunnel().url.replace(/^https:\/\//, "")}`}
                    style={{ color: palette().tones.success.text }}>Online</Text>
                </>
              )}
            </If>
            <If when={props.item.pullRequest}>
              {pull => (
                <>
                  <If when={status().label || props.item.tunnel}><Text>{" · "}</Text></If>
                  <Text testID={`session-pull-${props.item.id}`} accessibilityLabel={pullRequestTitle(pull())} style={{ color: pullColor() }}>
                    {`${pullRequestLabel(pull())}${pull().state ? ` ${pullRequestStateLabels[pull().state!]}` : ""}`}
                  </Text>
                </>
              )}
            </If>
            <If when={relation()}>
              <If when={status().label || props.item.pullRequest || props.item.tunnel}><Text>{" · "}</Text></If>
              <Text testID={`session-owner-${props.item.id}`}
                accessibilityLabel={props.item.ownerName?.trim() ? `Owned by ${props.item.ownerName.trim()}` : undefined}>{relation()}</Text>
            </If>
          </Text>
        </If>
      </View>
      <Text style={{ fontSize: text.caption, color: palette().muted }}>{shortAge(props.item.createdAt)}</Text>
    </>
  );
  const row = swipesRows
    ? (
      <SwipeRow leading={swipe().leading} trailing={swipe().trailing} open={props.swiped} onOpenChange={props.onSwipe} dense={props.compact}
        background={props.compact ? palette().sidebar : palette().background} testID={`session-swipe-${props.item.id}`}>
        <View testID={`session-row-${props.item.id}`} role="button" accessibilityLabel={props.item.title} accessibilityState={{ selected: props.selected }}
          onPress={press} onLongPress={() => { props.onSwipe(false); menuOpen.set(true); }} style={rowStyle()} activeStyle={pressedStyle()} hoverStyle={hoveredStyle()}>
          {body()}
        </View>
      </SwipeRow>
    )
    : (
      <BaseButton testID={`session-row-${props.item.id}`} selected={props.selected} accessibilityLabel={props.item.title} onPress={press}
        style={rowStyle()} activeStyle={pressedStyle()} hoverStyle={hoveredStyle()}>
        {body()}
      </BaseButton>
    );
  return (
    <RowMenu items={() => props.menu.items(props.item)} testID={`session-menu-${props.item.id}`} open={menuOpen()} onOpenChange={open => menuOpen.set(open)}
      detached={swipesRows}>
      {row}
    </RowMenu>
  );
}
