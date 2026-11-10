import { computed, effect, platform, signal, Text, View, type JSX } from "nsh";
import { Button as BaseButton, TextView, Tooltip } from "nsh/base";
import {
  callHeadline, COMPACTION_FAILED_TITLE, compactionFailureText, copyText, resultOutcome, resultOutput, shownImages, splitToolCalls, textBesideImages, toolCallRows,
  type EntryView,
} from "../shared";
import { EntryImages } from "./EntryImages";
import { formatDuration, modelFailure } from "../lib/format";
import { openMessageLink } from "../lib/links";
import { createUsername } from "../lib/people";
import { Icon, type IconName } from "../icons";
import { monospace, palette, radius, text } from "../theme";
import { Banner } from "../ui";

/**
 * " · Auto-approved" for an entry whose tool calls ran their commands under auto-approve, which have no approval card,
 * with any outcome other than the usual "executed" (still running, failed, interrupted).
 */
function autoApprovedSuffix(calls: EntryView["autoApproved"]): string {
  if (!Array.isArray(calls) || !calls.length) return "";
  const notes = calls.filter(call => call.status !== "executed").map(call => calls.length > 1 ? `${call.tool}: ${call.status}` : call.status);
  return ` · Auto-approved${calls.some(call => call.unbounded) ? " · No resource limits" : ""}${notes.map(note => ` · ${note}`).join("")}`;
}

const toolIcons: Record<string, IconName> = {
  read: "file", write: "compose", edit: "compose", ls: "folder", find: "search", grep: "search", source_read: "file",
  read_file: "file", write_file: "compose", edit_file: "compose", list_files: "folder", search: "search", move_file: "file", copy_file: "file",
  delete_file: "trash", identity: "user", web_search: "search", fetch_content: "globe", gh: "github",
  browser: "globe", git: "branch", git_commit: "branch", git_push: "branch", git_repin: "branch",
  github_comment: "pull-request", github_merge: "pull-request", github_issue: "pull-request", github_read: "pull-request",
  schedule: "clock", sessions: "list", tunnel: "link",
};
const toolIcon = (name: string): IconName => toolIcons[name] ?? "terminal";

/**
 * One row of tool work: a call and what came of it, a result whose call isn't shown, or a system note. `input` is what
 * it was asked (a call's arguments, a note's text) and `output` what came of it, each shown when the row is opened.
 */
type ToolItem = {
  key: string;
  icon: IconName;
  label: string;
  meta: string;
  failed: boolean;
  input: string;
  /** Undefined for a call no result answered (yet). */
  output?: string;
  trimmed?: EntryView["trimmed"];
  /** The entry whose images show under the output, as thumbnails. */
  imageEntry?: EntryView;
};

type Shown =
  | { kind: "stopped"; text: string }
  | { kind: "tools"; tools: ToolItem[] }
  | { kind: "error"; title: string; text: string; by: string }
  | { kind: "user"; text: string; meta: string }
  | { kind: "assistant"; prose: string; tools: ToolItem[]; meta: string };

/** A result's text beside the thumbnails of its images, where they show. */
function besideImages(entry: EntryView, sees: boolean): { text: string; images: number } {
  const images = shownImages(entry, sees).length;
  return { text: images ? textBesideImages(entry.text, images) : entry.text, images };
}

/**
 * An assistant entry's tool calls, a row each with the result `results` pairs it with (pairToolResults): what it did,
 * then what came of it, and the tool's time. `actor`: who sent the message, where it isn't the viewer.
 */
function callItems(entry: EntryView, results: readonly (EntryView | undefined)[], actor: string, sees: boolean): ToolItem[] {
  const rows = toolCallRows(entry, results);
  return rows.map((row, index) => {
    const result = row.result;
    const shown = result ? besideImages(result, sees) : undefined;
    // The call's entry carries the model's time; its result, the tool's.
    const took = result?.durationMs !== undefined ? formatDuration(result.durationMs) : "";
    return {
      key: row.key, icon: row.outcome?.failed ? "alert" : toolIcon(row.name), failed: row.outcome?.failed === true, input: row.args,
      label: `${callHeadline(row.name, row.target)}${row.outcome?.text ? ` → ${row.outcome.text}` : ""}`,
      meta: [took, actor, autoApprovedSuffix(row.autoApproved ? [row.autoApproved] : undefined).replace(/^ · /, "")].filter(Boolean).join(" · "),
      ...(result && shown ? { output: resultOutput(result, shown.text), ...(shown.images ? { imageEntry: result } : {}) } : {}),
      // A shortened result says so on its row; calls cut short, once, on their entry's last row.
      ...(result?.trimmed ? { trimmed: result.trimmed } : index === rows.length - 1 && entry.trimmed ? { trimmed: entry.trimmed } : {}),
    };
  });
}

/**
 * What an entry shows, as the Expo app's TranscriptEntry decided it. `shared`: a share link's, whose readers get no advice.
 * `sees`: its viewer sees the transcript's images, as thumbnails in place of their `[image <type>]` lines. `results`: the
 * results of its tool calls, shown with them.
 */
function describe(entry: EntryView, userId: string, name: (id: string, you?: boolean) => string, shared = false, sees = false, results: readonly (EntryView | undefined)[] = []): Shown {
  const actor = entry.actorId ? name(entry.actorId, true) : "";
  const other = actor && actor !== "you" ? actor : "";
  if (entry.kind === "workspace.run-stopped" || entry.kind === "workspace.run-crashed" || entry.kind === "workspace.run-refused") {
    return { kind: "stopped", text: entry.kind === "workspace.run-stopped" ? `Stopped${actor ? ` by ${actor}` : ""}` : entry.text };
  }
  if (entry.role === "toolResult") {
    // A result whose call isn't shown with it (an older page holds it): what came of it, and which tool where it says.
    const outcome = resultOutcome(entry);
    const shown = besideImages(entry, sees);
    const tool = entry.toolResult?.tool;
    const took = entry.durationMs !== undefined ? formatDuration(entry.durationMs) : "";
    return { kind: "tools", tools: [{
      key: entry.id, icon: outcome.failed ? "alert" : tool ? toolIcon(tool) : "file", failed: outcome.failed, input: "",
      label: `${tool ?? "Output"}${outcome.text ? ` · ${outcome.text}` : ""}`, meta: [took, other].filter(Boolean).join(" · "),
      output: resultOutput(entry, shown.text), ...(shown.images ? { imageEntry: entry } : {}), ...(entry.trimmed ? { trimmed: entry.trimmed } : {}),
    }] };
  }
  if (entry.role === "system") {
    return { kind: "tools", tools: [{
      key: entry.id, icon: "info", failed: false, input: entry.text, meta: other,
      label: `System${entry.text.trim() ? ` · ${entry.text.trim().split("\n")[0]}` : ""}`,
    }] };
  }
  const { prose, calls } = entry.role === "assistant" ? splitToolCalls(entry.text) : { prose: entry.text, calls: [] };
  if (calls.length && !prose.trim()) return { kind: "tools", tools: callItems(entry, results, other, sees) };
  if (entry.error) {
    return entry.error.compaction
      ? { kind: "error", title: COMPACTION_FAILED_TITLE, text: compactionFailureText(entry.error.compaction, { advice: !shared }), by: actor }
      : { kind: "error", title: "Model request failed", text: modelFailure(entry.error, { advice: !shared }), by: actor };
  }
  const images = shownImages(entry, sees).length;
  const text = images ? textBesideImages(entry.text, images) : entry.text;
  if (entry.role === "user") return { kind: "user", text, meta: actor && entry.actorId !== userId ? actor : "" };
  const took = entry.durationMs !== undefined && entry.durationMs >= 1000 ? formatDuration(entry.durationMs) : "";
  return {
    kind: "assistant", prose: images ? splitToolCalls(text).prose : prose, tools: calls.length ? callItems(entry, results, "", sees) : [],
    meta: [other ? `by ${other}` : "", took].filter(Boolean).join(" · "),
  };
}

/** Text as it is, in the transcript's code style, to select and copy. */
function CodeBlock(props: { text: string }) {
  return (
    <View selectable style={{ borderRadius: radius.medium, backgroundColor: palette().code, padding: 12 }}>
      <Text style={{ fontFamily: monospace, fontSize: text.small, lineHeight: 20, color: palette().text }}>{props.text}</Text>
    </View>
  );
}

/**
 * One quiet line for a tool call and what came of it, a result or a system note (the web's .entry-tool): its icon, what
 * it did and its outcome, muted, or in the danger tone where it failed, and a chevron that turns as pressing it shows
 * what it was asked and what came of it.
 */
function ToolRow(props: { item: ToolItem; open: boolean; onToggle: () => void; images?: JSX.Element }) {
  const tone = () => (props.item.failed ? palette().tones.danger.text : palette().muted);
  const line = () => `${props.item.label}${props.item.meta ? ` · ${props.item.meta}` : ""}`;
  return (
    <View style={{ gap: 8 }}>
      <BaseButton accessibilityLabel={props.item.failed ? `${line()} (failed)` : line()} onPress={props.onToggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 2, paddingRight: 8, borderRadius: radius.small }}
        activeStyle={{ opacity: 0.7 }}>
        <Icon name={props.item.icon} size={14} color={tone()} />
        <Text style={{ flexShrink: 1, numberOfLines: 1, fontSize: text.small, color: tone() }}>{line()}</Text>
        <Icon name={props.open ? "chevron-down" : "chevron-right"} size={14} color={palette().muted} />
      </BaseButton>
      <If when={props.open}>
        <If when={props.item.input || (props.item.output === undefined && !props.images)}>
          <CodeBlock text={props.item.input} />
        </If>
        <If when={props.item.output !== undefined && (props.item.output || !props.images)}>
          <View style={{ gap: 4 }}>
            <If when={props.item.input}>
              <Text style={{ fontSize: text.caption, color: tone() }}>{props.item.failed ? "Failed" : "Result"}</Text>
            </If>
            <CodeBlock text={props.item.output ?? ""} />
          </View>
        </If>
        {props.images}
        <If when={props.item.trimmed}>
          {trimmed => (
            <Text style={{ fontSize: text.caption, color: palette().muted }}>
              {`Brief tool output · ${trimmed().lines === 1 ? "1 line" : `${trimmed().lines} lines`}, ${trimmed().chars} characters in full. The session's owner can show full tool output in the session's details.`}
            </Text>
          )}
        </If>
      </If>
    </View>
  );
}

/** One of a message's actions, where its viewer may take it now. */
export type MessageAction = { label: string; run: () => void; disabled?: boolean };
/**
 * A message's actions besides copying it, which every message with text offers: going back to it and forking a new
 * session from it, where the viewer may (see messageCut). Read in a binding, as rows are recycled.
 */
export type MessageActions = (entry: EntryView) => { revert?: MessageAction; fork?: MessageAction };

/** Whether a pointer is how the person points (desktops, browsers), rather than a finger. */
const pointer = platform.desktop || platform.os === "web";

/**
 * A small icon button of a message's footer, its label the tooltip on the desktop and what screen readers say: quiet
 * beside the message where a pointer brings each up; at full strength on touch screens, with room for a finger.
 */
function ActionButton(props: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  const size = pointer ? 24 : 32;
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} hitSlop={pointer ? 4 : 8} disabled={props.disabled} onPress={props.onPress}
      tooltip={<Tooltip style={{ backgroundColor: palette().primary, borderRadius: radius.small, paddingHorizontal: 8, paddingVertical: 4 }}>
        <Text style={{ fontSize: text.caption, color: palette().onPrimary }}>{props.label}</Text>
      </Tooltip>}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center", borderRadius: radius.small, opacity: pointer ? 0.55 : 1 }}
      hoverStyle={{ backgroundColor: palette().hover, opacity: 1 }} activeStyle={{ opacity: 0.5 }} disabledStyle={{ opacity: 0.3 }}>
      <Icon name={props.icon} size={14} color={palette().muted} />
    </BaseButton>
  );
}

/** Who sent a message and how long it took, then its actions as small icons: copy, go back, fork. */
function Footer(props: { entry: EntryView; meta: string; actions?: MessageActions; onCopy?: (entry: EntryView) => Promise<void>; end?: boolean }) {
  const copyable = () => Boolean(props.onCopy) && copyText(props.entry) !== "";
  const offered = computed((): ReturnType<MessageActions> => (props.actions ? props.actions(props.entry) : {}));
  // The copy icon turns to a check for a moment once the message is copied; by entry id, as rows are recycled.
  const copied = signal<string | null>(null);
  effect(() => {
    if (!copied()) return;
    const timer = setTimeout(() => copied.set(null), 1500);
    return () => clearTimeout(timer);
  });
  const justCopied = () => copied() === props.entry.id;
  // Test IDs name the entry: `message-copy-0-12` for entry `0:12`.
  const testID = (action: string) => `message-${action}-${props.entry.id.replace(/[^\w-]/g, "-")}`;
  function copy() {
    const id = props.entry.id;
    void props.onCopy?.(props.entry).then(() => copied.set(id), () => {});
  }
  return (
    <If when={props.meta || copyable() || offered().revert || offered().fork}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: pointer ? 2 : 4, justifyContent: props.end ? "flex-end" : "flex-start" }}>
        <If when={props.meta}>
          <Text style={{ fontSize: text.caption, color: palette().muted, marginRight: 4 }}>{props.meta}</Text>
        </If>
        <If when={copyable()}>
          <ActionButton testID={testID("copy")} icon={justCopied() ? "check" : "copy"} label={justCopied() ? "Copied" : "Copy message"} onPress={copy} />
        </If>
        <If when={offered().revert}>
          {revert => <ActionButton testID={testID("revert")} icon="history" label={revert().label} disabled={revert().disabled} onPress={() => revert().run()} />}
        </If>
        <If when={offered().fork}>
          {fork => <ActionButton testID={testID("fork")} icon="branch" label={fork().label} disabled={fork().disabled} onPress={() => fork().run()} />}
        </If>
      </View>
    </If>
  );
}

/**
 * User messages are bubbles; assistant text is Markdown, shown by NSH's native TextView; each tool call is one quiet
 * line with the result that answered it (`results`, from pairToolResults), as are results whose call isn't shown and
 * system entries. List rows are recycled, so `entry` changes under a row: everything here reads it in bindings, and
 * what is expanded is kept outside the row, by entry id, or by `<entry id>#<call>` for a call's row.
 */
export function TranscriptEntry(props: {
  entry: EntryView; userId: string; expanded: (id: string) => boolean; toggle: (id: string) => void; shared?: boolean;
  /** Copies a message: without it, messages show no copy icon. It rejects when the message wasn't copied. */
  onCopy?: (entry: EntryView) => Promise<void>;
  /** Going back to a message and forking from it, where offered. */
  actions?: MessageActions;
  /** The session whose transcript images this person sees (seesEntryImages): shown as thumbnails in place of their lines. */
  imagesOf?: string;
  /** The results of this entry's tool calls, in call order, shown with them (pairToolResults). */
  results?: readonly (EntryView | undefined)[];
}) {
  const name = createUsername();
  const images = () => shownImages(props.entry, props.imagesOf !== undefined);
  const shown = computed(() => describe(props.entry, props.userId, name, props.shared, props.imagesOf !== undefined, props.results));
  const thumbnails = (end?: boolean) => (
    <If when={images().length > 0 ? props.imagesOf : undefined}>
      {sessionId => <EntryImages sessionId={sessionId()} entryId={props.entry.id} images={images()} end={end} />}
    </If>
  );
  /** The thumbnails under a tool row's output: its result's images. */
  const resultThumbnails = (item: ToolItem) => {
    const entry = item.imageEntry;
    const sessionId = props.imagesOf;
    return entry && sessionId !== undefined ? <EntryImages sessionId={sessionId} entryId={entry.id} images={shownImages(entry, true)} /> : undefined;
  };
  const tools = () => {
    const value = shown();
    return value.kind === "tools" || value.kind === "assistant" ? value.tools : [];
  };
  const toolRows = () => (
    <Each of={tools()} key={item => item.key}>
      {item => <ToolRow item={item()} open={props.expanded(item().key)} onToggle={() => props.toggle(item().key)} images={resultThumbnails(item())} />}
    </Each>
  );
  // Every entry sits 16 points from the next, as the web app's transcript spaces them; consecutive tool lines closer.
  const gapAfter = () => (shown().kind === "tools" ? 8 : 16);
  return (
    <View style={{ gap: 6, paddingBottom: gapAfter() }}>
      <If when={shown().kind === "stopped" ? shown() as Extract<Shown, { kind: "stopped" }> : null}>
        {stopped => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: palette().border }} />
            <Text style={{ flexShrink: 1, textAlign: "center", fontSize: text.caption, color: palette().muted }}>{stopped().text}</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: palette().border }} />
          </View>
        )}
      </If>
      <If when={shown().kind === "tools"}>
        <View style={{ gap: 8 }}>{toolRows()}</View>
      </If>
      <If when={shown().kind === "error" ? shown() as Extract<Shown, { kind: "error" }> : null}>
        {error => (
          <>
            <Banner tone="danger" title={error().title}>{error().text}</Banner>
            <If when={error().by}>
              <Text style={{ fontSize: text.caption, color: palette().muted }}>by {error().by}</Text>
            </If>
          </>
        )}
      </If>
      <If when={shown().kind === "user" ? shown() as Extract<Shown, { kind: "user" }> : null}>
        {user => (
          <View style={{ alignItems: "flex-end", gap: 4 }}>
            <If when={user().meta}>
              <Text style={{ fontSize: text.caption, color: palette().muted, paddingHorizontal: 4 }}>{`by ${user().meta}`}</Text>
            </If>
            <If when={user().text || !images().length}>
              <View selectable style={{ borderRadius: radius.large, paddingHorizontal: 12, paddingVertical: 8, maxWidth: "85%", backgroundColor: palette().userBubble }}>
                <Text style={{ fontSize: text.reading, lineHeight: 23, color: palette().onUserBubble }}>{user().text}</Text>
              </View>
            </If>
            {thumbnails(true)}
            <Footer entry={props.entry} meta="" onCopy={props.onCopy} actions={props.actions} end />
          </View>
        )}
      </If>
      <If when={shown().kind === "assistant" ? shown() as Extract<Shown, { kind: "assistant" }> : null}>
        {assistant => (
          <>
            <If when={assistant().prose.trim()}>
              {/* TextView only reports a link's press; opening it is the app's. */}
              <TextView markdown={assistant().prose} selectable options={{ streaming: true }} onLinkPress={event => openMessageLink(event.url)} />
            </If>
            <If when={assistant().tools.length}>
              <View style={{ gap: 8 }}>{toolRows()}</View>
            </If>
            <Footer entry={props.entry} meta={assistant().meta} onCopy={props.onCopy} actions={props.actions} />
          </>
        )}
      </If>
    </View>
  );
}
