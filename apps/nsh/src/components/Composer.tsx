import { Text, View, type JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { palette } from "../theme";
import { Small } from "../ui";

/**
 * The chat box: a growing text field and a send button, with option pickers and a hint below. `onStop`, while the agent
 * works and the person may stop it, shows a stop button beside send; messages can still be queued.
 */
export function Composer(props: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; onStop?: () => void; stopping?: boolean; busy: boolean; disabled?: boolean;
  placeholder: string; sendLabel: string; hint: string; tools?: JSX.Element;
}) {
  const canSend = () => !props.disabled && !props.busy && props.value.trim() !== "";
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, borderWidth: 1, borderRadius: 20, paddingLeft: 14, paddingRight: 6, paddingVertical: 6, borderColor: palette().border, backgroundColor: palette().surface }}>
        <Input testID="composer-input" value={props.value} onChange={event => props.onChange(event.value)} multiline readonly={props.busy || props.disabled}
          placeholder={props.placeholder} accessibilityLabel={props.placeholder}
          style={{ flex: 1, fontSize: 16, lineHeight: 21, maxHeight: 160, paddingTop: 6, paddingBottom: 6, color: palette().text, placeholderColor: palette().muted }} />
        <If when={props.onStop}>
          <BaseButton testID="composer-stop" accessibilityLabel={props.stopping ? "Stopping..." : "Stop"} disabled={props.stopping} onPress={() => props.onStop?.()}
            style={{ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: palette().border }}
            activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.35 }}>
            <Text style={{ fontSize: 14, color: palette().text }}>■</Text>
          </BaseButton>
        </If>
        <BaseButton testID="composer-send" accessibilityLabel={props.busy ? "Sending..." : props.sendLabel} disabled={!canSend()} onPress={props.onSubmit}
          style={{ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: palette().primary }}
          activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.35 }}>
          <Text style={{ fontSize: 18, fontWeight: "700", color: palette().onPrimary }}>{props.busy ? "…" : "↑"}</Text>
        </BaseButton>
      </View>
      <If when={props.tools}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>{props.tools}</View>
      </If>
      <Small>{props.hint}</Small>
    </View>
  );
}
