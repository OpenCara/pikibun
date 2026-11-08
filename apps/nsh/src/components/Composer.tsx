import { signal, Text, View, type JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { Icon } from "../icons";
import { control, palette, radius, text } from "../theme";

/**
 * The chat box, as the web app's .composer: one bordered field, the message on top and, along its bottom edge, its
 * option pickers (`tools`), the hint and the send button. `onStop`, while the agent works and the person may stop it,
 * puts a stop button beside send; messages can still be queued. `hint` says who the message runs as, or why it can't
 * be sent.
 */
export function Composer(props: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; onStop?: () => void; stopping?: boolean; busy: boolean; disabled?: boolean;
  placeholder: string; sendLabel: string; hint: string; tools?: JSX.Element; minHeight?: number; testID?: string; sendTestID?: string;
  /** Sending is possible without a message (starting a session): the caller says when it's ready. */
  ready?: boolean;
  /** The send button's words, for a button that says what it does (Start session); an arrow otherwise. */
  sendText?: string;
}) {
  const focused = signal(false);
  const canSend = () => !props.disabled && !props.busy && (props.ready ?? props.value.trim() !== "");
  return (
    <View style={{ gap: 8, padding: 12, borderWidth: 1, borderRadius: radius.large,
      borderColor: focused() ? palette().borderStrong : palette().border, backgroundColor: palette().surface }}>
      <Input testID={props.testID ?? "composer-input"} value={props.value} onChange={event => props.onChange(event.value)} multiline readonly={props.busy || props.disabled}
        placeholder={props.placeholder} accessibilityLabel={props.placeholder}
        onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
        style={{ fontSize: text.reading, lineHeight: 22, minHeight: props.minHeight ?? 24, maxHeight: 220, paddingHorizontal: 4, paddingVertical: 0,
          color: palette().text, placeholderColor: palette().muted }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 4, columnGap: 8 }}>
        {/* The pickers wrap rather than scroll: what a message runs with (Auto-approve above all) must never be out of sight. */}
        <If when={props.tools}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, flexShrink: 1 }}>{props.tools}</View>
        </If>
        {/* .composer-hint: what is left of the row; on a narrow one it wraps to its own line rather than truncating. */}
        <Text style={{ flexGrow: 1, flexShrink: 1, flexBasis: 160, fontSize: text.caption, color: palette().muted }}>{props.hint}</Text>
        <View style={{ flexDirection: "row", gap: 4, marginLeft: "auto" }}>
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
