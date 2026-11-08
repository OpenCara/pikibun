import { computed, platform, Text, View } from "nsh";
import { Button as BaseButton, TextView } from "nsh/base";
import { COMPACTION_FAILED_TITLE, compactionFailureText, copyText, splitToolCalls, type EntryView } from "../shared";
import { formatDuration, modelFailure } from "../lib/format";
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

/** What an entry shows, as the Expo app's TranscriptEntry decided it. */
function describe(entry: EntryView, userId: string, name: (id: string, you?: boolean) => string): Shown {
  const actor = entry.actorId ? name(entry.actorId, true) : "";
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
      ? { kind: "error", title: COMPACTION_FAILED_TITLE, text: compactionFailureText(entry.error.compaction), by: actor }
      : { kind: "error", title: "Model request failed", text: modelFailure(entry.error), by: actor };
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
function ToolRow(props: { icon: IconName; name: string; summary: string; meta: string; text: string; trimmed?: EntryView["trimmed"]; open: boolean; onToggle: () => void; result?: boolean }) {
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
        <View selectable style={{ borderRadius: radius.medium, backgroundColor: palette().code, padding: 12 }}>
          <Text style={{ fontFamily: monospace, fontSize: text.small, lineHeight: 20, color: palette().text }}>{props.text}</Text>
        </View>
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

/** Who sent a message and how long it took, then the button that opens its actions (copy, go back, fork). */
function Footer(props: { entry: EntryView; meta: string; onActions?: (entry: EntryView) => void; end?: boolean }) {
  const actions = () => Boolean(props.onActions) && copyText(props.entry) !== "";
  return (
    <If when={props.meta || actions()}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, justifyContent: props.end ? "flex-end" : "flex-start" }}>
        <If when={props.meta}>
          <Text style={{ fontSize: text.caption, color: palette().muted }}>{props.meta}</Text>
        </If>
        <If when={actions()}>
          <BaseButton accessibilityLabel="Message actions" hitSlop={10} onPress={() => props.onActions?.(props.entry)}
            style={{ width: 28, height: 24, alignItems: "center", justifyContent: "center", borderRadius: radius.small, opacity: platform.desktop || platform.os === "web" ? 0.55 : 1 }}
            hoverStyle={{ backgroundColor: palette().hover, opacity: 1 }} activeStyle={{ opacity: 0.5 }}>
            <Icon name="more" size={14} color={palette().muted} />
          </BaseButton>
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
export function TranscriptEntry(props: { entry: EntryView; userId: string; expanded: (id: string) => boolean; toggle: (id: string) => void; onActions?: (entry: EntryView) => void }) {
  const name = createUsername();
  const shown = computed(() => describe(props.entry, props.userId, name));
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
        {tool => <ToolRow icon={tool().icon} name={tool().name} summary={tool().summary} meta={tool().meta} text={tool().text} trimmed={tool().trimmed} result={tool().result} open={open()} onToggle={toggle} />}
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
            <View selectable style={{ borderRadius: radius.large, paddingHorizontal: 12, paddingVertical: 8, maxWidth: "85%", backgroundColor: palette().userBubble }}>
              <Text style={{ fontSize: text.reading, lineHeight: 23, color: palette().onUserBubble }}>{user().text}</Text>
            </View>
            <Footer entry={props.entry} meta="" onActions={props.onActions} end />
          </View>
        )}
      </If>
      <If when={shown().kind === "assistant" ? shown() as Extract<Shown, { kind: "assistant" }> : null}>
        {assistant => (
          <>
            <If when={assistant().prose.trim()}>
              <TextView markdown={assistant().prose} selectable options={{ streaming: true }} />
            </If>
            <If when={assistant().tool}>
              {tool => <ToolRow icon={tool().icon} name={tool().name} summary={tool().summary} meta={tool().meta} text={tool().text} trimmed={props.entry.trimmed} open={open()} onToggle={toggle} />}
            </If>
            <Footer entry={props.entry} meta={assistant().meta} onActions={props.onActions} />
          </>
        )}
      </If>
    </View>
  );
}
