import { computed, Text, View } from "nsh";
import { Button as BaseButton, TextView } from "nsh/base";
import { COMPACTION_FAILED_TITLE, compactionFailureText, copyText, splitToolCalls, type EntryView } from "../shared";
import { formatDuration, modelFailure } from "../lib/format";
import { createUsername } from "../lib/people";
import { monospace, palette } from "../theme";
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

type Shown =
  | { kind: "stopped"; text: string }
  | { kind: "tool"; label: string; text: string; trimmed?: EntryView["trimmed"] }
  | { kind: "error"; title: string; text: string; by: string }
  | { kind: "user"; text: string; meta: string }
  | { kind: "assistant"; prose: string; tool: { label: string; text: string } | null; meta: string };

/** What an entry shows, as the Expo app's TranscriptEntry decides it. */
function describe(entry: EntryView, userId: string, name: (id: string, you?: boolean) => string): Shown {
  const actor = entry.actorId ? name(entry.actorId, true) : "";
  const { prose, calls } = entry.role === "assistant" ? splitToolCalls(entry.text) : { prose: entry.text, calls: [] };
  const toolLabel = calls.length > 0 ? `Tool · ${calls[0]!.name}` : "";
  const marks = autoApprovedSuffix(entry.autoApproved);
  if (entry.kind === "workspace.run-stopped" || entry.kind === "workspace.run-crashed" || entry.kind === "workspace.run-refused") {
    return { kind: "stopped", text: entry.kind === "workspace.run-stopped" ? `Stopped${actor ? ` by ${actor}` : ""}` : entry.text };
  }
  if ((toolLabel && !prose.trim()) || entry.role === "system" || entry.role === "toolResult") {
    const label = toolLabel || (entry.role === "toolResult" ? "Tool result" : "System");
    // A tool call row would show the model's time, not the tool's, so only results carry a duration.
    const took = entry.role === "toolResult" && entry.durationMs !== undefined ? ` · ${formatDuration(entry.durationMs)}` : "";
    const line = entry.trimmed && entry.role === "toolResult" && entry.text.trim() ? ` · ${entry.text}` : "";
    return { kind: "tool", label: `${label}${took}${actor ? ` · ${actor}` : ""}${marks}${line}`, text: entry.text, trimmed: entry.trimmed };
  }
  if (entry.error) {
    return entry.error.compaction
      ? { kind: "error", title: COMPACTION_FAILED_TITLE, text: compactionFailureText(entry.error.compaction), by: actor }
      : { kind: "error", title: "Model request failed", text: modelFailure(entry.error), by: actor };
  }
  if (entry.role === "user") return { kind: "user", text: entry.text, meta: actor && entry.actorId !== userId ? `by ${actor}` : "" };
  const took = entry.durationMs !== undefined ? formatDuration(entry.durationMs) : "";
  return {
    kind: "assistant", prose,
    tool: toolLabel ? { label: `${toolLabel}${marks}`, text: calls.map(call => call.line).join("\n") } : null,
    meta: [actor && `by ${actor}`, took].filter(Boolean).join(" · "),
  };
}

/** One collapsed row for tool calls, tool results and system entries; expanding it shows the raw text. */
function ToolDetails(props: { label: string; text: string; trimmed?: EntryView["trimmed"]; open: boolean; onToggle: () => void }) {
  return (
    <View style={{ borderRadius: 10, borderWidth: 1, overflow: "hidden", borderColor: palette().border, backgroundColor: palette().surface }}>
      <BaseButton accessibilityLabel={props.label} onPress={props.onToggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 }} activeStyle={{ opacity: 0.6 }}>
        <Text style={{ fontSize: 13, color: palette().muted }}>⚙</Text>
        <Text style={{ flex: 1, numberOfLines: 2, fontSize: 13, color: palette().muted }}>{props.label}</Text>
        <Text style={{ fontSize: 13, color: palette().muted }}>{props.open ? "▾" : "▸"}</Text>
      </BaseButton>
      <If when={props.open}>
        <View selectable style={{ borderTopWidth: 1, borderColor: palette().border, padding: 10 }}>
          <Text style={{ fontFamily: monospace, fontSize: 12, lineHeight: 17, color: palette().text }}>{props.text}</Text>
        </View>
        <If when={props.trimmed}>
          {trimmed => (
            <Text style={{ fontSize: 12, padding: 10, color: palette().muted }}>
              {`Brief tool output · ${trimmed().lines === 1 ? "1 line" : `${trimmed().lines} lines`}, ${trimmed().chars} characters in full. The session's owner can show full tool output in the web app's session details.`}
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, justifyContent: props.end ? "flex-end" : "flex-start" }}>
        <If when={props.meta}>
          <Text style={{ fontSize: 12, color: palette().muted }}>{props.meta}</Text>
        </If>
        <If when={actions()}>
          <BaseButton accessibilityLabel="Message actions" hitSlop={10} onPress={() => props.onActions?.(props.entry)} activeStyle={{ opacity: 0.5 }}>
            <Text style={{ fontSize: 16, color: palette().muted }}>⋯</Text>
          </BaseButton>
        </If>
      </View>
    </If>
  );
}

/**
 * User messages are plain-text bubbles; assistant text is Markdown, shown by NSH's native TextView; tool calls, results
 * and system entries collapse to one row. List rows are recycled, so `entry` changes under a row: everything here reads
 * it in bindings, and what is expanded is kept by entry id outside the row.
 */
export function TranscriptEntry(props: { entry: EntryView; userId: string; expanded: (id: string) => boolean; toggle: (id: string) => void; onActions?: (entry: EntryView) => void }) {
  const name = createUsername();
  const shown = computed(() => describe(props.entry, props.userId, name));
  const open = () => props.expanded(props.entry.id);
  return (
    <View style={{ gap: 6, paddingBottom: 14 }}>
      <If when={shown().kind === "stopped" ? shown() as Extract<Shown, { kind: "stopped" }> : null}>
        {stopped => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: palette().border }} />
            <Text style={{ flexShrink: 1, textAlign: "center", fontSize: 12, color: palette().muted }}>{stopped().text}</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: palette().border }} />
          </View>
        )}
      </If>
      <If when={shown().kind === "tool" ? shown() as Extract<Shown, { kind: "tool" }> : null}>
        {tool => <ToolDetails label={tool().label} text={tool().text} trimmed={tool().trimmed} open={open()} onToggle={() => props.toggle(props.entry.id)} />}
      </If>
      <If when={shown().kind === "error" ? shown() as Extract<Shown, { kind: "error" }> : null}>
        {error => (
          <>
            <Banner tone="danger" title={error().title}>{error().text}</Banner>
            <If when={error().by}>
              <Text style={{ fontSize: 12, color: palette().muted }}>by {error().by}</Text>
            </If>
          </>
        )}
      </If>
      <If when={shown().kind === "user" ? shown() as Extract<Shown, { kind: "user" }> : null}>
        {user => (
          <View style={{ alignItems: "flex-end", gap: 6 }}>
            <View selectable style={{ borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "88%", backgroundColor: palette().userBubble }}>
              <Text style={{ fontSize: 16, lineHeight: 22, color: palette().onUserBubble }}>{user().text}</Text>
            </View>
            <Footer entry={props.entry} meta={user().meta} onActions={props.onActions} end />
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
              {tool => <ToolDetails label={tool().label} text={tool().text} trimmed={props.entry.trimmed} open={open()} onToggle={() => props.toggle(props.entry.id)} />}
            </If>
            <Footer entry={props.entry} meta={assistant().meta} onActions={props.onActions} />
          </>
        )}
      </If>
    </View>
  );
}
