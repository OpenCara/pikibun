import { computed, List, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { pullRequestStateLabels, pullRequestStateTones, sessionStatus, type SessionPullRequest, type SessionRecord } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { relativeTime } from "../lib/format";
import { palette } from "../theme";
import { Banner, Button, EmptyState, Loading } from "../ui";

type Row = { kind: "workspace"; key: string; title: string } | { kind: "session"; key: string; session: SessionRecord };

/** "PR #12 Open": the pull request and its state. */
function pullLabel(pull: SessionPullRequest): string {
  return `${pull.number === undefined ? "PR" : `PR #${pull.number}`}${pull.state ? ` ${pullRequestStateLabels[pull.state]}` : ""}`;
}

/** Sessions grouped by workspace, newest first; archived ones only on request. `selectedId` highlights the open one. */
export function SessionList(props: { selectedId?: string | null; onOpen: (id: string) => void; onNew: () => void }) {
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

  return (
    <If when={!data.sessionsLoading()} else={<Loading />}>
      <List each={rows()} keyExtractor={row => row.key} testID="session-list" style={{ flex: 1 }} refreshing={refreshing()} onRefresh={pullToRefresh}
        header={() => (
          <View style={{ gap: 8, padding: 16, paddingBottom: 4 }}>
            <Input value={query()} onChange={event => query.set(event.value)} placeholder="Search sessions" accessibilityLabel="Search sessions by title" autoCorrect={false}
              autoCapitalize="none" testID="session-search"
              style={{ borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 16, borderColor: palette().border, backgroundColor: palette().surface, color: palette().text, placeholderColor: palette().muted }} />
            <If when={archivedCount() > 0}>
              <View style={{ flexDirection: "row" }}>
                <Button small variant="ghost" icon="🗄" label={showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`} onPress={() => showArchived.update(value => !value)} />
              </View>
            </If>
            <If when={data.sessionsError()}>
              <Banner tone="danger" title="Could not load sessions" actions={<Button small label="Try again" onPress={data.refreshSessions} />}>{data.sessionsError()}</Banner>
            </If>
          </View>
        )}
        empty={() => (
          <If when={data.sessions().length > 0}
            else={<EmptyState title="No sessions yet" action={<Button label="Start a session" icon="+" onPress={props.onNew} />} />}>
            <EmptyState title={!query().trim() && !showArchived() ? "All sessions are archived" : "No matching sessions"} />
          </If>
        )}>
        {row => (
          <If when={row().kind === "session" ? (row() as Extract<Row, { kind: "session" }>).session : null}
            else={
              <Text style={{ numberOfLines: 1, fontSize: 13, fontWeight: "600", textTransform: "uppercase", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, color: palette().muted }}>
                {row().kind === "workspace" ? (row() as Extract<Row, { kind: "workspace" }>).title : ""}
              </Text>
            }>
            {item => <SessionRow item={item()} userId={user.id} selected={item().id === props.selectedId} onOpen={props.onOpen} />}
          </If>
        )}
      </List>
    </If>
  );
}

function SessionRow(props: { item: SessionRecord; userId: string; selected: boolean; onOpen: (id: string) => void }) {
  const data = useAppData();
  // The session on screen shows what its live view shows, not what the list last fetched.
  const status = () => {
    const live = data.liveActivity();
    return sessionStatus(props.item, live?.sessionId === props.item.id ? live.activity : undefined);
  };
  const isOwner = () => props.item.ownerId === props.userId;
  const viewerOnly = () => !isOwner() && Boolean(props.item.permissions?.includes("read")) && (props.item.permissions ?? []).every(permission => permission === "read");
  const pullColor = () => {
    const pull = props.item.pullRequest;
    const tone = pull?.state && pullRequestStateTones[pull.state];
    return tone && tone !== "neutral" ? palette().tones[tone === "merged" ? "running" : tone].text : palette().muted;
  };
  return (
    <BaseButton testID={`session-row-${props.item.id}`} selected={props.selected} accessibilityLabel={props.item.title} onPress={() => props.onOpen(props.item.id)}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderColor: palette().border,
        backgroundColor: props.selected ? palette().selection : palette().surface }}
      activeStyle={{ backgroundColor: palette().selection }} hoverStyle={{ backgroundColor: palette().surfaceRaised }}>
      <If when={status().icon === "clock"}
        else={<View accessibilityLabel={status().label ? undefined : props.item.status} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette().tones[status().tone].text }} />}>
        <Text testID={`session-scheduled-${props.item.id}`} style={{ width: 12, fontSize: 11, color: palette().tones[status().tone].text }}>◷</Text>
      </If>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ numberOfLines: 1, fontSize: 16, fontWeight: "500", color: palette().text }}>{props.item.title}</Text>
        <Text style={{ numberOfLines: 1, fontSize: 13, color: palette().muted }}>
          <If when={status().label}>
            <Text testID={`session-status-${props.item.id}`} style={{ fontWeight: "600", color: palette().tones[status().tone].text }}>{status().label}</Text>
            <Text>{" · "}</Text>
          </If>
          <If when={props.item.pullRequest}>
            {pull => (
              <>
                <Text testID={`session-pull-${props.item.id}`} style={{ color: pullColor() }}>{pullLabel(pull())}</Text>
                <Text>{" · "}</Text>
              </>
            )}
          </If>
          <Text>{`${isOwner() ? "Yours" : viewerOnly() ? "Viewer" : "Shared"} · ${props.item.visibility === "workspace" ? "Workspace-visible" : "Private"} · ${relativeTime(props.item.createdAt)}`}</Text>
        </Text>
      </View>
      <Text style={{ fontSize: 16, color: palette().muted }}>›</Text>
    </BaseButton>
  );
}
