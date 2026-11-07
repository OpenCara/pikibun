import { Image, Scroll, Text, View, type JSX, type ViewStyle } from "nsh";
import { AlertDialog, Button as BaseButton, Menu, MenuItem, Sheet, Tooltip } from "nsh/base";
import logo from "./assets/logo.png";
import { Icon, type IconName } from "./icons";
import { palette, radius, text, type Tone } from "./theme";

// The app's UI kit on NSH's primitives: quiet, dense chrome in the manner of today's coding-agent apps (Codex, Claude
// Code, Lody, Paseo), so the conversation and what needs a decision stand out. Icons are vector outlines (icons.tsx).

type ButtonVariant = "primary" | "default" | "ghost" | "danger" | "accent";

export function Button(props: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  small?: boolean;
  large?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  /** Takes the whole width of its column. */
  block?: boolean;
  testID?: string;
}) {
  const colors = () => {
    const p = palette();
    switch (props.variant) {
      case "primary": return { background: p.primary, text: p.onPrimary, border: p.primary, hover: p.primary };
      case "accent": return { background: p.accent, text: p.onAccent, border: p.accent, hover: p.accent };
      case "danger": return { background: p.tones.danger.background, text: p.tones.danger.text, border: p.tones.danger.border, hover: p.tones.danger.border };
      case "ghost": return { background: "transparent", text: p.text, border: "transparent", hover: p.hover };
      default: return { background: p.surface, text: p.text, border: p.borderStrong, hover: p.hover };
    }
  };
  const height = () => (props.small ? 28 : props.large ? 42 : 34);
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={{
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: height(),
        alignSelf: props.block ? "stretch" : "auto",
        borderRadius: props.small ? radius.small : radius.medium, borderWidth: 1, borderColor: colors().border, backgroundColor: colors().background,
        paddingHorizontal: props.small ? 10 : 14,
      }}
      hoverStyle={{ backgroundColor: colors().hover, opacity: props.variant === "primary" || props.variant === "accent" ? 0.9 : 1 }}
      activeStyle={{ opacity: 0.75 }}
      disabledStyle={{ opacity: 0.4 }}
    >
      <If when={props.busy ? "loader" : props.icon}>
        {name => <Icon name={name() === "loader" ? "refresh" : name() as IconName} size={props.small ? 14 : 16} color={colors().text} />}
      </If>
      <Text style={{ color: colors().text, fontSize: props.small ? text.small : text.body, fontWeight: "600", numberOfLines: 1 }}>
        {props.busy ? `${props.label}…` : props.label}
      </Text>
    </BaseButton>
  );
}

/** A square button with an icon; `label` is what screen readers say and the desktop's tooltip shows. */
export function IconButton(props: {
  icon: IconName; label: string; onPress: () => void; badge?: number; disabled?: boolean; testID?: string; active?: boolean; tone?: Tone; size?: number;
}) {
  const color = () => (props.tone ? palette().tones[props.tone].text : props.active ? palette().text : palette().muted);
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} disabled={props.disabled} onPress={props.onPress} hitSlop={6}
      tooltip={<Tooltip style={{ backgroundColor: palette().primary, borderRadius: radius.small, paddingHorizontal: 8, paddingVertical: 4 }}>
        <Text style={{ fontSize: text.caption, color: palette().onPrimary }}>{props.label}</Text>
      </Tooltip>}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minWidth: props.size ?? 32, height: props.size ?? 32, paddingHorizontal: 6,
        borderRadius: radius.medium, backgroundColor: props.active ? palette().selection : "transparent" }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.6 }} disabledStyle={{ opacity: 0.35 }}>
      <Icon name={props.icon} size={18} color={color()} />
      <If when={(props.badge ?? 0) > 0}>
        <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: palette().tones.warning.text }}>
          <Text style={{ fontSize: 11, fontWeight: "700", color: palette().scheme === "dark" ? "#111113" : "#ffffff" }}>{String(props.badge ?? 0)}</Text>
        </View>
      </If>
    </BaseButton>
  );
}

export function Badge(props: { children: string; tone?: Tone; dot?: boolean; icon?: IconName; testID?: string }) {
  const tone = () => palette().tones[props.tone ?? "neutral"];
  return (
    <View testID={props.testID} style={{ flexDirection: "row", alignItems: "center", gap: 5, borderRadius: radius.pill, paddingHorizontal: 8, height: 22, backgroundColor: tone().background }}>
      <If when={props.dot}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone().text }} />
      </If>
      <If when={props.icon}>{name => <Icon name={name()} size={12} color={tone().text} />}</If>
      <Text style={{ fontSize: text.caption, fontWeight: "600", color: tone().text, numberOfLines: 1 }}>{props.children}</Text>
    </View>
  );
}

const toneIcons: Record<Tone, IconName> = { neutral: "info", info: "info", success: "check", warning: "alert", danger: "alert", running: "sparkles" };

/** A notice: an icon in its tone, a title, what it says and what can be done about it. */
export function Banner(props: { tone?: Tone; title?: string; children?: JSX.Element; actions?: JSX.Element; testID?: string; icon?: IconName }) {
  const tone = () => palette().tones[props.tone ?? "neutral"];
  return (
    <View testID={props.testID} role="alert" style={{ flexDirection: "row", gap: 10, borderRadius: radius.large, borderWidth: 1, padding: 12,
      borderColor: tone().border, backgroundColor: tone().background }}>
      <Icon name={props.icon ?? toneIcons[props.tone ?? "neutral"]} size={16} color={tone().text} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 4 }}>
        <If when={props.title}>
          <Text style={{ fontSize: text.body, fontWeight: "600", color: tone().text }}>{props.title}</Text>
        </If>
        <If when={props.children}>
          <Text style={{ fontSize: text.small, lineHeight: 19, color: palette().text }}>{props.children}</Text>
        </If>
        <If when={props.actions}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 4 }}>{props.actions}</View>
        </If>
      </View>
    </View>
  );
}

export function Card(props: { children?: JSX.Element; testID?: string; style?: ViewStyle }) {
  return (
    <View testID={props.testID} style={{ gap: 10, borderRadius: radius.large, borderWidth: 1, padding: 14, borderColor: palette().border, backgroundColor: palette().surface, ...props.style }}>
      {props.children}
    </View>
  );
}

/** A quiet button that shows a choice and opens its picker: the chat box's model, access and host. */
export function Chip(props: { label: string; icon?: IconName; onPress?: () => void; disabled?: boolean; tone?: Tone; testID?: string; bordered?: boolean }) {
  const color = () => (props.tone ? palette().tones[props.tone].text : palette().muted);
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} disabled={props.disabled} onPress={() => props.onPress?.()}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radius.medium, paddingHorizontal: 8, height: 28, flexShrink: 1,
        borderWidth: props.bordered ? 1 : 0, borderColor: palette().border, backgroundColor: props.bordered ? palette().surface : "transparent" }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.6 }}>
      <If when={props.icon}>{name => <Icon name={name()} size={14} color={color()} />}</If>
      <Text style={{ fontSize: text.small, fontWeight: "500", color: color(), numberOfLines: 1, flexShrink: 1 }}>{props.label}</Text>
      <If when={!props.disabled && props.onPress}>
        <Icon name="chevron-down" size={12} color={palette().faint} />
      </If>
    </BaseButton>
  );
}

export function EmptyState(props: { title: string; children?: JSX.Element; action?: JSX.Element; icon?: IconName }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 }}>
      <If when={props.icon}>
        {name => (
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: palette().surfaceRaised, marginBottom: 4 }}>
            <Icon name={name()} size={20} color={palette().muted} />
          </View>
        )}
      </If>
      <Text style={{ fontSize: 16, fontWeight: "600", textAlign: "center", color: palette().text }}>{props.title}</Text>
      <If when={props.children}>
        <Text style={{ fontSize: text.body, lineHeight: 20, textAlign: "center", maxWidth: 420, color: palette().muted }}>{props.children}</Text>
      </If>
      {props.action}
    </View>
  );
}

export function Loading(props: { label?: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: text.body, color: palette().muted }}>{props.label ?? "Loading…"}</Text>
    </View>
  );
}

/** An action's outcome: its error, else its notice. */
export function Feedback(props: { error?: string; notice?: string }) {
  return (
    <>
      <If when={props.error}>
        <Text role="alert" style={{ fontSize: text.small, lineHeight: 18, color: palette().tones.danger.text }}>{props.error}</Text>
      </If>
      <If when={!props.error && props.notice}>
        <Text style={{ fontSize: text.small, lineHeight: 18, color: palette().tones.success.text }}>{props.notice}</Text>
      </If>
    </>
  );
}

export function Small(props: { children?: JSX.Element; tone?: Tone; testID?: string; center?: boolean }) {
  return (
    <Text testID={props.testID}
      style={{ fontSize: text.small, lineHeight: 18, textAlign: props.center ? "center" : "auto", color: props.tone ? palette().tones[props.tone].text : palette().muted }}>
      {props.children}
    </Text>
  );
}

/** A small heading over a group: a list's workspace, a settings card. */
export function SectionLabel(props: { children: string; testID?: string }) {
  return (
    <Text testID={props.testID} style={{ fontSize: text.caption, fontWeight: "600", color: palette().faint, numberOfLines: 1 }}>{props.children}</Text>
  );
}

/** Two or more choices side by side, one selected. */
export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string; icon?: IconName }[]; onChange: (value: T) => void; testID?: string }) {
  return (
    <View testID={props.testID} role="tablist" style={{ flexDirection: "row", alignSelf: "flex-start", gap: 2, padding: 2, borderRadius: radius.medium, backgroundColor: palette().surfaceRaised }}>
      <Each of={props.options} key={option => option.value}>
        {option => (
          <BaseButton role="tab" selected={props.value === option().value} onPress={() => props.onChange(option().value)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 26, borderRadius: radius.small,
              backgroundColor: props.value === option().value ? palette().surface : "transparent",
              borderWidth: 1, borderColor: props.value === option().value ? palette().border : "transparent" }}
            hoverStyle={{ opacity: 0.85 }}>
            <If when={option().icon}>{name => <Icon name={name()} size={13} color={props.value === option().value ? palette().text : palette().muted} />}</If>
            <Text style={{ fontSize: text.small, fontWeight: "500", color: props.value === option().value ? palette().text : palette().muted }}>{option().label}</Text>
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
  icon?: IconName;
}

/** One choice of a picker: its icon, label and hint, the current one checked. */
function OptionRow<T>(props: { option: Option<T>; selected: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
      <If when={props.option.icon}>{name => <Icon name={name()} size={16} color={palette().muted} />}</If>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ fontSize: text.body, color: props.option.destructive ? palette().tones.danger.text : palette().text, numberOfLines: 1 }}>{props.option.label}</Text>
        <If when={props.option.hint}>
          <Text style={{ fontSize: text.caption, lineHeight: 16, color: palette().muted, numberOfLines: 4 }}>{props.option.hint}</Text>
        </If>
      </View>
      <View style={{ width: 16 }}>
        <If when={props.selected}><Icon name="check" size={16} color={palette().accent} /></If>
      </View>
    </View>
  );
}

/**
 * A choice among options from a trigger: a menu at the trigger on the desktops, a sheet from the bottom on touch screens.
 */
export function Picker<T>(props: { trigger: JSX.Element; title: string; options: Option<T>[]; value?: T; onSelect: (value: T) => void; testID?: string; placement?: "top" | "bottom" }) {
  return (
    <Menu trigger={props.trigger} placement={props.placement ?? "top"} offset={6}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={{ minWidth: 260, maxWidth: 420, padding: 4, gap: 1, borderRadius: radius.large, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)" }}>
      <View testID={props.testID} style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4 }}>
        <SectionLabel>{props.title}</SectionLabel>
      </View>
      <Each of={props.options} key="index">
        {option => (
          <MenuItem accessibilityLabel={option().label} onSelect={() => props.onSelect(option().value)}
            style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.medium }}
            hoverStyle={{ backgroundColor: palette().hover }} focusStyle={{ backgroundColor: palette().hover }} activeStyle={{ backgroundColor: palette().selection }}>
            <OptionRow option={option()} selected={props.value === option().value} />
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}

/** A sheet of choices from the bottom edge, the current one marked; for choices that have no trigger of their own. */
export function OptionSheet<T>(props: { open: boolean; title: string; options: Option<T>[]; value?: T; onClose: () => void; onSelect: (value: T) => void; testID?: string }) {
  return (
    <Sheet open={props.open} side="bottom" closeOnSwipe onOpenChange={event => { if (!event.open) props.onClose(); }}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={{ backgroundColor: palette().surface, borderTopLeftRadius: radius.xlarge, borderTopRightRadius: radius.xlarge, maxHeight: "80%", paddingBottom: 24,
        width: "100%", maxWidth: 560, alignSelf: "center" }}>
      <View testID={props.testID} style={{ gap: 4, padding: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingBottom: 4 }}>
          <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: palette().text }}>{props.title}</Text>
          <Button small variant="ghost" label="Done" onPress={props.onClose} />
        </View>
        <Scroll style={{ flexShrink: 1 }}>
          <Each of={props.options} key="index">
            {option => (
              <BaseButton role="menuitem" selected={props.value === option().value} accessibilityLabel={option().label}
                onPress={() => { props.onClose(); props.onSelect(option().value); }}
                style={{ flexDirection: "row", alignItems: "center", paddingVertical: 11, paddingHorizontal: 10, borderRadius: radius.medium }}
                hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ backgroundColor: palette().selection }}>
                <OptionRow option={option()} selected={props.value === option().value} />
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
    <View style={{ gap: 3 }}>
      <Text style={{ fontSize: text.caption, color: palette().muted }}>{props.label}</Text>
      {props.children}
    </View>
  );
}

export function Value(props: { children?: JSX.Element; testID?: string }) {
  return <View selectable><Text testID={props.testID} style={{ fontSize: text.body, color: palette().text }}>{props.children}</Text></View>;
}

/** Someone's initial in a circle. */
export function Avatar(props: { name: string; size?: number }) {
  const size = () => props.size ?? 24;
  return (
    <View style={{ width: size(), height: size(), borderRadius: size() / 2, alignItems: "center", justifyContent: "center", backgroundColor: palette().accentSoft }}>
      <Text style={{ fontSize: size() * 0.46, fontWeight: "700", color: palette().accent }}>{(Array.from(props.name.trim())[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

/** Pikibun's mark: its icon, rounded. */
export function Logo(props: { size?: number }) {
  const size = () => props.size ?? 22;
  return <Image src={logo} accessibilityLabel="Pikibun" style={{ width: size(), height: size(), borderRadius: size() * 0.28 }} />;
}

/** A hairline between parts. */
export function Divider(props: { vertical?: boolean }) {
  return <View style={props.vertical ? { width: 1, alignSelf: "stretch", backgroundColor: palette().border } : { height: 1, alignSelf: "stretch", backgroundColor: palette().border }} />;
}
