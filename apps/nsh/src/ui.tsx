import { Scroll, Text, View, type JSX } from "nsh";
import { AlertDialog, Button as BaseButton, Sheet } from "nsh/base";
import { palette, type Tone } from "./theme";

// The Expo app's UI kit on NSH's primitives: the same names, sizes and colors, so screens port one to one. NSH has no
// icon font, so icons are text symbols.

export function Button(props: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "default" | "ghost" | "danger";
  small?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: string;
  testID?: string;
}) {
  const colors = () => {
    const p = palette();
    switch (props.variant) {
      case "primary": return { background: p.primary, text: p.onPrimary, border: p.primary };
      case "danger": return { background: p.tones.danger.background, text: p.tones.danger.text, border: p.tones.danger.background };
      case "ghost": return { background: "transparent", text: p.text, border: "transparent" };
      default: return { background: p.surface, text: p.text, border: p.border };
    }
  };
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={{
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
        borderRadius: props.small ? 8 : 12, borderWidth: 1, borderColor: colors().border, backgroundColor: colors().background,
        paddingHorizontal: props.small ? 10 : 16, paddingVertical: props.small ? 6 : 12,
      }}
      activeStyle={{ opacity: 0.7 }}
      disabledStyle={{ opacity: 0.4 }}
    >
      <Text style={{ color: colors().text, fontSize: props.small ? 13 : 16, fontWeight: "600" }}>
        {props.busy ? "… " : props.icon ? `${props.icon}  ` : ""}{props.label}
      </Text>
    </BaseButton>
  );
}

export function IconButton(props: { icon: string; label: string; onPress: () => void; badge?: number; disabled?: boolean; testID?: string }) {
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} disabled={props.disabled} onPress={props.onPress} hitSlop={8}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8 }}
      activeStyle={{ opacity: 0.6 }} disabledStyle={{ opacity: 0.35 }}>
      <Text style={{ fontSize: 18, color: palette().text }}>{props.icon}</Text>
      <If when={(props.badge ?? 0) > 0}>
        <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: palette().tones.warning.text }}>
          <Text style={{ fontSize: 11, fontWeight: "700", color: palette().onPrimary }}>{String(props.badge ?? 0)}</Text>
        </View>
      </If>
    </BaseButton>
  );
}

export function Badge(props: { children: string; tone?: Tone; dot?: boolean }) {
  const tone = () => palette().tones[props.tone ?? "neutral"];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: tone().background }}>
      <If when={props.dot}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone().text }} />
      </If>
      <Text style={{ fontSize: 12, fontWeight: "600", color: tone().text }}>{props.children}</Text>
    </View>
  );
}

export function Banner(props: { tone?: Tone; title?: string; children?: JSX.Element; actions?: JSX.Element; testID?: string }) {
  const tone = () => palette().tones[props.tone ?? "neutral"];
  return (
    <View testID={props.testID} role="alert" style={{ gap: 6, borderRadius: 12, padding: 12, backgroundColor: tone().background }}>
      <If when={props.title}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: tone().text }}>{props.title}</Text>
      </If>
      <Text style={{ fontSize: 14, lineHeight: 20, color: palette().text }}>{props.children}</Text>
      <If when={props.actions}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{props.actions}</View>
      </If>
    </View>
  );
}

export function Card(props: { children?: JSX.Element; testID?: string }) {
  return (
    <View testID={props.testID} style={{ gap: 8, borderRadius: 14, borderWidth: 1, padding: 14, borderColor: palette().border, backgroundColor: palette().surface }}>
      {props.children}
    </View>
  );
}

export function Chip(props: { label: string; icon?: string; onPress: () => void; disabled?: boolean; tone?: Tone; testID?: string }) {
  const color = () => (props.tone ? palette().tones[props.tone].text : palette().text);
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} disabled={props.disabled} onPress={props.onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6, borderColor: palette().border, backgroundColor: palette().surface }}
      activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.5 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: color() }}>{props.icon ? `${props.icon} ` : ""}{props.label}</Text>
      <If when={!props.disabled}>
        <Text style={{ fontSize: 11, color: palette().muted }}>▾</Text>
      </If>
    </BaseButton>
  );
}

export function EmptyState(props: { title: string; children?: JSX.Element; action?: JSX.Element }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 }}>
      <Text style={{ fontSize: 18, fontWeight: "700", textAlign: "center", color: palette().text }}>{props.title}</Text>
      <If when={props.children}>
        <Text style={{ fontSize: 15, lineHeight: 21, textAlign: "center", color: palette().muted }}>{props.children}</Text>
      </If>
      {props.action}
    </View>
  );
}

export function Loading(props: { label?: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: 15, color: palette().muted }}>{props.label ?? "Loading…"}</Text>
    </View>
  );
}

/** An action's outcome: its error, else its notice. */
export function Feedback(props: { error?: string; notice?: string }) {
  return (
    <>
      <If when={props.error}>
        <Text role="alert" style={{ fontSize: 13, lineHeight: 18, color: palette().tones.danger.text }}>{props.error}</Text>
      </If>
      <If when={!props.error && props.notice}>
        <Text style={{ fontSize: 13, lineHeight: 18, color: palette().tones.success.text }}>{props.notice}</Text>
      </If>
    </>
  );
}

export function Small(props: { children?: JSX.Element; tone?: Tone; testID?: string; center?: boolean }) {
  return (
    <Text testID={props.testID}
      style={{ fontSize: 13, lineHeight: 18, textAlign: props.center ? "center" : "auto", color: props.tone ? palette().tones[props.tone].text : palette().muted }}>
      {props.children}
    </Text>
  );
}

/** Two or more choices side by side, one selected. */
export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; testID?: string }) {
  return (
    <View testID={props.testID} role="tablist" style={{ flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderRadius: 999, overflow: "hidden", borderColor: palette().border }}>
      <Each of={props.options} key={option => option.value}>
        {option => (
          <BaseButton role="tab" selected={props.value === option().value} onPress={() => props.onChange(option().value)}
            style={{ paddingHorizontal: 14, paddingVertical: 7, backgroundColor: props.value === option().value ? palette().selection : "transparent" }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: props.value === option().value ? palette().text : palette().muted }}>{option().label}</Text>
          </BaseButton>
        )}
      </Each>
    </View>
  );
}

export interface Option<T> {
  value: T;
  label: string;
  hint?: string;
  destructive?: boolean;
}

/** A sheet of choices from the bottom edge, the current one marked; the same on every platform. */
export function OptionSheet<T>(props: { open: boolean; title: string; options: Option<T>[]; value?: T; onClose: () => void; onSelect: (value: T) => void; testID?: string }) {
  return (
    <Sheet open={props.open} side="bottom" closeOnSwipe onOpenChange={event => { if (!event.open) props.onClose(); }}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={{ backgroundColor: palette().background, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "80%", paddingBottom: 24 }}>
      <View testID={props.testID} style={{ gap: 4, padding: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "700", color: palette().text }}>{props.title}</Text>
          <Button small variant="ghost" label="Done" onPress={props.onClose} />
        </View>
        <Scroll style={{ flexShrink: 1 }}>
          <Each of={props.options} key="index">
            {option => (
              <BaseButton role="menuitem" selected={props.value === option().value} accessibilityLabel={option().label}
                onPress={() => { props.onClose(); props.onSelect(option().value); }}
                style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 10 }}
                activeStyle={{ backgroundColor: palette().selection }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 16, color: option().destructive ? palette().tones.danger.text : palette().text }}>{option().label}</Text>
                  <If when={option().hint}>
                    <Text style={{ fontSize: 13, color: palette().muted }}>{option().hint}</Text>
                  </If>
                </View>
                <Text style={{ fontSize: 16, color: palette().text }}>{props.value === option().value ? "✓" : ""}</Text>
              </BaseButton>
            )}
          </Each>
        </Scroll>
      </View>
    </Sheet>
  );
}

/** The platform's own alert, answered true when the user confirms. */
export async function confirm(options: { title: string; message: string; confirmLabel: string; destructive?: boolean }): Promise<boolean> {
  const result = await AlertDialog.show({
    title: options.title,
    description: options.message,
    actions: [
      { id: "cancel", label: "Cancel", role: "cancel" },
      { id: "confirm", label: options.confirmLabel, role: options.destructive ? "destructive" : "default" },
    ],
  });
  return result.action === "confirm";
}

/** A labelled row of a settings card. */
export function Row(props: { label: string; children?: JSX.Element }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ fontSize: 13, color: palette().muted }}>{props.label}</Text>
      {props.children}
    </View>
  );
}

export function Value(props: { children?: JSX.Element; testID?: string }) {
  return <View selectable><Text testID={props.testID} style={{ fontSize: 16, color: palette().text }}>{props.children}</Text></View>;
}
