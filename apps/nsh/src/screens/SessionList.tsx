import { computed, List, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { nestSessions, pullRequestStateLabels, pullRequestStateTones, sessionStatus, type SessionPullRequest, type SessionRecord } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { Icon } from "../icons";
import { palette, radius, text, type Tone } from "../theme";
import { Banner, Button, EmptyState, IdentityBadge, Loading, StatusDot } from "../ui";

type Row =
  | { kind: "workspace"; key: string; id: string; title: string; count: number }
  | { kind: "session"; key: string; session: SessionRecord; depth: number };

/** "#12", or "PR" for a pull request URL with no number (pull-request.tsx). */
function pullLabel(pull: SessionPullRequest): string {
  return pull.number === undefined ? "PR" : `#${pull.number}`;
}

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
 * started follow it, one more step in. Archived ones only on request. `selectedId` marks the open one. `compact` is the
 * desktop sidebar's density; the phone's list has bigger rows to tap.
 */
export function SessionList(props: { selectedId?: string | null; onOpen: (id: string) => void; onNew: () => void; compact?: boolean }) {
  const data = useAppData();
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
    const order = data.workspaces().map(workspace => workspace.id);
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    return [...byWorkspace.entries()].sort(([a], [b]) => rank(a) - rank(b)).flatMap(([id, sessions]): Row[] => [
      { kind: "workspace", key: `workspace:${id}`, id, count: sessions.length, title: data.workspaces().find(workspace => workspace.id === id)?.name ?? "Other workspace" },
      ...(collapsed().includes(id) && !needle ? [] : nestSessions(sessions).map(({ session: item, depth }): Row => ({ kind: "session", key: item.id, session: item, depth }))),
    ]);
  });
  const toggle = (id: string) => collapsed.update(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));
  const pulled = signal(false);
  function pullToRefresh() {
    pulled.set(true);
    data.refreshSessions();
    data.refreshWorkspaces();
  }
  const refreshing = () => pulled() && data.sessionsReloading();
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
          </View>
        )}
        footer={() => (
          <If when={archivedCount() > 0}>
            <View style={{ paddingHorizontal: inset(), paddingTop: 12 }}>
              <BaseButton testID="toggle-archived" accessibilityLabel={showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`}
                onPress={() => showArchived.update(value => !value)}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, minHeight: 34, borderRadius: radius.medium }}
                hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
                <Icon name="archive" size={14} color={palette().muted} />
                <Text style={{ fontSize: text.body, color: palette().muted }}>{showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`}</Text>
              </BaseButton>
            </View>
          </If>
        )}
        empty={() => (
          <If when={data.sessions().length > 0}
            else={<EmptyState title="No sessions yet" action={<Button label="New session" icon="plus" variant="primary" onPress={props.onNew} />}>Start one to put an agent to work on your workspace's repositories.</EmptyState>}>
            <EmptyState title={!query().trim() && !showArchived() ? "All sessions are archived" : "No matching sessions"} />
          </If>
        )}>
        {row => (
          <View style={{ paddingHorizontal: inset() }}>
            <If when={row().kind === "session" ? row() as Extract<Row, { kind: "session" }> : null}
              else={
                <WorkspaceRow row={row() as Extract<Row, { kind: "workspace" }>} collapsed={collapsed().includes((row() as Extract<Row, { kind: "workspace" }>).id)}
                  onToggle={toggle} compact={props.compact} />
              }>
              {item => <SessionRow item={item().session} depth={item().depth} selected={item().session.id === props.selectedId} onOpen={props.onOpen} compact={props.compact} />}
            </If>
          </View>
        )}
      </List>
    </If>
  );
}

/** A workspace's row (.workspace-row): its badge and name; pressing it folds its sessions away or back. */
function WorkspaceRow(props: { row: Extract<Row, { kind: "workspace" }>; collapsed: boolean; onToggle: (id: string) => void; compact?: boolean }) {
  return (
    <BaseButton testID={`workspace-row-${props.row.id}`} accessibilityLabel={props.row.title} selected={!props.collapsed} onPress={() => props.onToggle(props.row.id)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: props.compact ? 34 : 44, paddingHorizontal: 8, paddingVertical: 6, marginTop: 8,
        borderRadius: radius.medium }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
      <IdentityBadge name={props.row.title} id={props.row.id} />
      <Text style={{ flex: 1, numberOfLines: 1, fontSize: text.body, color: palette().text }}>{props.row.title}</Text>
      <If when={props.collapsed}>
        <Text style={{ fontSize: text.caption, color: palette().muted }}>{String(props.row.count)}</Text>
      </If>
    </BaseButton>
  );
}

/** Its status label's color: only while under way or needing attention (.session-status). */
const statusColors: Partial<Record<Tone, Tone>> = { running: "info", info: "info", warning: "warning", danger: "danger" };

/** A session's row (.nav-item.session-item): its status dot, title and what to know about it, and its age. */
function SessionRow(props: { item: SessionRecord; depth: number; selected: boolean; onOpen: (id: string) => void; compact?: boolean }) {
  const data = useAppData();
  const { user } = untracked(session);
  // The session on screen shows what its live view shows, not what the list last fetched.
  const status = () => {
    const live = data.liveActivity();
    return sessionStatus(props.item, live?.sessionId === props.item.id ? live.activity : undefined);
  };
  const relation = () => (props.item.ownerId === user.id ? "" : props.item.permissions?.every(permission => permission === "read") ? "Viewer" : "Shared");
  const pullColor = () => {
    const tone = props.item.pullRequest?.state && pullRequestStateTones[props.item.pullRequest.state];
    return tone === "merged" ? palette().merged : tone && tone !== "neutral" ? palette().tones[tone].text : palette().muted;
  };
  const statusColor = () => {
    const tone = statusColors[status().tone];
    return tone ? palette().tones[tone].text : palette().muted;
  };
  const details = () => Boolean(status().label) || Boolean(props.item.pullRequest) || Boolean(relation());
  return (
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
            <If when={props.item.pullRequest}>
              {pull => (
                <>
                  <If when={status().label}><Text>{" · "}</Text></If>
                  <Text testID={`session-pull-${props.item.id}`} style={{ color: pullColor() }}>
                    {`${pullLabel(pull())}${pull().state ? ` ${pullRequestStateLabels[pull().state!]}` : ""}`}
                  </Text>
                </>
              )}
            </If>
            <If when={relation()}>
              <Text>{`${status().label || props.item.pullRequest ? " · " : ""}${relation()}`}</Text>
            </If>
          </Text>
        </If>
      </View>
      <Text style={{ fontSize: text.caption, color: palette().muted }}>{shortAge(props.item.createdAt)}</Text>
    </BaseButton>
  );
}
