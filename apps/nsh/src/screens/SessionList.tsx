import { Clipboard, computed, List, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { canCreateSessions, nestSessions, pullRequestStateLabels, sessionStatus, type SessionRecord } from "../shared";
import { pullRequestColor, pullRequestLabel, pullRequestTitle } from "../components/PullRequest";
import { createSessionMenu, RenameSheet, type SessionMenu } from "../components/SessionMenu";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import type { Action } from "../lib/resource";
import { Icon } from "../icons";
import { palette, radius, text, type Tone } from "../theme";
import { Banner, Button, DropdownMenu, EmptyState, Feedback, IconButton, IdentityBadge, Loading, RowMenu, StatusDot, type MenuAction } from "../ui";

type Row =
  | { kind: "workspace"; key: string; id: string; title: string; count: number; canCreate: boolean }
  | { kind: "session"; key: string; session: SessionRecord; depth: number }
  /** A workspace without sessions yet: a row that starts one there. */
  | { kind: "start"; key: string; workspaceId: string };

/** "3m", "2h", "5d", "6 Nov": a session's age, as short as a sidebar has room for. */
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

/**
 * Sessions by workspace, as the web app's sidebar lists them (Sidebar.tsx): each workspace a row with its identity
 * badge that folds its sessions away, each session one step in under it, newest first; sessions another session's agent
 * started follow it, one more step in. Archived ones only on request. Every workspace has its row, one without sessions
 * a row that starts one there; a workspace's row starts a session in it and opens its settings (`onNewIn`,
 * `onWorkspaceSettings`), and `onNewWorkspace` creates another. `selectedId` marks the open one. `compact` is the
 * desktop sidebar's density; the phone's list has bigger rows to tap. A right click on a row (a finger held on it on
 * touch screens) opens its menu: a workspace's options, or what can be done to a session (createSessionMenu), whose
 * outcome shows under the search box.
 */
export function SessionList(props: {
  selectedId?: string | null; onOpen: (id: string) => void; onNew: () => void; compact?: boolean;
  onNewIn?: (workspaceId: string) => void; onWorkspaceSettings?: (workspaceId: string) => void; onNewWorkspace?: () => void;
}) {
  const data = useAppData();
  const menu = createSessionMenu();
  const query = signal("");
  const showArchived = signal(false);
  /** Workspaces folded away, by ID. */
  const collapsed = signal<readonly string[]>([]);
  const archivedCount = () => data.sessions().filter(item => item.status === "archived").length;
  // One list of rows, workspace rows before their sessions: NSH's List is one virtualized column.
  const rows = computed<Row[]>(() => {
    const needle = query().trim().toLowerCase();
    const byWorkspace = new Map<string, SessionRecord[]>();
    for (const item of data.sessions()) {
      if (item.status === "archived" && !showArchived()) continue;
      if (needle && !item.title.toLowerCase().includes(needle)) continue;
      const list = byWorkspace.get(item.workspaceId);
      if (list) list.push(item);
      else byWorkspace.set(item.workspaceId, [item]);
    }
    // Every workspace, those without sessions too (unless searching), then any a session names that isn't listed.
    if (!needle) for (const workspace of data.workspaces()) if (!byWorkspace.has(workspace.id)) byWorkspace.set(workspace.id, []);
    const order = data.workspaces().map(workspace => workspace.id);
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    return [...byWorkspace.entries()].sort(([a], [b]) => rank(a) - rank(b)).flatMap(([id, sessions]): Row[] => {
      const workspace = data.workspaces().find(item => item.id === id);
      const canCreate = Boolean(workspace && canCreateSessions(workspace.role));
      const folded = collapsed().includes(id) && !needle;
      return [
        { kind: "workspace", key: `workspace:${id}`, id, count: sessions.length, canCreate, title: workspace?.name ?? "Other workspace" },
        ...(folded ? [] : nestSessions(sessions).map(({ session: item, depth }): Row => ({ kind: "session", key: item.id, session: item, depth }))),
        ...(!folded && !sessions.length && canCreate && props.onNewIn ? [{ kind: "start" as const, key: `start:${id}`, workspaceId: id }] : []),
      ];
    });
  });
  const toggle = (id: string) => collapsed.update(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));
  // The pull-to-refresh spinner shows while the reload a pull started runs, and only then: background reloads
  // (polling, opening or leaving a session) keep the list where it is rather than pushing it down under a spinner.
  const refreshing = signal(false);
  /** The latest pull: an earlier one's reloads finishing don't hide the spinner of a later one still loading. */
  let pulls = 0;
  function pullToRefresh() {
    const pull = ++pulls;
    refreshing.set(true);
    void Promise.all([data.refreshSessions(), data.refreshWorkspaces()]).finally(() => { if (pull === pulls) refreshing.set(false); });
  }
  const inset = () => (props.compact ? 8 : 12);

  return (
    <If when={!data.sessionsLoading()} else={<Loading />}>
      <List each={rows()} keyExtractor={row => row.key} testID="session-list" style={{ flex: 1 }} refreshing={refreshing()} onRefresh={pullToRefresh}
        contentStyle={{ paddingBottom: 16 }}
        header={() => (
          <View style={{ gap: 8, paddingHorizontal: inset(), paddingTop: 4, paddingBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius.medium, paddingHorizontal: 10, height: props.compact ? 32 : 40,
              backgroundColor: palette().surface, borderWidth: 1, borderColor: palette().border }}>
              <Icon name="search" size={14} color={palette().muted} />
              <Input value={query()} onChange={event => query.set(event.value)} placeholder="Search sessions" accessibilityLabel="Search sessions by title" autoCorrect={false}
                autoCapitalize="none" testID="session-search"
                style={{ flex: 1, fontSize: props.compact ? text.body : text.large, color: palette().text, placeholderColor: palette().muted }} />
            </View>
            <If when={data.sessionsError()}>
              <Banner tone="danger" title="Could not load sessions" actions={<Button small variant="outline" label="Try again" onPress={data.refreshSessions} />}>{data.sessionsError()}</Banner>
            </If>
            <If when={!menu.renaming() && (menu.action.error() || menu.action.notice())}>
              <View testID="session-list-feedback" style={{ paddingHorizontal: 4 }}><Feedback error={menu.action.error()} notice={menu.action.notice()} /></View>
            </If>
          </View>
        )}
        footer={() => (
          <View style={{ paddingHorizontal: inset(), paddingTop: 12, gap: 2 }}>
            <If when={archivedCount() > 0}>
              <BaseButton testID="toggle-archived" accessibilityLabel={showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`}
                onPress={() => showArchived.update(value => !value)}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, minHeight: 34, borderRadius: radius.medium }}
                hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
                <Icon name="archive" size={14} color={palette().muted} />
                <Text style={{ fontSize: text.body, color: palette().muted }}>{showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`}</Text>
              </BaseButton>
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
            <EmptyState title={!query().trim() && !showArchived() ? "All sessions are archived" : "No matching sessions"} />
          </If>
        )}>
        {row => (
          <View style={{ paddingHorizontal: inset() }}>
            <If when={row().kind === "session" ? row() as Extract<Row, { kind: "session" }> : null}
              else={
                <If when={row().kind === "start" ? row() as Extract<Row, { kind: "start" }> : null}
                  else={
                    <WorkspaceRow row={row() as Extract<Row, { kind: "workspace" }>} collapsed={collapsed().includes((row() as Extract<Row, { kind: "workspace" }>).id)}
                      onToggle={toggle} compact={props.compact} onNewIn={props.onNewIn} onSettings={props.onWorkspaceSettings} action={menu.action} />
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
              {item => <SessionRow item={item().session} depth={item().depth} selected={item().session.id === props.selectedId} onOpen={props.onOpen} compact={props.compact} menu={menu} />}
            </If>
          </View>
        )}
      </List>
      <RenameSheet open={menu.renaming() !== null} title={menu.renaming()?.title ?? ""} busy={menu.action.busy()} error={menu.action.error()}
        onClose={menu.closeRename} onSave={menu.rename} />
    </If>
  );
}

/**
 * A workspace's row (.workspace-row): its badge and name, pressing which folds its sessions away or back, then a new
 * session there and its options (a new session, folding it, its ID and its settings), as the web app's sidebar has
 * them; a right click on the row opens the same options.
 */
function WorkspaceRow(props: {
  row: Extract<Row, { kind: "workspace" }>; collapsed: boolean; onToggle: (id: string) => void; compact?: boolean;
  onNewIn?: (workspaceId: string) => void; onSettings?: (workspaceId: string) => void; action: Action;
}) {
  const options = (): (MenuAction | "separator")[] => [
    ...(props.row.canCreate && props.onNewIn ? [{ label: "New session", icon: "plus" as const, testID: `workspace-menu-new-${props.row.id}`, onSelect: () => props.onNewIn!(props.row.id) }] : []),
    { label: props.collapsed ? "Expand" : "Collapse", icon: props.collapsed ? "chevron-down" : "chevron-up", testID: `workspace-fold-${props.row.id}`, onSelect: () => props.onToggle(props.row.id) },
    "separator",
    { label: "Copy workspace ID", icon: "copy", testID: `workspace-copy-id-${props.row.id}`, onSelect: () => void props.action.run(() => Clipboard.writeText(props.row.id), "Workspace ID copied") },
    ...(props.onSettings ? [{ label: "Workspace settings", icon: "settings" as const, testID: `workspace-settings-${props.row.id}`, onSelect: () => props.onSettings!(props.row.id) }] : []),
  ];
  return (
    <RowMenu items={options} testID={`workspace-menu-${props.row.id}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: 8 }}>
        <BaseButton testID={`workspace-row-${props.row.id}`} accessibilityLabel={props.row.title} selected={!props.collapsed} onPress={() => props.onToggle(props.row.id)}
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
      </View>
    </RowMenu>
  );
}

/** Its status label's color: only while under way or needing attention (.session-status). */
const statusColors: Partial<Record<Tone, Tone>> = { running: "info", info: "info", warning: "warning", danger: "danger" };

/**
 * A session's row (.nav-item.session-item): its status dot, title and what to know about it, and its age; a right click
 * on it opens what can be done to it (`menu`).
 */
function SessionRow(props: { item: SessionRecord; depth: number; selected: boolean; onOpen: (id: string) => void; compact?: boolean; menu: SessionMenu }) {
  const data = useAppData();
  const { user } = untracked(session);
  // The session on screen shows what its live view shows, not what the list last fetched.
  const status = () => {
    const live = data.liveActivity();
    return sessionStatus(props.item, live?.sessionId === props.item.id ? live.activity : undefined);
  };
  const relation = () => (props.item.ownerId === user.id ? "" : props.item.permissions?.every(permission => permission === "read") ? "Viewer" : "Shared");
  const pullColor = () => (props.item.pullRequest ? pullRequestColor(props.item.pullRequest) : palette().muted);
  const statusColor = () => {
    const tone = statusColors[status().tone];
    return tone ? palette().tones[tone].text : palette().muted;
  };
  const details = () => Boolean(status().label) || Boolean(props.item.pullRequest) || Boolean(props.item.tunnel) || Boolean(relation());
  return (
    <RowMenu items={() => props.menu.items(props.item)} testID={`session-menu-${props.item.id}`}>
      <BaseButton testID={`session-row-${props.item.id}`} selected={props.selected} accessibilityLabel={props.item.title} onPress={() => props.onOpen(props.item.id)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: props.compact ? 34 : 44, paddingVertical: 6, paddingRight: 8,
          paddingLeft: 32 + props.depth * 12, borderRadius: radius.medium, backgroundColor: props.selected ? palette().selection : "transparent" }}
        activeStyle={{ backgroundColor: palette().selection }} hoverStyle={{ backgroundColor: props.selected ? palette().selection : palette().hover }}>
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
                <Text>{`${status().label || props.item.pullRequest || props.item.tunnel ? " · " : ""}${relation()}`}</Text>
              </If>
            </Text>
          </If>
        </View>
        <Text style={{ fontSize: text.caption, color: palette().muted }}>{shortAge(props.item.createdAt)}</Text>
      </BaseButton>
    </RowMenu>
  );
}
