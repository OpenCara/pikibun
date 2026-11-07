import { Scroll, signal, Text, View, type JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { Icon } from "../icons";
import { palette, radius, text } from "../theme";

/**
 * The chat box: one rounded field, the message on top and, along its bottom edge, its option pickers (`tools`) and the
 * send button. `onStop`, while the agent works and the person may stop it, puts a stop button beside send; messages
 * can still be queued. `hint` says who the message runs as, or why it can't be sent.
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
    <View style={{ gap: 6 }}>
      <View style={{ borderWidth: 1, borderRadius: radius.xlarge, paddingTop: 4, paddingBottom: 6, paddingHorizontal: 6,
        borderColor: focused() ? palette().borderStrong : palette().border, backgroundColor: palette().surface,
        boxShadow: palette().scheme === "dark" ? "none" : "0 2px 10px rgba(0, 0, 0, 0.05)" }}>
        <Input testID={props.testID ?? "composer-input"} value={props.value} onChange={event => props.onChange(event.value)} multiline readonly={props.busy || props.disabled}
          placeholder={props.placeholder} accessibilityLabel={props.placeholder}
          onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
          style={{ fontSize: text.reading, lineHeight: 22, minHeight: props.minHeight ?? 44, maxHeight: 220, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4,
            color: palette().text, placeholderColor: palette().faint }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {/* One line of pickers, scrolled sideways where the window is too narrow for them all. */}
          <Scroll horizontal scrollbar={false} style={{ flex: 1 }} contentStyle={{ flexDirection: "row", alignItems: "center", gap: 2 }}>{props.tools}</Scroll>
          <If when={props.onStop}>
            <BaseButton testID="composer-stop" accessibilityLabel={props.stopping ? "Stopping..." : "Stop"} disabled={props.stopping} onPress={() => props.onStop?.()}
              style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: palette().borderStrong }}
              hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.35 }}>
              <Icon name="stop" size={14} color={palette().text} />
            </BaseButton>
          </If>
          <BaseButton testID={props.sendTestID ?? "composer-send"} accessibilityLabel={props.busy ? "Sending..." : props.sendLabel} disabled={!canSend()} onPress={props.onSubmit}
            style={{ flexDirection: "row", gap: 6, minWidth: 32, height: 32, borderRadius: 16, paddingHorizontal: props.sendText ? 12 : 0, alignItems: "center", justifyContent: "center",
              backgroundColor: canSend() ? palette().primary : palette().surfaceRaised }}
            hoverStyle={{ opacity: 0.85 }} activeStyle={{ opacity: 0.7 }}>
            <If when={props.sendText}>
              {label => <Text style={{ fontSize: text.small, fontWeight: "600", color: canSend() ? palette().onPrimary : palette().faint }}>{props.busy ? `${label()}…` : label()}</Text>}
            </If>
            <Icon name="arrow-up" size={16} strokeWidth={2.5} color={canSend() ? palette().onPrimary : palette().faint} />
          </BaseButton>
        </View>
      </View>
      <If when={props.hint}>
        <Text style={{ fontSize: text.caption, color: palette().faint, paddingHorizontal: 10 }}>{props.hint}</Text>
      </If>
    </View>
  );
}
