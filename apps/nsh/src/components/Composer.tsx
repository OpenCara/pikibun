import { effect, keymap, platform, signal, Text, View, type JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import type { Attachments } from "../lib/attachments";
import { Icon } from "../icons";
import { control, palette, radius, text } from "../theme";
import { Small } from "../ui";
import { AttachButton, AttachmentStrip } from "./Attachments";

/** How tall the message grows before it scrolls. */
const MAX_TEXT_HEIGHT = 220;

/**
 * The chat box, as the web app's .composer: one bordered field, the message on top and, along its bottom edge, its
 * option pickers (`tools`), the hint and the send button. `onStop`, while the agent works and the person may stop it,
 * puts a stop button beside send; messages can still be queued. `hint` says who the message runs as, or why it can't
 * be sent. With `attachments`, images and files picked with its attach button or pasted into it go with the message,
 * which may then have no text; a pasted image is attached, and the paste's text, if any, still goes into the box. On the desktops and in a desktop browser Return sends and Shift+Return adds a line, as
 * in the web app; on phones, whose keyboards have no Shift, Return adds a line and the send button sends.
 */
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
    <View testID="composer" style={{ gap: 8, padding: 12, borderWidth: 1, borderRadius: radius.large,
      borderColor: dragging() ? palette().accent : focused() ? palette().borderStrong : palette().border, backgroundColor: palette().surface }}
      onFileDragEnter={() => dragging.set(accepting())} onFileDragLeave={() => dragging.set(false)}
      onFileDrop={event => { dragging.set(false); attachLocal(event.uris); }}>
      <If when={props.attachments}>{attachments => <AttachmentStrip attachments={attachments()} disabled={props.busy || props.disabled} />}</If>
      {/* The box around the text holds its height too: NSH (0.4) sizes an input's parent by the whole text, past the input's
          maxHeight, so a long message left the box far taller than the text, its pickers and send button halfway down it. */}
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
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 4, columnGap: 8 }}>
        <If when={props.tools || (props.attachments && !props.disabled)}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, flexShrink: 1,
            ...(props.hint ? {} : { flexGrow: 1, flexBasis: 0, minWidth: 0 }) }}>
            <If when={props.attachments && !props.disabled ? props.attachments : null}>
              {attachments => <AttachButton attachments={attachments()} disabled={props.busy} />}
            </If>
            {props.tools}
          </View>
        </If>
        <If when={props.hint}>
          <Text style={{ flexGrow: 1, flexShrink: 1, flexBasis: 160, fontSize: text.caption, color: palette().muted }}>{props.hint}</Text>
        </If>
        <View style={{ flexDirection: "row", gap: 4, marginLeft: "auto", alignSelf: "flex-end" }}>
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
