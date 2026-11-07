import { computed, List, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { pullRequestStateLabels, pullRequestStateTones, sessionStatus, type SessionPullRequest, type SessionRecord } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createUsername } from "../lib/people";
import { Icon } from "../icons";
import { palette, radius, text, type Tone } from "../theme";
import { Banner, Button, EmptyState, Loading, SectionLabel } from "../ui";

type Row = { kind: "workspace"; key: string; title: string } | { kind: "session"; key: string; session: SessionRecord };

/** "PR #12 Open": the pull request and its state. */
function pullLabel(pull: SessionPullRequest): string {
  return `${pull.number === undefined ? "PR" : `PR #${pull.number}`}${pull.state ? ` ${pullRequestStateLabels[pull.state]}` : ""}`;
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
 * Sessions grouped by workspace, newest first; archived ones only on request. `selectedId` highlights the open one.
 * `compact` is the desktop sidebar's density; the phone's list has room to breathe and bigger rows to tap.
 */
export function SessionList(props: { selectedId?: string | null; onOpen: (id: string) => void; onNew: () => void; compact?: boolean }) {
  const { user } = untracked(session);
  const data = useAppData();
  const query = signal("");
  const showArchived = signal(false);
  const archivedCount = () => data.sessions().filter(item => item.status === "archived").length;
  // One list of rows, workspace headings between their sessions: NSH's List is one virtualized column.
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
      { kind: "workspace", key: `workspace:${id}`, title: data.workspaces().find(workspace => workspace.id === id)?.name ?? "Other workspace" },
      ...sessions.map((item): Row => ({ kind: "session", key: item.id, session: item })),
    ]);
  });
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
        contentStyle={{ paddingBottom: 12 }}
        header={() => (
          <View style={{ gap: 8, paddingHorizontal: inset(), paddingTop: props.compact ? 4 : 12, paddingBottom: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius.medium, paddingHorizontal: 10, height: props.compact ? 32 : 38,
              backgroundColor: props.compact ? palette().surfaceRaised : palette().surface, borderWidth: props.compact ? 0 : 1, borderColor: palette().border }}>
              <Icon name="search" size={14} color={palette().faint} />
              <Input value={query()} onChange={event => query.set(event.value)} placeholder="Search sessions" accessibilityLabel="Search sessions by title" autoCorrect={false}
                autoCapitalize="none" testID="session-search"
                style={{ flex: 1, fontSize: props.compact ? text.small : text.reading, color: palette().text, placeholderColor: palette().faint }} />
            </View>
            <If when={data.sessionsError()}>
              <Banner tone="danger" title="Could not load sessions" actions={<Button small label="Try again" onPress={data.refreshSessions} />}>{data.sessionsError()}</Banner>
            </If>
          </View>
        )}
        footer={() => (
          <If when={archivedCount() > 0}>
            <View style={{ paddingHorizontal: inset(), paddingTop: 12 }}>
              <BaseButton testID="toggle-archived" accessibilityLabel={showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`}
                onPress={() => showArchived.update(value => !value)}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, height: 30, borderRadius: radius.medium }}
                hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.6 }}>
                <Icon name="archive" size={14} color={palette().faint} />
                <Text style={{ fontSize: text.small, color: palette().muted }}>{showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`}</Text>
              </BaseButton>
            </View>
          </If>
        )}
        empty={() => (
          <If when={data.sessions().length > 0}
            else={<EmptyState icon="message" title="No sessions yet" action={<Button label="New session" icon="plus" variant="primary" onPress={props.onNew} />}>Start one to put an agent to work on your workspace's repositories.</EmptyState>}>
            <EmptyState icon="search" title={!query().trim() && !showArchived() ? "All sessions are archived" : "No matching sessions"} />
          </If>
        )}>
        {row => (
          <If when={row().kind === "session" ? (row() as Extract<Row, { kind: "session" }>).session : null}
            else={
              <View style={{ paddingHorizontal: inset() + 8, paddingTop: 14, paddingBottom: 4 }}>
                <SectionLabel>{row().kind === "workspace" ? (row() as Extract<Row, { kind: "workspace" }>).title : ""}</SectionLabel>
              </View>
            }>
            {item => <SessionRow item={item()} userId={user.id} selected={item().id === props.selectedId} onOpen={props.onOpen} compact={props.compact} />}
          </If>
        )}
      </List>
    </If>
  );
}

/** The mark before a session's title: what its agent is doing, at a glance. */
function StatusMark(props: { tone: Tone; scheduled: boolean; label?: string; testID?: string; attention: boolean }) {
  return (
    <View testID={props.testID} accessibilityLabel={props.label} style={{ width: 16, height: 18, alignItems: "center", justifyContent: "center" }}>
      <If when={props.scheduled}
        else={
          <View style={{ width: 8, height: 8, borderRadius: 4,
            backgroundColor: props.attention ? palette().tones[props.tone].text : "transparent",
            borderWidth: props.attention ? 0 : 1.5, borderColor: palette().faint }} />
        }>
        <Icon name="clock" size={13} color={palette().tones[props.tone].text} />
      </If>
    </View>
  );
}

function SessionRow(props: { item: SessionRecord; userId: string; selected: boolean; onOpen: (id: string) => void; compact?: boolean }) {
  const data = useAppData();
  const name = createUsername();
  // The session on screen shows what its live view shows, not what the list last fetched.
  const status = () => {
    const live = data.liveActivity();
    return sessionStatus(props.item, live?.sessionId === props.item.id ? live.activity : undefined);
  };
  /** Whether the status asks for attention, and so is spelled out under the title: not when it is done or idle. */
  const attention = () => Boolean(status().label) && !["success", "neutral"].includes(status().tone);
  const isOwner = () => props.item.ownerId === props.userId;
  const pullColor = () => {
    const pull = props.item.pullRequest;
    const tone = pull?.state && pullRequestStateTones[pull.state];
    return tone && tone !== "neutral" ? palette().tones[tone === "merged" ? "running" : tone].text : palette().muted;
  };
  const owner = () => (isOwner() ? "" : name(props.item.ownerId));
  const details = () => attention() || Boolean(props.item.pullRequest) || Boolean(owner()) || props.item.visibility === "private";
  return (
    <View style={{ paddingHorizontal: props.compact ? 8 : 12 }}>
      <BaseButton testID={`session-row-${props.item.id}`} selected={props.selected} accessibilityLabel={props.item.title} onPress={() => props.onOpen(props.item.id)}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 8, paddingVertical: props.compact ? 7 : 10, borderRadius: radius.medium,
          backgroundColor: props.selected ? palette().selection : "transparent" }}
        activeStyle={{ backgroundColor: palette().selection }} hoverStyle={{ backgroundColor: props.selected ? palette().selection : palette().hover }}>
        <StatusMark tone={status().tone} scheduled={status().icon === "clock"} label={status().label} attention={attention() || status().tone === "running"}
          testID={status().icon === "clock" ? `session-scheduled-${props.item.id}` : undefined} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, numberOfLines: 1, fontSize: props.compact ? text.body : text.reading, fontWeight: props.selected ? "600" : "500", color: palette().text }}>
              {props.item.title}
            </Text>
            <Text style={{ fontSize: text.caption, color: palette().faint }}>{shortAge(props.item.createdAt)}</Text>
          </View>
          <If when={details()}>
            <Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>
              <If when={attention()}>
                <Text testID={`session-status-${props.item.id}`} style={{ fontWeight: "600", color: palette().tones[status().tone].text }}>{status().label}</Text>
              </If>
              <If when={props.item.pullRequest}>
                {pull => (
                  <>
                    <If when={attention()}><Text>{" · "}</Text></If>
                    <Text testID={`session-pull-${props.item.id}`} style={{ color: pullColor() }}>{pullLabel(pull())}</Text>
                  </>
                )}
              </If>
              <If when={owner()}>
                <Text>{`${attention() || props.item.pullRequest ? " · " : ""}${owner()}`}</Text>
              </If>
              <If when={props.item.visibility === "private"}>
                <Text>{`${attention() || props.item.pullRequest || owner() ? " · " : ""}Private`}</Text>
              </If>
            </Text>
          </If>
        </View>
      </BaseButton>
    </View>
  );
}
