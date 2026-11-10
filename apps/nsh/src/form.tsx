import { Text, View, type JSX } from "nsh";
import { Button as BaseButton, Checkbox as BaseCheckbox, Input, Radio as BaseRadio } from "nsh/base";
import { Icon } from "./icons";
import { control, monospace, palette, radius, text, weight } from "./theme";
import { Picker, type Option } from "./ui";

type KeyboardType = "default" | "email-address" | "numeric" | "url" | "number-pad" | "decimal-pad" | "phone-pad";

export function TextField(props: {
  value: string; onChange: (value: string) => void; placeholder?: string; accessibilityLabel?: string; testID?: string; disabled?: boolean;
  masked?: boolean; multiline?: boolean; minHeight?: number; monospace?: boolean; compact?: boolean; keyboardType?: KeyboardType;
  autoCapitalize?: "none" | "sentences" | "words" | "characters"; autoCorrect?: boolean; autoFocus?: boolean; maxLength?: number;
  onSubmit?: () => void; flex?: boolean;
}) {
  return (
    <View style={{ flex: props.flex ? 1 : undefined, minWidth: 0, borderWidth: 1, borderColor: palette().border, borderRadius: props.compact ? radius.small : radius.medium,
      backgroundColor: palette().surface, opacity: props.disabled ? 0.5 : 1, justifyContent: "center",
      minHeight: props.multiline ? props.minHeight ?? 96 : props.compact ? control.small : control.medium,
      paddingHorizontal: 12, paddingVertical: props.multiline ? 10 : 0 }}>
      <Input testID={props.testID} value={props.value} onChange={event => props.onChange(event.value)} placeholder={props.placeholder}
        accessibilityLabel={props.accessibilityLabel ?? props.placeholder} readonly={props.disabled} masked={props.masked} multiline={props.multiline}
        keyboardType={props.keyboardType} autoCapitalize={props.autoCapitalize ?? (props.monospace || props.masked ? "none" : undefined)}
        autoCorrect={props.autoCorrect ?? !(props.monospace || props.masked)} autoFocus={props.autoFocus} maxLength={props.maxLength}
        returnKeyType={props.onSubmit && !props.multiline ? "done" : undefined} onSubmit={() => props.onSubmit?.()}
        style={{ fontSize: props.compact ? text.small : text.body, lineHeight: props.multiline ? 21 : undefined, fontFamily: props.monospace ? monospace : undefined,
          color: palette().text, placeholderColor: palette().muted, minHeight: props.multiline ? (props.minHeight ?? 96) - 22 : undefined }} />
    </View>
  );
}

export function Field(props: { label: string; hint?: string; error?: string; children?: JSX.Element; testID?: string }) {
  return (
    <View testID={props.testID} style={{ gap: 6 }}>
      <Text style={{ fontSize: text.body, fontWeight: weight.medium, color: palette().text }}>{props.label}</Text>
      {props.children}
      <If when={props.hint}>
        <Text style={{ fontSize: text.small, lineHeight: 19, color: palette().muted }}>{props.hint}</Text>
      </If>
      <If when={props.error}>
        <Text role="alert" style={{ fontSize: text.caption, color: palette().tones.danger.text }}>{props.error}</Text>
      </If>
    </View>
  );
}

function SelectTrigger(props: { label: string; placeholder: boolean; compact?: boolean; disabled?: boolean; testID?: string; accessibilityLabel: string }) {
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.accessibilityLabel} disabled={props.disabled}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, height: props.compact ? control.small : control.medium, paddingLeft: 12, paddingRight: 10,
        borderWidth: 1, borderColor: palette().border, borderRadius: props.compact ? radius.small : radius.medium, backgroundColor: palette().surface, minWidth: 0 }}
      hoverStyle={{ borderColor: palette().borderStrong }} disabledStyle={{ opacity: 0.5 }}>
      <Text style={{ flex: 1, numberOfLines: 1, fontSize: props.compact ? text.small : text.body, color: props.placeholder ? palette().muted : palette().text }}>{props.label}</Text>
      <Icon name="chevron-down" size={14} color={palette().muted} />
    </BaseButton>
  );
}

export function Select<T>(props: {
  value: T | undefined; options: Option<T>[]; onChange: (value: T) => void; label: string; placeholder?: string; disabled?: boolean; testID?: string; compact?: boolean;
}) {
  const current = () => props.options.find(option => option.value === props.value);
  const trigger = () => (
    <SelectTrigger testID={props.testID} accessibilityLabel={props.label} label={current()?.label ?? props.placeholder ?? "Select…"} placeholder={!current()}
      compact={props.compact} disabled={props.disabled} />
  );
  return (
    <If when={!props.disabled} else={trigger()}>
      <Picker<T> title={props.label} placement="bottom" value={props.value} options={props.options} onSelect={props.onChange} trigger={trigger()} />
    </If>
  );
}

function CheckMark(props: { checked: boolean; round?: boolean }) {
  return (
    <View style={{ width: 16, height: 16, marginTop: 2, borderRadius: props.round ? 8 : radius.xsmall, borderWidth: props.checked ? 0 : 1, borderColor: palette().borderStrong,
      backgroundColor: props.checked ? palette().accent : palette().surface, alignItems: "center", justifyContent: "center" }}>
      <If when={props.checked}>
        <If when={props.round} else={<Icon name="check" size={12} strokeWidth={3} color={palette().onAccent} />}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette().onAccent }} />
        </If>
      </If>
    </View>
  );
}

function CheckLabel(props: { label: string; hint?: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ fontSize: text.body, color: palette().text }}>{props.label}</Text>
      <If when={props.hint}><Text style={{ fontSize: text.small, lineHeight: 19, color: palette().muted }}>{props.hint}</Text></If>
    </View>
  );
}

export function Checkbox(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint?: string; disabled?: boolean; testID?: string }) {
  return (
    <BaseCheckbox testID={props.testID} checked={props.checked} disabled={props.disabled} accessibilityLabel={props.label} onChange={event => props.onChange(event.checked)}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }} disabledStyle={{ opacity: 0.5 }}
      indicator={<CheckMark checked={props.checked} />}>
      <CheckLabel label={props.label} hint={props.hint} />
    </BaseCheckbox>
  );
}

export function CheckControl(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; testID?: string }) {
  return (
    <BaseCheckbox testID={props.testID} checked={props.checked} disabled={props.disabled} accessibilityLabel={props.label} hitSlop={10}
      onChange={event => props.onChange(event.checked)} disabledStyle={{ opacity: 0.5 }} indicator={<CheckMark checked={props.checked} />} />
  );
}

export function RadioRow(props: { checked: boolean; onSelect: () => void; label: string; hint?: string; disabled?: boolean; testID?: string }) {
  return (
    <BaseRadio testID={props.testID} checked={props.checked} disabled={props.disabled} accessibilityLabel={props.label} onChange={event => { if (event.checked) props.onSelect(); }}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }} disabledStyle={{ opacity: 0.6 }}>
      <CheckMark checked={props.checked} round />
      <CheckLabel label={props.label} hint={props.hint} />
    </BaseRadio>
  );
}

export function RadioGroup<T>(props: { value: T; options: (Option<T> & { disabled?: boolean })[]; onChange: (value: T) => void; disabled?: boolean; testID?: string }) {
  return (
    <View testID={props.testID} role="radiogroup" style={{ gap: 10 }}>
      <Each of={props.options} key="index">
        {option => <RadioRow checked={props.value === option().value} label={option().label} hint={option().hint} disabled={props.disabled || option().disabled}
          onSelect={() => props.onChange(option().value)} />}
      </Each>
    </View>
  );
}
