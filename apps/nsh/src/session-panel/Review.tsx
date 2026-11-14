import { computed, effect, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { Button as BaseButton, DiffView, ResizablePanel, ResizablePanelGroup, TextView, Tree, type DiffLayout, type DiffSeparator, type DiffStats, type DiffViewRef, type DiffViewStyles, type TreeEntry, type TreeItem } from "nsh/base";
import type { GitHubReviewCommentView, PullRequestFileStatus, PullRequestFileView, PullRequestReview, SessionRecord } from "../../../../packages/shared/src/types";
import {
  filePatch, pullRequestFileStatusLabels, reviewDirectoryIds, reviewFileId, reviewFileOrder, reviewTree, type ReviewTreeNode,
} from "../../../../packages/shared/src/pull-request-review";
import { REDACTED, segment } from "../shared";
import { relativeTime } from "../lib/format";
import { openExternal } from "../lib/links";
import { createResource } from "../lib/resource";
import { Icon } from "../icons";
import { monospace, palette, radius, text, weight, type Tone } from "../theme";
import { Banner, Button, Divider, EmptyState, IconButton, Loading, Segmented, Small } from "../ui";
import { languageFor } from "./Files";
import { compactPanel, SwipeBack, type PanelTabProps } from "./parts";

const ideaLight = { added: "#0a7700", modified: "#0032a0", removed: "#616161", renamed: "#007c7c", copied: "#0a7700", inserted: "#bee6be", deleted: "#d6d6d6", insertedBar: "#62b543", deletedBar: "#a9a9a9" };
const ideaDark = { added: "#73a866", modified: "#6897bb", removed: "#7d7d7d", renamed: "#4aa3a3", copied: "#73a866", inserted: "#294436", deleted: "#484a4a", insertedBar: "#549159", deletedBar: "#6c6c6c" };
const idea = () => (palette().scheme === "dark" ? ideaDark : ideaLight);
const statusColor = (status: PullRequestFileStatus | undefined) => (status ? idea()[status] : palette().text);
const faded = (color: string) => `${color}80`;

const githubPull = (url: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const directoryName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function reviewUnavailable(current: SessionRecord): string | null {
  if (!(current.permissions ?? []).includes("write")) {
    return "The pull request is read with the session owner's GitHub access, which takes the session collaborator role, as the Files tab does. Viewers follow the conversation.";
  }
  return null;
}

export function Review(props: PanelTabProps) {
  return (
    <View testID="panel-review" style={{ flex: 1 }}>
      <If when={props.session()} else={<Loading />}>
        {current => (
          <If when={!reviewUnavailable(current())} else={<EmptyState title="Review unavailable">{reviewUnavailable(current()) ?? ""}</EmptyState>}>
            <If when={current().pullRequest}
              else={<EmptyState title="No pull request yet">When this session's work is opened as a pull request, its changed files and their diffs show here for review.</EmptyState>}>
              {pull => (
                <If when={githubPull(pull().url)}
                  else={
                    <EmptyState title="Not a github.com pull request"
                      action={<Button small variant="outline" icon="external-link" label="Open the pull request" testID="review-open-external" onPress={() => openExternal(pull().url)} />}>
                      Pull requests on github.com are reviewed here. This one opens where it is hosted.
                    </EmptyState>
                  }>
                  <Each of={[pull().url]} key={url => url}>{url => <Reviewer {...props} url={url()} />}</Each>
                </If>
              )}
            </If>
          </If>
        )}
      </If>
    </View>
  );
}

type SideTab = "files" | "commits" | "info";

function Reviewer(props: PanelTabProps & { url: string }) {
  const resource = createResource<{ review: PullRequestReview }>(() => `/api/sessions/${segment(props.sessionId)}/pull-request`);
  const review = () => resource.data()?.review ?? null;
  const tab = signal<SideTab>("files");
  const grouped = signal(true);
  const collapsed = signal<string[]>([]);
  const selected = signal<string | null>(null);
  const chosenLayout = signal<DiffLayout | null>(null);
  const sideWidth = signal(360);
  const expanded = () => props.expanded?.() ?? false;
  const layout = (): DiffLayout => chosenLayout() ?? (expanded() ? "split" : "unified");
  const tree = computed(() => reviewTree(review()?.files ?? [], grouped()));
  const order = computed(() => reviewFileOrder(tree()));
  const file = () => review()?.files.find(item => item.path === selected()) ?? null;
  const step = (by: number) => {
    const next = order()[order().indexOf(selected() ?? "") + by];
    if (next !== undefined) selected.set(next);
  };
  const select = (path: string) => {
    if (!review()?.files.some(item => item.path === path)) return;
    selected.set(path);
    tab.set("files");
  };
  effect(() => {
    const first = order()[0];
    if (expanded() && first !== undefined && !untracked(file)) selected.set(first);
  });
  props.backs?.add(() => {
    if (expanded() || selected() === null) return false;
    selected.set(null);
    return true;
  });
  let seen: string | undefined;
  effect(() => {
    const state = props.session()?.pullRequest?.state ?? "";
    untracked(() => {
      if (seen !== undefined && seen !== state) void resource.refresh();
      seen = state;
    });
  });

  const sidebar = (current: () => PullRequestReview) => (
    <Sidebar review={current()} session={props.session()} tab={tab()} onTab={value => tab.set(value)} grouped={grouped()} onGrouped={value => grouped.set(value)}
      tree={tree()} collapsed={collapsed()} onCollapsed={value => collapsed.set(value)} selected={selected()} onSelect={select}
      loading={resource.loading()} onRefresh={() => void resource.refresh()} expanded={expanded()} setExpanded={props.setExpanded} />
  );
  const diff = (current: () => PullRequestReview, open: () => PullRequestFileView, back: boolean) => (
    <SwipeBack testID="review-swipe" edge onBack={back ? () => selected.set(null) : undefined}>
      <Each of={[open().path]} key={path => path}>
        {() => (
          <DiffPane file={open()} layout={layout()}
            oldTitle={revision(current().pull.pullRequest?.base.ref, current().pull.pullRequest?.base.sha)} newTitle={revision(current().pull.pullRequest?.head.ref, current().pull.pullRequest?.head.sha)}
            external={{ label: "Open on GitHub", url: `${current().pull.url}/files` }} onLayout={value => chosenLayout.set(value)} onBack={back ? () => selected.set(null) : undefined}
            index={order().indexOf(open().path)} count={order().length} onStep={step} expanded={expanded()} setExpanded={props.setExpanded} />
        )}
      </Each>
    </SwipeBack>
  );
  return (
    <If when={review()}
      else={
        <If when={!resource.error()} else={
          <View style={{ padding: 16 }}>
            <Banner tone="danger" title="Couldn't load the pull request" actions={<Button small variant="outline" label="Try again" onPress={() => void resource.refresh()} />}>{resource.error()}</Banner>
          </View>
        }>
          <Loading label="Loading the pull request…" />
        </If>
      }>
      {current => (
        <If when={expanded()}
          else={<If when={file()} else={sidebar(current)}>{open => diff(current, open, true)}</If>}>
          <ResizablePanelGroup testID="review-full" handleStyle={{ backgroundColor: palette().border }} handleAccessibilityLabel="Resize the files list">
            <ResizablePanel size={sideWidth()} minSize={240} maxSize={640} fixed onResize={event => sideWidth.set(event.size)}>
              {sidebar(current)}
            </ResizablePanel>
            <ResizablePanel minSize={320}>
              <If when={file()} else={<EmptyState title="Select a file to see its diff" />}>{open => diff(current, open, false)}</If>
            </ResizablePanel>
          </ResizablePanelGroup>
        </If>
      )}
    </If>
  );
}

export const revision = (ref: string | undefined | null, sha: string | undefined | null) => `${ref ?? ""}${sha ? `${ref ? " " : ""}(${sha.slice(0, 7)})` : ""}`;

export function Counts(props: { additions: number; deletions: number }) {
  const style = { fontFamily: monospace, fontSize: text.caption } as const;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
      <If when={props.additions > 0}><Text style={{ ...style, color: palette().tones.success.text }}>{`+${props.additions}`}</Text></If>
      <If when={props.deletions > 0}><Text style={{ ...style, color: palette().tones.danger.text }}>{`−${props.deletions}`}</Text></If>
    </View>
  );
}

export function Pill(props: { label: string; color: string; testID?: string }) {
  return (
    <View testID={props.testID} style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 22, paddingHorizontal: 8, borderRadius: radius.pill, borderWidth: 1,
      borderColor: palette().border, backgroundColor: palette().control }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: props.color }} />
      <Text style={{ fontSize: text.caption, color: palette().text, numberOfLines: 1 }}>{props.label}</Text>
    </View>
  );
}

export function Branch(props: { name: string }) {
  return (
    <View style={{ flexShrink: 1, height: 22, justifyContent: "center", paddingHorizontal: 8, borderRadius: radius.small, backgroundColor: palette().control }}>
      <Text style={{ fontFamily: monospace, fontSize: text.caption, color: palette().text, numberOfLines: 1 }}>{props.name}</Text>
    </View>
  );
}

function pullState(review: PullRequestReview): { label: string; color: string } {
  const pull = review.pull.pullRequest;
  if (pull?.merged) return { label: "Merged", color: palette().merged };
  if (review.pull.state === "closed") return { label: "Closed", color: palette().tones.danger.text };
  if (pull?.draft) return { label: "Draft", color: palette().faint };
  return { label: "Open", color: palette().tones.success.text };
}

function checkSummary(review: PullRequestReview): { label: string; tone: Tone } | null {
  const checks = review.pull.pullRequest?.checks ?? [];
  if (!checks.length) return null;
  const pending = checks.filter(check => check.status !== "completed").length;
  const passed = checks.filter(check => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "")).length;
  const failed = checks.length - pending - passed;
  if (failed) return { label: `${plural(failed, "check")} failed`, tone: "danger" };
  if (pending) return { label: `${plural(pending, "check")} running`, tone: "warning" };
  return { label: `${plural(passed, "check")} passed`, tone: "success" };
}

interface SidebarProps {
  review: PullRequestReview;
  session: SessionRecord | null;
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  grouped: boolean;
  onGrouped: (grouped: boolean) => void;
  tree: ReviewTreeNode[];
  collapsed: string[];
  onCollapsed: (ids: string[]) => void;
  selected: string | null;
  onSelect: (path: string) => void;
  loading: boolean;
  onRefresh: () => void;
  expanded: boolean;
  setExpanded?: (expanded: boolean) => void;
}

function Sidebar(props: SidebarProps) {
  const pull = () => props.review.pull;
  const state = () => pullState(props.review);
  const checks = () => checkSummary(props.review);
  const comments = computed(() => {
    const counts = new Map<string, number>();
    for (const comment of props.review.pull.pullRequest?.reviewComments ?? []) counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
    return counts;
  });
  return (
    <View testID="review-sidebar" style={{ flex: 1, backgroundColor: palette().background }}>
      <View style={{ gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, borderBottomWidth: 1, borderColor: palette().border }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <Icon name="pull-request" size={16} color={state().color} style={{ marginTop: 6 }} />
          <View selectable style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
            <Text testID="review-title" style={{ fontSize: text.body, lineHeight: 20, fontWeight: weight.semibold, color: palette().text, numberOfLines: 3 }}>
              {`${pull().title} #${pull().number}`}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <IconButton icon="refresh" label="Refresh the pull request" size={28} disabled={props.loading} onPress={props.onRefresh} testID="review-refresh" />
            <IconButton icon="external-link" label="Open on GitHub" size={28} onPress={() => openExternal(pull().url)} />
            <If when={props.setExpanded}>
              {set => <IconButton testID="review-expand" icon={props.expanded ? "minimize" : "maximize"} size={28}
                label={props.expanded ? "Back to the side panel" : "Expand to the full window"} onPress={() => set()(!props.expanded)} />}
            </If>
          </View>
        </View>
        <If when={pull().pullRequest}>
          {details => (
            <View testID="review-branches" accessibilityLabel={`${details().head.ref} into ${details().base.ref}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Branch name={details().base.ref} />
              <Icon name="arrow-left" size={12} color={palette().muted} />
              <Branch name={details().head.ref} />
            </View>
          )}
        </If>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Pill testID="review-state" label={state().label} color={state().color} />
          <If when={checks()}>{summary => <Pill testID="review-checks" label={summary().label} color={palette().dots[summary().tone]} />}</If>
          <Small>{`${pull().author ?? "unknown"} · ${relativeTime(pull().createdAt)}`}</Small>
        </View>
      </View>
      <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: palette().border }}>
        <Segmented small testID="review-tabs" value={props.tab} onChange={props.onTab} options={[
          { value: "files", label: `Files ${props.review.files.length}` },
          { value: "commits", label: `Commits ${props.review.commits.length}` },
          { value: "info", label: "Info" },
        ]} />
      </View>
      <If when={props.tab === "files"}>
        <FilesTree files={props.review.files} total={props.review.changedFiles} additions={props.review.additions} deletions={props.review.deletions}
          omitted={props.review.omitted?.files} elsewhere="on GitHub" comments={comments()} grouped={props.grouped} onGrouped={props.onGrouped} tree={props.tree}
          collapsed={props.collapsed} onCollapsed={props.onCollapsed} selected={props.selected} onSelect={props.onSelect} />
      </If>
      <If when={props.tab === "commits"}><Commits review={props.review} /></If>
      <If when={props.tab === "info"}><Info review={props.review} onSelect={props.onSelect} /></If>
    </View>
  );
}

export interface FilesTreeProps {
  files: PullRequestFileView[];
  total: number;
  additions: number;
  deletions: number;
  omitted?: number;
  elsewhere: string;
  empty?: string;
  comments?: Map<string, number>;
  grouped: boolean;
  onGrouped: (grouped: boolean) => void;
  tree: ReviewTreeNode[];
  collapsed: string[];
  onCollapsed: (ids: string[]) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}

export function FilesTree(props: FilesTreeProps) {
  const toItems = (nodes: ReviewTreeNode[]): TreeItem[] => nodes.map(node => ({ id: node.id, label: node.label, ...(node.children ? { children: toItems(node.children) } : {}) }));
  const items = computed(() => toItems(props.tree));
  const nodes = computed(() => {
    const found = new Map<string, ReviewTreeNode>();
    const walk = (list: ReviewTreeNode[]) => { for (const node of list) { found.set(node.id, node); if (node.children) walk(node.children); } };
    walk(props.tree);
    return found;
  });
  const directories = computed(() => reviewDirectoryIds(props.tree));
  const expandedIds = () => directories().filter(id => !props.collapsed.includes(id));
  const sections = computed(() => {
    const byPath = new Map(props.files.map(item => [item.path, item]));
    const found: { directory: string; files: PullRequestFileView[] }[] = [];
    for (const path of reviewFileOrder(props.tree)) {
      const item = byPath.get(path);
      if (!item) continue;
      const directory = props.grouped ? directoryName(path) : "";
      const last = found.at(-1);
      if (last && last.directory === directory) last.files.push(item);
      else found.push({ directory, files: [item] });
    }
    return found;
  });
  const touchRow = (item: () => PullRequestFileView) => (
    <BaseButton testID={`review-${reviewFileId(item().path)}`} accessibilityLabel={`${item().path}, ${pullRequestFileStatusLabels[item().status]}`}
      onPress={() => props.onSelect(item().path)}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: props.grouped ? 44 : 52, paddingLeft: 16, paddingRight: 10,
        backgroundColor: props.selected === item().path ? palette().selection : "transparent" }}
      activeStyle={{ backgroundColor: palette().hover }}>
      <Icon name="file" size={16} color={statusColor(item().status)} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ numberOfLines: 1, fontSize: text.body, color: statusColor(item().status) }}>{baseName(item().path)}</Text>
        <If when={!props.grouped && directoryName(item().path)}>
          <Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().faint }}>{directoryName(item().path)}</Text>
        </If>
      </View>
      <If when={props.comments?.get(item().path)}>
        {count => (
          <View accessibilityLabel={plural(count(), "review comment")} style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}>
            <Icon name="message" size={12} color={palette().muted} />
            <Text style={{ fontSize: text.caption, color: palette().muted }}>{String(count())}</Text>
          </View>
        )}
      </If>
      <Counts additions={item().additions} deletions={item().deletions} />
      <Icon name="chevron-right" size={14} color={palette().faint} />
    </BaseButton>
  );
  const row = (entry: TreeEntry): JSX.Element => {
    const node = () => nodes().get(entry.id);
    const current = () => node()?.file;
    const color = () => (entry.folder ? palette().text : statusColor(current()?.status));
    const active = () => !entry.folder && props.selected !== null && entry.id === reviewFileId(props.selected);
    return (
      <View testID={`review-${entry.id}`}
        accessibilityLabel={entry.folder ? `${node()?.path ?? entry.label}, ${plural(node()?.files ?? 0, "file")}`
          : `${node()?.path ?? entry.label}, ${current() ? pullRequestFileStatusLabels[current()!.status] : ""}`}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 26, paddingLeft: 8 + entry.depth * 16, paddingRight: 10,
          backgroundColor: active() ? palette().selection : "transparent" }}>
        <If when={entry.folder} else={<View style={{ width: 12 }} />}>
          <Icon name={props.collapsed.includes(entry.id) ? "chevron-right" : "chevron-down"} size={12} color={palette().faint} />
        </If>
        <Icon name={entry.folder ? "folder" : "file"} size={14} color={entry.folder ? palette().muted : color()} />
        <Text style={{ flexShrink: 1, numberOfLines: 1, fontSize: text.small, color: color() }}>{entry.label}</Text>
        <If when={entry.folder}>
          <Text style={{ flexShrink: 0, numberOfLines: 1, fontSize: text.caption, color: palette().faint }}>{plural(node()?.files ?? 0, "file")}</Text>
        </If>
        <If when={!entry.folder && !props.grouped && directoryName(node()?.path ?? "")}>
          <Text style={{ flexShrink: 2, numberOfLines: 1, fontSize: text.caption, color: palette().faint }}>{directoryName(node()?.path ?? "")}</Text>
        </If>
        <View style={{ flex: 1 }} />
        <If when={!entry.folder ? props.comments?.get(node()?.path ?? "") : undefined}>
          {count => (
            <View accessibilityLabel={plural(count(), "review comment")} style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}>
              <Icon name="message" size={12} color={palette().muted} />
              <Text style={{ fontSize: text.caption, color: palette().muted }}>{String(count())}</Text>
            </View>
          )}
        </If>
        <If when={current()}>{changed => <Counts additions={changed().additions} deletions={changed().deletions} />}</If>
      </View>
    );
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingLeft: 12, paddingRight: 6 }}>
        <Text testID="review-file-count" style={{ fontSize: text.caption, color: palette().muted, numberOfLines: 1 }}>{plural(props.total, "file")}</Text>
        <Counts additions={props.additions} deletions={props.deletions} />
        <View style={{ flex: 1 }} />
        <IconButton testID="review-group" icon="folder" label={props.grouped ? "Show the files as a list" : "Group the files by directory"} size={28} active={props.grouped}
          onPress={() => props.onGrouped(!props.grouped)} />
        <If when={!compactPanel()}>
          <IconButton testID="review-expand-all" icon="unfold" label="Expand all" size={28} disabled={!props.grouped || !props.collapsed.length} onPress={() => props.onCollapsed([])} />
          <IconButton testID="review-collapse-all" icon="fold" label="Collapse all" size={28} disabled={!props.grouped || !expandedIds().length}
            onPress={() => props.onCollapsed(directories())} />
        </If>
      </View>
      <If when={props.omitted}>
        {omitted => <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}><Small>{`Showing the first ${props.files.length} files; ${plural(omitted(), "more is", "more are")} ${props.elsewhere}.`}</Small></View>}
      </If>
      <If when={props.files.length && compactPanel()}>
        <Scroll testID="review-list" accessibilityLabel="Changed files" style={{ flex: 1 }} contentStyle={{ paddingBottom: 24 }}>
          <Each of={sections()} key="index">
            {section => (
              <>
                <If when={props.grouped}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 30, paddingHorizontal: 16, backgroundColor: palette().surface }}>
                    <Icon name="folder" size={12} color={palette().muted} />
                    <Text style={{ flex: 1, numberOfLines: 1, fontFamily: monospace, fontSize: text.caption, color: palette().muted }}>{section().directory || "/"}</Text>
                  </View>
                </If>
                <Each of={section().files} key={item => item.path}>{touchRow}</Each>
              </>
            )}
          </Each>
        </Scroll>
      </If>
      <If when={!props.files.length}><EmptyState title={props.empty ?? "No changed files"} /></If>
      <If when={props.files.length && !compactPanel()}>
        <Tree testID="review-tree" accessibilityLabel="Changed files" style={{ flex: 1 }} listStyle={{ paddingBottom: 16 }} items={items()} expanded={expandedIds()}
          selected={props.selected === null ? null : reviewFileId(props.selected)} renderItem={row}
          onExpandedChange={event => props.onCollapsed(directories().filter(id => !event.expanded.includes(id)))}
          onSelectedChange={event => { const node = nodes().get(event.selected); if (node?.file) props.onSelect(node.path); }}
          onAction={event => { const node = nodes().get(event.id); if (node?.file) props.onSelect(node.path); }} />
      </If>
    </View>
  );
}

function Commits(props: { review: PullRequestReview }) {
  return (
    <Scroll testID="review-commits" style={{ flex: 1 }} contentStyle={{ paddingVertical: 4 }}>
      <If when={props.review.omitted?.commits}>
        {omitted => <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}><Small>{`Showing the first ${props.review.commits.length} commits; ${plural(omitted(), "more is", "more are")} on GitHub.`}</Small></View>}
      </If>
      <Each of={props.review.commits} key={commit => commit.sha}>
        {commit => (
          <BaseButton accessibilityLabel={`Commit ${commit().sha.slice(0, 7)}: ${commit().message.split("\n")[0]}`}
            onPress={() => openExternal(`${props.review.pull.url}/commits/${commit().sha}`)}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 12, paddingVertical: 6 }} hoverStyle={{ backgroundColor: palette().hover }}>
            <Icon name="commit" size={14} color={palette().muted} style={{ marginTop: 3 }} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={{ fontSize: text.small, lineHeight: 19, color: palette().text, numberOfLines: 2 }}>{commit().message.split("\n")[0]}</Text>
              <Text style={{ fontSize: text.caption, color: palette().muted, numberOfLines: 1 }}>
                {`${commit().sha.slice(0, 7)} · ${commit().author ?? "unknown"}${commit().date ? ` · ${relativeTime(commit().date)}` : ""}`}
              </Text>
            </View>
          </BaseButton>
        )}
      </Each>
      <If when={!props.review.commits.length}><EmptyState title="No commits" /></If>
    </Scroll>
  );
}

const reviewStates: Record<string, { label: string; tone: Tone }> = {
  APPROVED: { label: "Approved", tone: "success" },
  CHANGES_REQUESTED: { label: "Changes requested", tone: "danger" },
  COMMENTED: { label: "Commented", tone: "neutral" },
  DISMISSED: { label: "Dismissed", tone: "neutral" },
  PENDING: { label: "Pending", tone: "warning" },
};

function Heading(props: { children: string }) {
  return <Text style={{ fontSize: text.caption, fontWeight: weight.medium, color: palette().muted }}>{props.children}</Text>;
}

function Remark(props: { author: string | null; when: string | null; label?: string; color?: string; body: string; place?: string; onPress?: () => void; testID?: string }) {
  return (
    <View testID={props.testID} style={{ gap: 4, padding: 10, borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Text style={{ fontSize: text.small, fontWeight: weight.medium, color: palette().text }}>{props.author ?? "unknown"}</Text>
        <If when={props.label}><Text style={{ fontSize: text.caption, color: props.color ?? palette().muted }}>{props.label}</Text></If>
        <If when={props.when}>{when => <Text style={{ fontSize: text.caption, color: palette().faint }}>{relativeTime(when())}</Text>}</If>
      </View>
      <If when={props.place}>
        {place => (
          <Text onPress={props.onPress} role={props.onPress ? "link" : undefined}
            style={{ fontFamily: monospace, fontSize: text.caption, color: props.onPress ? palette().accent : palette().muted, numberOfLines: 1 }}>{place()}</Text>
        )}
      </If>
      <If when={props.body.trim()}><View selectable><Text style={{ fontSize: text.small, lineHeight: 19, color: palette().text }}>{props.body}</Text></View></If>
    </View>
  );
}

function Info(props: { review: PullRequestReview; onSelect: (path: string) => void }) {
  const pull = () => props.review.pull;
  const details = () => pull().pullRequest;
  const reviews = () => (details()?.reviews ?? []).filter(item => item.state !== "COMMENTED" || item.body.trim());
  const failing = () => (details()?.checks ?? []).filter(check => !(check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "")));
  const place = (comment: GitHubReviewCommentView) => `${comment.path}${comment.line ?? comment.originalLine ? `:${comment.line ?? comment.originalLine}` : ""}${comment.line === null ? " (outdated)" : ""}`;
  const known = (path: string) => props.review.files.some(file => file.path === path);
  return (
    <Scroll testID="review-info" style={{ flex: 1 }} contentStyle={{ gap: 16, padding: 12, paddingBottom: 32 }}>
      <View style={{ gap: 6 }}>
        <Heading>Description</Heading>
        <If when={pull().body.trim()} else={<Small>No description.</Small>}>
          <TextView markdown={pull().body} selectable onLinkPress={event => openExternal(event.url)} />
        </If>
      </View>
      <If when={details()?.checks.length}>
        <View testID="review-check-list" style={{ gap: 6 }}>
          <Heading>{`Checks (${details()?.checks.length ?? 0})`}</Heading>
          <If when={failing().length} else={<Small tone="success">All checks passed.</Small>}>
            <Each of={failing()} key="index">
              {check => (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: palette().dots[check().status === "completed" ? "danger" : "warning"] }} />
                  <Text style={{ flex: 1, fontSize: text.small, color: palette().text, numberOfLines: 1 }}>{check().name}</Text>
                  <Text style={{ fontSize: text.caption, color: palette().muted }}>{(check().status === "completed" ? check().conclusion ?? "failed" : check().status).replace(/_/g, " ")}</Text>
                </View>
              )}
            </Each>
          </If>
        </View>
      </If>
      <If when={reviews().length}>
        <View style={{ gap: 6 }}>
          <Heading>Reviews</Heading>
          <Each of={reviews()} key={item => item.id}>
            {item => <Remark author={item().author} when={item().submittedAt} body={item().body} label={reviewStates[item().state]?.label ?? item().state}
              color={palette().tones[reviewStates[item().state]?.tone ?? "neutral"].text} />}
          </Each>
        </View>
      </If>
      <If when={details()?.reviewComments.length}>
        <View style={{ gap: 6 }}>
          <Heading>Review comments</Heading>
          <Each of={details()?.reviewComments ?? []} key={item => item.id}>
            {item => <Remark testID={`review-comment-${item().id}`} author={item().author} when={item().createdAt} body={item().body} place={place(item())}
              onPress={known(item().path) ? () => props.onSelect(item().path) : undefined} />}
          </Each>
        </View>
      </If>
      <If when={pull().comments.length}>
        <View style={{ gap: 6 }}>
          <Heading>Conversation</Heading>
          <Each of={pull().comments} key={item => item.id}>{item => <Remark author={item().author} when={item().createdAt} body={item().body} />}</Each>
        </View>
      </If>
      <If when={pull().omitted}><Small>Long threads show their newest items. The rest is on GitHub.</Small></If>
    </Scroll>
  );
}

const wrapLines = signal(true);

function diffStyles(): DiffViewStyles {
  const colors = idea();
  return {
    side: { backgroundColor: palette().background },
    gutter: { backgroundColor: palette().background },
    lineNumber: { color: palette().faint },
    lineNumberAdded: { color: palette().muted, backgroundColor: faded(colors.inserted) },
    lineNumberDeleted: { color: palette().muted, backgroundColor: faded(colors.deleted) },
    lineAdded: { backgroundColor: faded(colors.inserted) },
    lineDeleted: { backgroundColor: faded(colors.deleted) },
    wordAdded: { backgroundColor: colors.inserted },
    wordDeleted: { backgroundColor: colors.deleted },
    indicatorAdded: { backgroundColor: colors.insertedBar },
    indicatorDeleted: { backgroundColor: colors.deletedBar },
    filler: { backgroundColor: palette().surface },
    separator: { backgroundColor: palette().surfaceRaised },
  };
}

function Separator(props: { value: DiffSeparator }) {
  const label = () => (props.value.header?.trim() ? props.value.header.trim() : props.value.lines ? plural(props.value.lines, "unchanged line") : "");
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, backgroundColor: palette().surfaceRaised }}>
      <Text style={{ fontSize: text.caption, color: palette().faint }}>⋯</Text>
      <Text style={{ flex: 1, numberOfLines: 1, fontFamily: monospace, fontSize: text.caption, color: palette().muted }}>{label()}</Text>
    </View>
  );
}

export function DiffPane(props: {
  file: PullRequestFileView; layout: DiffLayout; onLayout: (layout: DiffLayout) => void; onBack?: () => void; oldTitle: string; newTitle: string;
  external?: { label: string; url: string };
  index: number; count: number; onStep: (by: number) => void; expanded: boolean; setExpanded?: (expanded: boolean) => void;
}) {
  let view: DiffViewRef | undefined;
  const stats = signal<DiffStats | null>(null);
  const patch = () => filePatch(props.file);
  const heading = { flex: 1, paddingHorizontal: 12, paddingVertical: 4, fontFamily: monospace, fontSize: text.caption, numberOfLines: 1 } as const;
  const compact = () => compactPanel() && !props.expanded;
  const layout = (): DiffLayout => (compact() ? "unified" : props.layout);
  const origin = () => (props.file.previousPath ? `${directoryName(props.file.path)} · from ${props.file.previousPath}` : directoryName(props.file.path));
  return (
    <View testID="review-diff" style={{ flex: 1, backgroundColor: palette().background }}>
      <If when={compact()}>
        <View testID="review-diff-header" style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 52, paddingLeft: 4, paddingRight: 12, borderBottomWidth: 1, borderColor: palette().border }}>
          <If when={props.onBack} else={<View style={{ width: 8 }} />}>
            {back => <IconButton testID="review-back" icon="chevron-left" label="Back to the files" size={40} onPress={() => back()()} />}
          </If>
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <Text testID="review-diff-path" accessibilityLabel={`${props.file.path}, ${pullRequestFileStatusLabels[props.file.status]}`}
              style={{ numberOfLines: 1, fontSize: text.body, fontWeight: weight.medium, color: statusColor(props.file.status) }}>{baseName(props.file.path)}</Text>
            <If when={origin()}><Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().faint }}>{origin()}</Text></If>
          </View>
          <Text testID="review-file-position" style={{ flexShrink: 0, fontSize: text.caption, color: palette().muted }}>{`${props.index + 1} of ${props.count}`}</Text>
        </View>
      </If>
      <If when={!compact()}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, minHeight: 40, paddingHorizontal: 6, borderBottomWidth: 1, borderColor: palette().border }}>
        <If when={props.onBack}>{back => <IconButton testID="review-back" icon="chevron-left" label="Back to the files" size={28} onPress={() => back()()} />}</If>
        <IconButton testID="review-previous-change" icon="arrow-up" label="Previous change" size={28} disabled={!stats()?.hunks} onPress={() => void view?.previousHunk()} />
        <IconButton testID="review-next-change" icon="arrow-down" label="Next change" size={28} disabled={!stats()?.hunks} onPress={() => void view?.nextHunk()} />
        <Divider vertical />
        <IconButton testID="review-layout-split" icon="columns" label="Side-by-side viewer" size={28} active={props.layout === "split"} onPress={() => props.onLayout("split")} />
        <IconButton testID="review-layout-unified" icon="rows" label="Unified viewer" size={28} active={props.layout === "unified"} onPress={() => props.onLayout("unified")} />
        <Divider vertical />
        <View selectable style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 6 }}>
          <Text testID="review-diff-path" accessibilityLabel={`${props.file.path}, ${pullRequestFileStatusLabels[props.file.status]}`}
            style={{ flexShrink: 1, numberOfLines: 1, fontSize: text.small, color: statusColor(props.file.status) }}>{baseName(props.file.path)}</Text>
          <Text style={{ flexShrink: 2, numberOfLines: 1, fontSize: text.caption, color: palette().faint }}>
            {props.file.previousPath ? `${directoryName(props.file.path)} · from ${props.file.previousPath}` : directoryName(props.file.path)}
          </Text>
        </View>
        <If when={stats()}>
          {current => <Text testID="review-differences" style={{ flexShrink: 0, paddingHorizontal: 6, fontSize: text.caption, color: palette().muted }}>{plural(current().hunks, "difference")}</Text>}
        </If>
        <IconButton testID="review-previous-file" icon="chevron-up" label="Previous file" size={28} disabled={props.index <= 0} onPress={() => props.onStep(-1)} />
        <Text style={{ flexShrink: 0, fontSize: text.caption, color: palette().muted }}>{`${props.index + 1}/${props.count}`}</Text>
        <IconButton testID="review-next-file" icon="chevron-down" label="Next file" size={28} disabled={props.index < 0 || props.index >= props.count - 1} onPress={() => props.onStep(1)} />
        <If when={props.setExpanded}>
          {set => <IconButton testID="review-diff-expand" icon={props.expanded ? "minimize" : "maximize"} size={28}
            label={props.expanded ? "Back to the side panel" : "Expand to the full window"} onPress={() => set()(!props.expanded)} />}
        </If>
      </View>
      </If>
      <If when={props.file.redacted}>
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}><Banner title="Secret hidden">{`Something that looks like a secret is shown as ${REDACTED}, as in the conversation.`}</Banner></View>
      </If>
      <If when={patch()}
        else={
          <EmptyState title={props.file.truncated ? "Too large to show here" : "No text changes to show"}
            action={<If when={props.external}>{external => <Button small variant="outline" icon="external-link" label={external().label} onPress={() => openExternal(external().url)} />}</If>}>
            {props.file.truncated ? "This file's diff is too large for the reviewer." : props.file.status === "renamed" ? "The file was renamed without changes."
              : "The file is binary, or its contents didn't change."}
          </EmptyState>
        }>
        {unified => (
          <>
            <If when={layout() === "split"}>
              <View testID="review-revisions" style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
                <Text style={{ ...heading, color: palette().muted }}>{props.file.status === "added" ? "—" : props.oldTitle}</Text>
                <Divider vertical />
                <Text style={{ ...heading, color: palette().muted }}>{props.file.status === "removed" ? "—" : props.newTitle}</Text>
              </View>
            </If>
            <DiffView ref={ref => { view = ref; }} testID="review-diff-view" style={{ flex: 1 }}
              patch={unified()} language={languageFor(props.file.path)} layout={layout()} inline="word" indicators="bars" background={false}
              softWrap={compact() && wrapLines()} fontSize={compact() ? text.caption : text.small} lineHeight={compact() ? 18 : 20}
              styles={diffStyles()} renderSeparator={value => <Separator value={value} />} onStatsChange={event => stats.set(event.stats)} />
          </>
        )}
      </If>
      <If when={compact()}>
        <View testID="review-diff-bar" style={{ flexDirection: "row", alignItems: "center", gap: 2, minHeight: 52, paddingHorizontal: 6, borderTopWidth: 1, borderColor: palette().border,
          backgroundColor: palette().surface }}>
          <IconButton testID="review-previous-file" icon="chevron-left" label="Previous file" size={40} disabled={props.index <= 0} onPress={() => props.onStep(-1)} />
          <IconButton testID="review-next-file" icon="chevron-right" label="Next file" size={40} disabled={props.index < 0 || props.index >= props.count - 1} onPress={() => props.onStep(1)} />
          <Text testID="review-differences" style={{ flex: 1, textAlign: "center", numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>
            {stats() ? plural(stats()!.hunks, "difference") : ""}
          </Text>
          <IconButton testID="review-wrap" icon="wrap" label={wrapLines() ? "Scroll long lines sideways" : "Wrap long lines"} size={40} active={wrapLines()}
            onPress={() => wrapLines.update(value => !value)} />
          <IconButton testID="review-previous-change" icon="arrow-up" label="Previous change" size={40} disabled={!stats()?.hunks} onPress={() => void view?.previousHunk()} />
          <IconButton testID="review-next-change" icon="arrow-down" label="Next change" size={40} disabled={!stats()?.hunks} onPress={() => void view?.nextHunk()} />
        </View>
      </If>
    </View>
  );
}
