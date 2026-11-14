import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, ResizablePanel, ResizablePanelGroup, type DiffLayout } from "nsh/base";
import type { LocalChanges, LocalCommit } from "../../../../packages/shared/src/local-changes";
import { reviewFileOrder, reviewTree } from "../../../../packages/shared/src/pull-request-review";
import type { PullRequestFileView } from "../../../../packages/shared/src/types";
import { segment } from "../shared";
import { relativeTime } from "../lib/format";
import { createResource } from "../lib/resource";
import { Icon } from "../icons";
import { monospace, palette, radius, text, weight } from "../theme";
import { Banner, Button, EmptyState, IconButton, Loading, Picker, Segmented, Small } from "../ui";
import { filesUnavailable } from "./Files";
import type { PanelTabProps } from "./parts";
import { Branch, DiffPane, FilesTree, plural, revision } from "./Review";

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");
const repositoryName = (directory: string) => (directory === "." ? "worktree" : directory);
const subject = (commit: LocalCommit) => commit.message.split("\n")[0] ?? "";

export function Changes(props: PanelTabProps) {
  return (
    <View testID="panel-changes" style={{ flex: 1 }}>
      <If when={props.session()} else={<Loading />}>
        {current => (
          <If when={!filesUnavailable(current(), "see its changes")}
            else={<EmptyState title="Changes unavailable">{current().status === "archived" ? "Archived sessions don't show their files. Unarchive the session to see its changes."
              : "The worktree's Git changes are files of the session: seeing them takes the session collaborator role, as the Files tab does. Viewers follow the conversation."}</EmptyState>}>
            <LocalChangesView {...props} />
          </If>
        )}
      </If>
    </View>
  );
}

type SideTab = "files" | "commits";

function LocalChangesView(props: PanelTabProps) {
  const directory = signal<string | null>(null);
  const commit = signal<string | null>(null);
  const resource = createResource<{ changes: LocalChanges }>(() => {
    const query = directory() === null ? "" : `?directory=${encodeURIComponent(directory()!)}${commit() ? `&commit=${commit()}` : ""}`;
    return `/api/sessions/${segment(props.sessionId)}/changes${query}`;
  });
  const shown = signal<LocalChanges | null>(null);
  effect(() => { const next = resource.data()?.changes; if (next) shown.set(next); });
  const tab = signal<SideTab>("files");
  const grouped = signal(true);
  const collapsed = signal<string[]>([]);
  const selected = signal<string | null>(null);
  const chosenLayout = signal<DiffLayout | null>(null);
  const sideWidth = signal(360);
  const expanded = () => props.expanded?.() ?? false;
  const layout = (): DiffLayout => chosenLayout() ?? (expanded() ? "split" : "unified");
  const tree = computed(() => reviewTree(shown()?.files ?? [], grouped()));
  const order = computed(() => reviewFileOrder(tree()));
  const file = () => shown()?.files.find(item => item.path === selected()) ?? null;
  const step = (by: number) => {
    const next = order()[order().indexOf(selected() ?? "") + by];
    if (next !== undefined) selected.set(next);
  };
  const scope = (nextDirectory: string | null, nextCommit: string | null) => {
    selected.set(null);
    collapsed.set([]);
    directory.set(nextDirectory);
    commit.set(nextCommit);
    tab.set("files");
  };
  effect(() => {
    const first = order()[0];
    if (expanded() && first !== undefined && !untracked(file)) selected.set(first);
  });
  let seen: string | undefined;
  effect(() => {
    const watched = `${props.session()?.activity ?? ""}|${props.view()?.busy ? "busy" : "idle"}`;
    untracked(() => {
      if (seen !== undefined && seen !== watched) void resource.refresh();
      seen = watched;
    });
  });

  const sidebar = (current: () => LocalChanges) => (
    <Sidebar changes={current()} tab={tab()} onTab={value => tab.set(value)} grouped={grouped()} onGrouped={value => grouped.set(value)} tree={tree()}
      collapsed={collapsed()} onCollapsed={value => collapsed.set(value)} selected={selected()} onSelect={path => selected.set(path)}
      onRepository={value => scope(value, null)} onCommit={value => scope(current().directory, value)}
      loading={resource.loading()} error={resource.error()} onRefresh={() => void resource.refresh()} expanded={expanded()} setExpanded={props.setExpanded} />
  );
  const titles = (current: LocalChanges) => {
    const head = current.repositories.find(item => item.directory === current.directory)?.head;
    return current.commit ? { old: `${short(current.commit)}^`, new: short(current.commit) } : { old: revision("HEAD", head), new: "Working tree" };
  };
  const diff = (current: () => LocalChanges, open: () => PullRequestFileView, back: boolean) => (
    <Each of={[open().path]} key={path => path}>
      {() => (
        <DiffPane file={open()} layout={layout()} onLayout={value => chosenLayout.set(value)} onBack={back ? () => selected.set(null) : undefined}
          oldTitle={titles(current()).old} newTitle={titles(current()).new}
          index={order().indexOf(open().path)} count={order().length} onStep={step} expanded={expanded()} setExpanded={props.setExpanded} />
      )}
    </Each>
  );
  return (
    <If when={shown()}
      else={
        <If when={!resource.error()} else={
          <View style={{ padding: 16 }}>
            <Banner tone="danger" title="Couldn't read the changes" actions={<Button small variant="outline" label="Try again" onPress={() => void resource.refresh()} />}>{resource.error()}</Banner>
          </View>
        }>
          <Loading label="Reading the worktree's changes…" />
        </If>
      }>
      {current => (
        <If when={current().directory !== null}
          else={
            <EmptyState title="No Git repository in the worktree"
              action={<Button small variant="outline" icon="refresh" label="Look again" testID="changes-refresh" disabled={resource.loading()} onPress={() => void resource.refresh()} />}>
              When the agent clones a repository into the session's worktree, its uncommitted changes and its commits show here.
            </EmptyState>
          }>
          <If when={expanded()}
            else={<If when={file()} else={sidebar(current)}>{open => diff(current, open, true)}</If>}>
            <ResizablePanelGroup testID="changes-full" handleStyle={{ backgroundColor: palette().border }} handleAccessibilityLabel="Resize the files list">
              <ResizablePanel size={sideWidth()} minSize={240} maxSize={640} fixed onResize={event => sideWidth.set(event.size)}>
                {sidebar(current)}
              </ResizablePanel>
              <ResizablePanel minSize={320}>
                <If when={file()} else={<EmptyState title="Select a file to see its diff" />}>{open => diff(current, open, false)}</If>
              </ResizablePanel>
            </ResizablePanelGroup>
          </If>
        </If>
      )}
    </If>
  );
}

function Sidebar(props: {
  changes: LocalChanges; tab: SideTab; onTab: (tab: SideTab) => void; grouped: boolean; onGrouped: (grouped: boolean) => void;
  tree: ReturnType<typeof reviewTree>; collapsed: string[]; onCollapsed: (ids: string[]) => void; selected: string | null; onSelect: (path: string) => void;
  onRepository: (directory: string) => void; onCommit: (commit: string | null) => void;
  loading: boolean; error: string; onRefresh: () => void; expanded: boolean; setExpanded?: (expanded: boolean) => void;
}) {
  const repository = () => props.changes.repositories.find(item => item.directory === props.changes.directory);
  const shownCommit = () => props.changes.commits.find(item => item.sha === props.changes.commit);
  const unpushed = () => props.changes.commits.filter(item => item.unpushed).length;
  const name = () => (
    <Text testID="changes-repository" style={{ flexShrink: 1, fontSize: text.body, lineHeight: 20, fontWeight: weight.semibold, color: palette().text, numberOfLines: 1 }}>
      {repositoryName(props.changes.directory ?? ".")}
    </Text>
  );
  return (
    <View testID="changes-sidebar" style={{ flex: 1, backgroundColor: palette().background }}>
      <View style={{ gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, borderBottomWidth: 1, borderColor: palette().border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="branch" size={16} color={palette().muted} />
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>
            <If when={props.changes.repositories.length > 1} else={name()}>
              <Picker testID="changes-repositories" title="Repositories in the worktree" placement="bottom" value={props.changes.directory ?? undefined} onSelect={props.onRepository}
                options={props.changes.repositories.map(item => ({ value: item.directory, label: repositoryName(item.directory), hint: item.branch ?? (item.head ? `detached at ${short(item.head)}` : "no commits yet") }))}
                trigger={
                  <BaseButton testID="changes-repository-pick" accessibilityLabel={`Repository ${repositoryName(props.changes.directory ?? ".")}: choose another`}
                    style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 4, height: 28, paddingHorizontal: 6, marginLeft: -6, borderRadius: radius.small }}
                    hoverStyle={{ backgroundColor: palette().hover }}>
                    {name()}
                    <Icon name="chevron-down" size={12} color={palette().muted} />
                  </BaseButton>
                } />
            </If>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <IconButton icon="refresh" label="Read the changes again" size={28} disabled={props.loading} onPress={props.onRefresh} testID="changes-refresh" />
            <If when={props.setExpanded}>
              {set => <IconButton testID="changes-expand" icon={props.expanded ? "minimize" : "maximize"} size={28}
                label={props.expanded ? "Back to the side panel" : "Expand to the full window"} onPress={() => set()(!props.expanded)} />}
            </If>
          </View>
        </View>
        <View testID="changes-branch" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Branch name={repository()?.branch ?? (repository()?.head ? "detached HEAD" : "no commits yet")} />
          <If when={repository()?.head}><Text style={{ fontFamily: monospace, fontSize: text.caption, color: palette().muted }}>{short(repository()?.head)}</Text></If>
          <If when={unpushed()}><Small>{`${plural(unpushed(), "commit")} not pushed`}</Small></If>
        </View>
        <If when={props.error}><Small tone="danger">{props.error}</Small></If>
      </View>
      <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: palette().border }}>
        <Segmented small testID="changes-tabs" value={props.tab} onChange={props.onTab} options={[
          { value: "files", label: `Files ${props.changes.files.length}` },
          { value: "commits", label: `Commits ${props.changes.commits.length}` },
        ]} />
      </View>
      <If when={props.tab === "files"}>
        <View testID="changes-scope" style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingLeft: 12, paddingRight: 6, borderBottomWidth: 1, borderColor: palette().border,
          backgroundColor: palette().surface }}>
          <If when={props.changes.commit}
            else={<Text style={{ flex: 1, fontSize: text.caption, color: palette().muted, numberOfLines: 1 }}>Uncommitted changes</Text>}>
            {sha => (
              <>
                <Icon name="commit" size={14} color={palette().muted} />
                <Text style={{ flex: 1, fontSize: text.caption, color: palette().text, numberOfLines: 1 }}>{`${short(sha())} ${shownCommit() ? subject(shownCommit()!) : ""}`}</Text>
                <IconButton testID="changes-uncommitted" icon="x" label="Back to the uncommitted changes" size={24} onPress={() => props.onCommit(null)} />
              </>
            )}
          </If>
        </View>
        <If when={props.changes.truncated}>
          <View style={{ paddingHorizontal: 12, paddingTop: 8 }}><Small>The changes are too large to show whole: the last files are left out.</Small></View>
        </If>
        <FilesTree files={props.changes.files} total={props.changes.files.length + (props.changes.omitted?.files ?? 0)} additions={props.changes.additions} deletions={props.changes.deletions}
          omitted={props.changes.omitted?.files} elsewhere="in the worktree" empty={props.changes.commit ? "This commit changes no files" : "No uncommitted changes"}
          grouped={props.grouped} onGrouped={props.onGrouped} tree={props.tree} collapsed={props.collapsed} onCollapsed={props.onCollapsed}
          selected={props.selected} onSelect={props.onSelect} />
      </If>
      <If when={props.tab === "commits"}>
        <Scroll testID="changes-commits" style={{ flex: 1 }} contentStyle={{ paddingVertical: 4 }}>
          <Each of={props.changes.commits} key={item => item.sha}>
            {item => (
              <BaseButton testID={`changes-commit-${short(item().sha)}`} accessibilityLabel={`Commit ${short(item().sha)}: ${subject(item())}${item().unpushed ? ", not pushed" : ""}`}
                onPress={() => props.onCommit(item().sha)}
                style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 12, paddingVertical: 6,
                  backgroundColor: props.changes.commit === item().sha ? palette().selection : "transparent" }}
                hoverStyle={{ backgroundColor: palette().hover }}>
                <Icon name="commit" size={14} color={item().unpushed ? palette().accent : palette().muted} style={{ marginTop: 3 }} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={{ fontSize: text.small, lineHeight: 19, color: palette().text, numberOfLines: 2 }}>{subject(item())}</Text>
                  <Text style={{ fontSize: text.caption, color: palette().muted, numberOfLines: 1 }}>
                    {`${short(item().sha)} · ${item().author ?? "unknown"}${item().date ? ` · ${relativeTime(item().date)}` : ""}${item().unpushed ? " · not pushed" : ""}`}
                  </Text>
                </View>
              </BaseButton>
            )}
          </Each>
          <If when={!props.changes.commits.length}><EmptyState title="No commits yet" /></If>
          <If when={props.changes.commits.length >= 100}><View style={{ paddingHorizontal: 12, paddingVertical: 8 }}><Small>The newest 100 commits.</Small></View></If>
        </Scroll>
      </If>
    </View>
  );
}
