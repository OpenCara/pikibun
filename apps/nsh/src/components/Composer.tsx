import { effect, keymap, platform, Scroll, signal, Text, View, type JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import type { Attachments } from "../lib/attachments";
import { Icon } from "../icons";
import { control, palette, radius, text } from "../theme";
import { phoneWidth, Small } from "../ui";
import { AttachButton, AttachmentStrip } from "./Attachments";

const MAX_TEXT_HEIGHT = 220;

export function Composer(props: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; onStop?: () => void; stopping?: boolean; busy: boolean; disabled?: boolean;
  placeholder: string; sendLabel: string; hint: string; tools?: JSX.Element; minHeight?: number; testID?: string; sendTestID?: string;
  ready?: boolean;
  sendText?: string;
  attachments?: Attachments;
  onRecall?: () => void;
}) {
  const focused = signal(false);
  const dragging = signal(false);
  const accepting = () => Boolean(props.attachments && !props.disabled && !props.busy);
  const attachLocal = (uris: readonly string[]) => { if (accepting() && uris.length) void props.attachments!.attachLocal(uris); };
  const canSend = () => !props.disabled && !props.busy && (props.ready ?? (props.value.trim() !== "" || (props.attachments?.count() ?? 0) > 0));
  const submit = () => { if (canSend()) props.onSubmit(); };
  // On a phone the chat box keeps its controls on one line under the text, scrolling sideways where they don't fit, and
  // its hint shows only while it can't send: the pickers already say how a message runs.
  const narrow = phoneWidth;
  const hint = () => (narrow() && !props.disabled ? "" : props.hint);
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
      onFileDrop={event => { dragging.set(false); attachLocal(event.uris); }}>
      <If when={props.attachments}>{attachments => <AttachmentStrip attachments={attachments()} disabled={props.busy || props.disabled} />}</If>
      <View style={{ maxHeight: MAX_TEXT_HEIGHT }}>
        <Input testID={props.testID ?? "composer-input"} value={props.value} onChange={event => props.onChange(event.value)} multiline readonly={props.busy || props.disabled}
          placeholder={props.placeholder} accessibilityLabel={props.placeholder}
          submitBehavior={platform.desktop ? "submit" : "newline"} onSubmit={submit}
          onPaste={event => {
            if (!accepting()) return;
            if (event.uris.length) attachLocal(event.uris);
            else if (event.files.length) props.attachments!.attach(event.files);
          }}
          onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
          style={{ fontSize: text.reading, lineHeight: 22, minHeight: props.minHeight ?? 24, maxHeight: MAX_TEXT_HEIGHT, paddingHorizontal: 4, paddingVertical: 0,
            color: palette().text, placeholderColor: palette().muted }} />
      </View>
      <If when={props.attachments?.notice()}>{notice => <Small testID="composer-notice" tone="warning">{notice()}</Small>}</If>
      <View testID="composer-controls" style={{ flexDirection: "row", flexWrap: narrow() ? "nowrap" : "wrap", alignItems: "center", rowGap: 4, columnGap: narrow() ? 4 : 8 }}>
        <If when={props.tools || (props.attachments && !props.disabled)}>
          <If when={narrow()}
            else={
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, flexShrink: 1, ...(hint() ? {} : { flexGrow: 1, flexBasis: 0, minWidth: 0 }) }}>
                {tools()}
              </View>
            }>
            <Scroll testID="composer-tools" horizontal scrollbar={false} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}
              contentStyle={{ flexDirection: "row", alignItems: "center", gap: 0 }}>
              {tools()}
            </Scroll>
          </If>
        </If>
        <If when={hint()}>
          <Text style={{ flexGrow: 1, flexShrink: 1, flexBasis: narrow() ? 0 : 160, minWidth: 0, fontSize: text.caption, color: palette().muted,
            ...(narrow() ? { numberOfLines: 2 } : {}) }}>{hint()}</Text>
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
    </View>
  );
}
