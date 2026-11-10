import { computed, effect, platform, signal, Text, View, type JSX } from "nsh";
import { Button as BaseButton, TextView, Tooltip } from "nsh/base";
import { COMPACTION_FAILED_TITLE, compactionFailureText, copyText, shownImages, splitToolCalls, textBesideImages, type EntryView } from "../shared";
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
  browser: "globe", git: "branch", git_commit: "branch", git_push: "branch", git_repin: "branch",
  github_comment: "pull-request", github_merge: "pull-request", github_issue: "pull-request", github_read: "pull-request",
  schedule: "clock", sessions: "list", tunnel: "link",
};
const toolIcon = (name: string): IconName => toolIcons[name] ?? "terminal";

/** What a tool call works on, from its JSON arguments: the command, path or address it names, on one line. */
function callSummary(line: string): string {
  const open = line.indexOf("(");
  try {
    const args = JSON.parse(line.slice(open + 1, -1)) as Record<string, unknown>;
    // Program tools (node, git, python…): the program and its arguments, as the command line they make.
    if (typeof args.program === "string" && Array.isArray(args.args)) {
      return [args.program, ...args.args.map(arg => (/^[\w./:=@%+-]+$/.test(String(arg)) ? String(arg) : JSON.stringify(String(arg))))].join(" ").replace(/\s+/g, " ");
    }
    for (const key of ["command", "cmd", "path", "file", "url", "query", "pattern", "action", "repository"]) {
      if (typeof args[key] === "string" && args[key]) return (args[key] as string).replace(/\s+/g, " ").trim();
    }
    const first = Object.values(args).find(value => typeof value === "string" && value);
    return typeof first === "string" ? first.replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

type Shown =
  | { kind: "stopped"; text: string }
  | { kind: "tool"; icon: IconName; name: string; summary: string; meta: string; text: string; trimmed?: EntryView["trimmed"]; result: boolean }
  | { kind: "error"; title: string; text: string; by: string }
  | { kind: "user"; text: string; meta: string }
  | { kind: "assistant"; prose: string; tool: { icon: IconName; name: string; summary: string; meta: string; text: string } | null; meta: string };

/**
 * What an entry shows, as the Expo app's TranscriptEntry decided it. `shared`: a share link's, whose readers get no advice.
 * `images`: how many of its images show as thumbnails, whose `[image <type>]` lines don't.
 */
function describe(entry: EntryView, userId: string, name: (id: string, you?: boolean) => string, shared = false, images = 0): Shown {
  const actor = entry.actorId ? name(entry.actorId, true) : "";
  if (images) entry = { ...entry, text: textBesideImages(entry.text, images) };
  const { prose, calls } = entry.role === "assistant" ? splitToolCalls(entry.text) : { prose: entry.text, calls: [] };
  const marks = autoApprovedSuffix(entry.autoApproved);
  const callName = calls.length > 1 ? `${calls[0]!.name} +${calls.length - 1}` : calls[0]?.name ?? "";
  if (entry.kind === "workspace.run-stopped" || entry.kind === "workspace.run-crashed" || entry.kind === "workspace.run-refused") {
    return { kind: "stopped", text: entry.kind === "workspace.run-stopped" ? `Stopped${actor ? ` by ${actor}` : ""}` : entry.text };
  }
  if ((calls.length && !prose.trim()) || entry.role === "system" || entry.role === "toolResult") {
    const result = entry.role === "toolResult";
    // A tool call row would show the model's time, not the tool's, so only results carry a duration.
    const took = result && entry.durationMs !== undefined ? formatDuration(entry.durationMs) : "";
    const firstLine = entry.text.trim().split("\n")[0] ?? "";
    return {
      kind: "tool", result, trimmed: entry.trimmed, text: calls.length ? calls.map(call => call.line).join("\n") : entry.text,
      icon: calls.length ? toolIcon(calls[0]!.name) : result ? "file" : "info",
      name: calls.length ? callName : result ? "Output" : "System",
      summary: calls.length ? callSummary(calls[0]!.line) : firstLine,
      meta: [took, actor && actor !== "you" ? actor : ""].filter(Boolean).join(" · ") + marks,
    };
  }
  if (entry.error) {
    return entry.error.compaction
      ? { kind: "error", title: COMPACTION_FAILED_TITLE, text: compactionFailureText(entry.error.compaction, { advice: !shared }), by: actor }
      : { kind: "error", title: entry.error.cause === "incomplete_stream" ? "Model response cut off" : "Model request failed",
        text: modelFailure(entry.error, { advice: !shared }), by: actor };
  }
  if (entry.role === "user") return { kind: "user", text: entry.text, meta: actor && entry.actorId !== userId ? actor : "" };
  const took = entry.durationMs !== undefined && entry.durationMs >= 1000 ? formatDuration(entry.durationMs) : "";
  return {
    kind: "assistant", prose,
    tool: calls.length ? { icon: toolIcon(calls[0]!.name), name: callName, summary: callSummary(calls[0]!.line), meta: marks.replace(/^ · /, ""), text: calls.map(call => call.line).join("\n") } : null,
    meta: [actor && actor !== "you" ? `by ${actor}` : "", took].filter(Boolean).join(" · "),
  };
}

/**
 * One quiet line for a tool call, its output or a system note (the web's .entry-tool): its icon, what it is and what
 * it works on, muted, and a chevron that turns as pressing it shows the exact text.
 */
function ToolRow(props: { icon: IconName; name: string; summary: string; meta: string; text: string; trimmed?: EntryView["trimmed"]; open: boolean; onToggle: () => void; result?: boolean; images?: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <BaseButton accessibilityLabel={`${props.name} ${props.summary}${props.meta ? ` · ${props.meta}` : ""}`} onPress={props.onToggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 2, paddingRight: 8, borderRadius: radius.small }}
        activeStyle={{ opacity: 0.7 }}>
        <Icon name={props.icon} size={14} color={palette().muted} />
        <Text style={{ flexShrink: 1, numberOfLines: 1, fontSize: text.small, color: palette().muted }}>
          {`${props.name}${props.summary ? ` · ${props.summary}` : ""}${props.meta ? ` · ${props.meta}` : ""}`}
        </Text>
        <Icon name={props.open ? "chevron-down" : "chevron-right"} size={14} color={palette().muted} />
      </BaseButton>
      <If when={props.open}>
        <If when={props.text || !props.images}>
          <View selectable style={{ borderRadius: radius.medium, backgroundColor: palette().code, padding: 12 }}>
            <Text style={{ fontFamily: monospace, fontSize: text.small, lineHeight: 20, color: palette().text }}>{props.text}</Text>
          </View>
        </If>
        {props.images}
        <If when={props.trimmed}>
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
 * User messages are bubbles; assistant text is Markdown, shown by NSH's native TextView; tool calls, results and system
 * entries are one quiet line each. List rows are recycled, so `entry` changes under a row: everything here reads it in
 * bindings, and what is expanded is kept by entry id outside the row.
 */
export function TranscriptEntry(props: {
  entry: EntryView; userId: string; expanded: (id: string) => boolean; toggle: (id: string) => void; shared?: boolean;
  /** Copies a message: without it, messages show no copy icon. It rejects when the message wasn't copied. */
  onCopy?: (entry: EntryView) => Promise<void>;
  /** Going back to a message and forking from it, where offered. */
  actions?: MessageActions;
  /** The session whose transcript images this person sees (seesEntryImages): shown as thumbnails in place of their lines. */
  imagesOf?: string;
}) {
  const name = createUsername();
  const images = () => shownImages(props.entry, props.imagesOf !== undefined);
  const shown = computed(() => describe(props.entry, props.userId, name, props.shared, images().length));
  const thumbnails = (end?: boolean) => (
    <If when={images().length > 0 ? props.imagesOf : undefined}>
      {sessionId => <EntryImages sessionId={sessionId()} entryId={props.entry.id} images={images()} end={end} />}
    </If>
  );
  const open = () => props.expanded(props.entry.id);
  const toggle = () => props.toggle(props.entry.id);
  // Every entry sits 16 points from the next, as the web app's transcript spaces them; consecutive tool lines closer.
  const gapAfter = () => (shown().kind === "tool" ? 8 : 16);
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
      <If when={shown().kind === "tool" ? shown() as Extract<Shown, { kind: "tool" }> : null}>
        {tool => <ToolRow icon={tool().icon} name={tool().name} summary={tool().summary} meta={tool().meta} text={tool().text} trimmed={tool().trimmed} result={tool().result} open={open()} onToggle={toggle}
          images={images().length ? thumbnails() : undefined} />}
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
            <If when={assistant().tool}>
              {tool => <ToolRow icon={tool().icon} name={tool().name} summary={tool().summary} meta={tool().meta} text={tool().text} trimmed={props.entry.trimmed} open={open()} onToggle={toggle} />}
            </If>
            <Footer entry={props.entry} meta={assistant().meta} onCopy={props.onCopy} actions={props.actions} />
          </>
        )}
      </If>
    </View>
  );
}
