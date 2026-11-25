import { computed, effect, keymap, platform, Scroll, signal, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import type { SlashSuggestion } from "../shared";
import type { Attachments } from "../lib/attachments";
import { Icon } from "../icons";
import { control, monospace, palette, radius, text } from "../theme";
import { phoneWidth, Small } from "../ui";
import { AttachButton, AttachmentStrip } from "./Attachments";

const MAX_TEXT_HEIGHT = 220;
const MAX_SUGGESTIONS = 8;

export function Composer(props: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; onStop?: () => void; stopping?: boolean; busy: boolean; disabled?: boolean;
  placeholder: string; sendLabel: string; hint: string; tools?: JSX.Element; minHeight?: number; testID?: string; sendTestID?: string;
  ready?: boolean;
  sendText?: string;
  attachments?: Attachments;
  onRecall?: () => void;
  phoneHint?: string;
  suggestions?: (draft: string) => SlashSuggestion[];
}) {
  let input: InputRef | undefined;
  let caret: number | undefined;
  const focused = signal(false);
  const dragging = signal(false);
  const accepting = () => Boolean(props.attachments && !props.disabled && !props.busy);
  const attachLocal = (uris: readonly string[]) => { if (accepting() && uris.length) void props.attachments!.attachLocal(uris); };
  const canSend = () => !props.disabled && !props.busy && (props.ready ?? (props.value.trim() !== "" || (props.attachments?.count() ?? 0) > 0));
  const suggestions = computed(() => (props.suggestions && !props.disabled && !props.busy ? props.suggestions(props.value) : []));
  const closedAt = signal<string | null>(null);
  const suggesting = computed(() => suggestions().length > 0 && closedAt() !== props.value);
  const picked = signal(0);
  const pick = () => Math.min(picked(), suggestions().length - 1);
  const firstShown = () => Math.max(0, Math.min(pick() - Math.floor(MAX_SUGGESTIONS / 2), suggestions().length - MAX_SUGGESTIONS));
  const shown = () => suggestions().slice(firstShown(), firstShown() + MAX_SUGGESTIONS);
  const move = (by: number) => picked.set((untracked(pick) + by + untracked(suggestions).length) % untracked(suggestions).length);
  function complete(item: SlashSuggestion | undefined) {
    if (!item) return;
    if (item.draft !== untracked(() => props.value)) {
      caret = item.draft.length;
      props.onChange(item.draft);
    }
    input?.focus();
  }
  function choose(item: SlashSuggestion) {
    complete(item);
    if (item.runs) props.onSubmit();
  }
  const submit = () => {
    const item = suggesting() ? suggestions()[pick()] : undefined;
    if (item && item.draft !== props.value) choose(item);
    else if (canSend()) props.onSubmit();
  };
  const draft = () => props.value;
  effect(() => {
    if (untracked(closedAt) !== draft()) closedAt.set(null);
    picked.set(0);
    if (caret === undefined) return;
    input?.setSelection(caret);
    caret = undefined;
  });
  effect(() => {
    if (!suggesting() || !focused()) return;
    try {
      return keymap.bind({
        up: () => move(-1),
        down: () => move(1),
        tab: () => complete(untracked(suggestions)[untracked(pick)]),
        escape: () => closedAt.set(untracked(() => props.value)),
      }, { when: "always", repeat: true });
    } catch {
      return undefined;
    }
  });
  const narrow = phoneWidth;
  const hint = () => (narrow() ? props.phoneHint ?? props.hint : props.hint);
  const hasTools = () => Boolean(props.tools || (props.attachments && !props.disabled));
  const hintBelow = () => narrow() && hasTools();
  const inlineHint = () => (hintBelow() ? "" : hint());
  const tools = () => (
    <>
      <If when={props.attachments && !props.disabled ? props.attachments : null}>
        {attachments => <AttachButton attachments={attachments()} disabled={props.busy} />}
      </If>
      {props.tools}
    </>
  );
  effect(() => {
    const recall = props.onRecall;
    if (!recall || !focused() || props.value || props.disabled || props.busy || (props.attachments?.count() ?? 0) > 0) return;
    try {
      return keymap.bind("up", () => recall(), { when: "always" });
    } catch {
      return undefined;
    }
  });
  return (
    <View testID="composer" style={{ gap: narrow() ? 6 : 8, padding: narrow() ? 8 : 12, paddingLeft: narrow() ? 10 : 12, borderWidth: 1, borderRadius: radius.large,
      borderColor: dragging() ? palette().accent : focused() ? palette().borderStrong : palette().border, backgroundColor: palette().surface }}
      onFileDragEnter={() => dragging.set(accepting())} onFileDragLeave={() => dragging.set(false)}
      onFileDrop={event => {
        dragging.set(false);
        if (event.uris.length) attachLocal(event.uris);
        else if (accepting() && event.files.length) props.attachments!.attachDropped(event.files);
      }}>
      <If when={props.attachments}>{attachments => <AttachmentStrip attachments={attachments()} disabled={props.busy || props.disabled} />}</If>
      <If when={suggesting()}>
        <View testID="composer-suggestions" style={{ paddingBottom: 6, borderBottomWidth: 1, borderColor: palette().border }}>
          <Each of={shown()} key={item => item.key}>
            {item => (
              <BaseButton role="menuitem" testID={`composer-suggestion-${item().key}`} accessibilityLabel={`${item().label}: ${item().hint}`}
                selected={item().key === suggestions()[pick()]?.key} onPress={() => choose(item())}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: narrow() ? control.medium : control.xsmall, paddingHorizontal: 8,
                  borderRadius: radius.small, backgroundColor: item().key === suggestions()[pick()]?.key ? palette().hoverStrong : "transparent" }}
                hoverStyle={{ backgroundColor: palette().hoverStrong }} activeStyle={{ opacity: 0.8 }}>
                <Text style={{ flexShrink: 0, maxWidth: "60%", numberOfLines: 1, fontSize: text.small, fontFamily: item().label.startsWith("/") ? monospace : undefined,
                  color: palette().text }}>{item().label}</Text>
                <Text style={{ flex: 1, minWidth: 0, numberOfLines: 1, fontSize: text.small, color: palette().muted }}>{item().hint}</Text>
              </BaseButton>
            )}
          </Each>
          <If when={suggestions().length > MAX_SUGGESTIONS || platform.desktop}>
            <Text testID="composer-suggestions-hint" style={{ paddingHorizontal: 8, paddingTop: 4, fontSize: text.caption, color: palette().muted }}>
              {[suggestions().length > MAX_SUGGESTIONS ? `${firstShown() + 1}–${firstShown() + shown().length} of ${suggestions().length}` : "",
                platform.desktop ? "↑ ↓ to move · Enter to choose · Tab to complete · Esc to close" : ""].filter(Boolean).join(" · ")}
            </Text>
          </If>
        </View>
      </If>
      <View style={{ maxHeight: MAX_TEXT_HEIGHT }}>
        <Input ref={ref => { input = ref; }} testID={props.testID ?? "composer-input"} value={props.value} onChange={event => props.onChange(event.value)} multiline readonly={props.busy || props.disabled}
          placeholder={props.placeholder} accessibilityLabel={props.placeholder}
          submitBehavior={platform.desktop ? "submit" : "newline"} onSubmit={submit}
          pasteMaxSize={props.attachments?.pasteLimit()}
          onPaste={event => {
            if (!accepting()) return;
            if (event.uris.length) attachLocal(event.uris);
            else if (event.files.length || event.tooLarge.length) props.attachments!.attachPasted(event.files, event.tooLarge);
          }}
          onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
          style={{ fontSize: text.reading, lineHeight: 22, minHeight: props.minHeight ?? 24, maxHeight: MAX_TEXT_HEIGHT, paddingHorizontal: 4, paddingVertical: 0,
            color: palette().text, placeholderColor: palette().muted }} />
      </View>
      <If when={props.attachments?.notice()}>{notice => <Small testID="composer-notice" tone="warning">{notice()}</Small>}</If>
      <View testID="composer-controls" style={{ flexDirection: "row", flexWrap: narrow() ? "nowrap" : "wrap", alignItems: "center", rowGap: 4, columnGap: narrow() ? 4 : 8 }}>
        <If when={hasTools()}>
          <If when={narrow()}
            else={
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, flexShrink: 1, ...(inlineHint() ? {} : { flexGrow: 1, flexBasis: 0, minWidth: 0 }) }}>
                {tools()}
              </View>
            }>
            <Scroll testID="composer-tools" horizontal scrollbar={false} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}
              contentStyle={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              {tools()}
            </Scroll>
          </If>
        </If>
        <If when={inlineHint()}>
          <Text testID="composer-hint" style={{ flexGrow: 1, flexShrink: 1, flexBasis: narrow() ? 0 : 160, minWidth: 0, fontSize: text.caption, color: palette().muted }}>{inlineHint()}</Text>
        </If>
        <View style={{ flexDirection: "row", gap: 4, marginLeft: "auto", alignSelf: "flex-end", flexShrink: 0 }}>
          <If when={props.onStop}>
            <BaseButton testID="composer-stop" accessibilityLabel={props.stopping ? "Stopping..." : "Stop"} disabled={props.stopping} onPress={() => props.onStop?.()}
              style={{ width: control.small, height: control.small, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: palette().borderStrong }}
              hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.8 }} disabledStyle={{ opacity: 0.5 }}>
              <Icon name="stop" size={16} color={palette().text} />
            </BaseButton>
          </If>
          <BaseButton testID={props.sendTestID ?? "composer-send"} accessibilityLabel={props.busy ? "Sending..." : props.sendLabel} disabled={!canSend()} onPress={props.onSubmit}
            style={{ flexDirection: "row", gap: 8, minWidth: control.small, height: control.small, borderRadius: radius.pill, paddingHorizontal: props.sendText ? 12 : 0,
              alignItems: "center", justifyContent: "center", backgroundColor: palette().accent }}
            hoverStyle={{ backgroundColor: palette().accentHover }} activeStyle={{ opacity: 0.8 }} disabledStyle={{ opacity: 0.5 }}>
            <If when={props.sendText}>
              {label => <Text style={{ fontSize: text.body, color: palette().onAccent }}>{props.busy ? `${label()}…` : label()}</Text>}
            </If>
            <Icon name="arrow-up" size={16} color={palette().onAccent} />
          </BaseButton>
        </View>
      </View>
      <If when={hintBelow() ? hint() : ""}>
        {below => <Text testID="composer-hint" style={{ fontSize: text.caption, lineHeight: 17, color: palette().muted, paddingHorizontal: 4 }}>{below()}</Text>}
      </If>
    </View>
  );
}
