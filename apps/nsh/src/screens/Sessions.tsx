import { computed, Scroll, signal, Text, untracked, View } from "nsh";
import { nestSessions, pullRequestStateLabels, sessionStatus, type SessionRecord } from "../shared";
import { pullRequestLabel } from "../components/PullRequest";
import { createSessionMenu, RenameSheet } from "../components/SessionMenu";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { relativeTime } from "../lib/format";
import { layout, palette, text, weight } from "../theme";
import { TextField } from "../form";
import { Button, EmptyState, Feedback, IdentityBadge, InfoTip, Loading, Note, Row, RowMenu, StatusDot } from "../ui";
import { Card } from "../settings/accounts";

const PAGE_SIZE = 50;

/**
 * Every session the person can read, by workspace, newest first, as the web app's SessionsScreen: searchable, archived
 * ones on request, a workspace's longer list in pages. A right click on a session (a finger held on it on touch
 * screens) opens what can be done to it, as in the sidebar.
 */
export function Sessions(props: { onOpen: (id: string) => void; onOpenById: () => void; onNew: () => void }) {
  const data = useAppData();
  const { user } = untracked(session);
  const menu = createSessionMenu();
  const query = signal("");
  const showArchived = signal(false);
  const limits = signal<Record<string, number>>({});
  const archivedCount = () => data.sessions().filter(item => item.status === "archived").length;
  const groups = computed(() => {
    const needle = query().trim().toLowerCase();
    const byWorkspace = new Map<string, SessionRecord[]>();
    for (const item of data.sessions()) {
      if (item.status === "archived" && !showArchived()) continue;
      if (needle && !item.title.toLowerCase().includes(needle)) continue;
      const list = byWorkspace.get(item.workspaceId);
      if (list) list.push(item); else byWorkspace.set(item.workspaceId, [item]);
    }
    const order = [data.lastWorkspaceId(), ...data.workspaces().map(workspace => workspace.id)];
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    return [...byWorkspace.entries()].sort(([a], [b]) => rank(a) - rank(b))
      .map(([id, list]) => ({ id, name: data.workspaces().find(workspace => workspace.id === id)?.name ?? "Other workspace", sessions: list }));
  });
  return (
    <View testID="sessions-screen" style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingVertical: 8, paddingHorizontal: 16 }}>
        <InfoTip label="Who can see a session">
          <View style={{ gap: 8 }}>
            <Note>Private sessions are visible to their owner, the workspace's owner and admins, and people with an explicit grant. Workspace-visible sessions can be viewed by every workspace member.</Note>
            <Note>Viewing never allows asking, writing, approving or managing; those need separate grants. The workspace's owner and admins manage every session in it, but approve only with a grant. Opening a session keeps its original owner identity and history.</Note>
            <Note>Only the owner, or the workspace's owner or an admin, can change visibility, which is separate from sharing a host.</Note>
          </View>
        </InfoTip>
        <View style={{ flex: 1 }} />
        <If when={archivedCount() > 0}>
          <Button small variant="ghost" icon="archive" testID="sessions-archived" label={showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`}
            onPress={() => showArchived.update(value => !value)} />
        </If>
        <Button small variant="outline" label="Open by ID" onPress={props.onOpenById} />
      </View>
      <If when={!data.sessionsLoading()} else={<Loading />}>
        <If when={data.sessions().length} else={<EmptyState title="No sessions yet" action={<Button variant="ghost" label="Start a session" onPress={props.onNew} />} />}>
          <Scroll style={{ flex: 1 }} contentStyle={{ gap: 32, width: "100%", maxWidth: layout.content, alignSelf: "center", paddingHorizontal: 24, paddingTop: 16, paddingBottom: 48 }}>
            <TextField testID="sessions-search" value={query()} onChange={value => query.set(value)} placeholder="Search sessions" accessibilityLabel="Search sessions by title" />
            <If when={!menu.renaming() && (menu.action.error() || menu.action.notice())}>
              <View testID="sessions-feedback"><Feedback error={menu.action.error()} notice={menu.action.notice()} /></View>
            </If>
            <If when={groups().length} else={<EmptyState title={!query().trim() && !showArchived() ? "All sessions are archived" : "No matching sessions"} />}>
              <Each of={groups()} key={group => group.id}>
                {group => {
                  const limit = () => limits()[group().id] ?? PAGE_SIZE;
                  return (
                    <View style={{ gap: 8 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 2 }}>
                        <IdentityBadge name={group().name} id={group().id} />
                        <Text style={{ fontSize: text.body, fontWeight: weight.medium, color: palette().muted }}>{group().name}</Text>
                      </View>
                      <Card>
                        <Each of={nestSessions(group().sessions).slice(0, limit())} key={item => item.session.id}>
                          {item => {
                            const record = () => item().session;
                            const status = () => sessionStatus(record());
                            const owner = () => record().ownerId === user.id;
                            const viewerOnly = () => !owner() && record().permissions?.includes("read") && record().permissions!.every(permission => permission === "read");
                            return (
                              <RowMenu items={() => menu.items(record())} testID={`sessions-menu-${record().id}`}>
                                <Row testID={`sessions-row-${record().id}`} chevron onPress={() => props.onOpen(record().id)}
                                  leading={<StatusDot tone={status().tone} label={status().label ?? record().status} />}
                                  title={`${item().depth > 0 ? `${"  ".repeat(item().depth - 1)}↳ ` : ""}${record().title}`}
                                  hint={`${status().label ? `${status().label} · ` : ""}${record().tunnel ? "Online · " : ""}${record().pullRequest
                                    ? `${pullRequestLabel(record().pullRequest!)}${record().pullRequest!.state ? ` ${pullRequestStateLabels[record().pullRequest!.state!]}` : ""} · ` : ""}${owner() ? "Yours" : viewerOnly() ? "Viewer" : "Shared"} · ${record().visibility === "workspace" ? "Workspace-visible" : "Private"} · ${relativeTime(record().createdAt)}`} />
                              </RowMenu>
                            );
                          }}
                        </Each>
                        <If when={group().sessions.length > limit()}>
                          <View style={{ borderTopWidth: 1, borderColor: palette().border, padding: 4 }}>
                            <Button small block variant="ghost" label="Load more" onPress={() => limits.update(current => ({ ...current, [group().id]: limit() + PAGE_SIZE }))} />
                          </View>
                        </If>
                      </Card>
                    </View>
                  );
                }}
              </Each>
            </If>
          </Scroll>
        </If>
      </If>
      <RenameSheet open={menu.renaming() !== null} title={menu.renaming()?.title ?? ""} busy={menu.action.busy()} error={menu.action.error()}
        onClose={menu.closeRename} onSave={menu.rename} />
    </View>
  );
}
