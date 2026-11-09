import { Clipboard, Image, Scroll, signal, Text, View, windowSize, type JSX, type ViewStyle } from "nsh";
import { AlertDialog, Button as BaseButton, Collapsible, ContextMenu, Dialog, Menu, MenuItem, Popover, Sheet, Tooltip } from "nsh/base";
import logo from "./assets/logo.png";
import { Icon, type IconName } from "./icons";
import { control, palette, radius, text, weight, type Tone } from "./theme";

// The app's UI kit on NSH's primitives, first drawn as the React web client's: quiet, spacious chrome where hierarchy
// comes from weight and color, not size, and there is one accent call to action per surface. Each widget names the web
// client's CSS class it was drawn from.

/**
 * `primary` is the one accent CTA per surface (the web's `default`); `default` a filled secondary button; `outline` row
 * and card actions; `ghost` chrome; `danger` a destructive action after the person said they mean it.
 */
type ButtonVariant = "primary" | "default" | "outline" | "ghost" | "danger" | "accent";

/** .btn and its variants and sizes. */
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
      case "primary":
      case "accent": return { background: p.accent, text: p.onAccent, border: p.accent, hover: p.accentHover };
      case "danger": return { background: p.tones.danger.text, text: "#ffffff", border: p.tones.danger.text, hover: p.tones.danger.text };
      case "outline": return { background: "transparent", text: p.text, border: p.borderStrong, hover: p.hover };
      case "ghost": return { background: "transparent", text: p.muted, border: "transparent", hover: p.hover };
      default: return { background: p.control, text: p.text, border: p.control, hover: p.hoverStrong };
    }
  };
  const height = () => (props.small ? control.small : props.large ? control.large : control.medium);
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={{
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: height(),
        alignSelf: props.block ? "stretch" : "auto",
        borderRadius: props.small ? radius.small : radius.medium, borderWidth: 1, borderColor: colors().border, backgroundColor: colors().background,
        paddingHorizontal: props.small ? 12 : props.large ? 20 : 16,
      }}
      hoverStyle={{ backgroundColor: colors().hover }}
      activeStyle={{ opacity: 0.8 }}
      disabledStyle={{ opacity: 0.5 }}
    >
      <If when={props.busy ? "loader" : props.icon}>
        {name => <Icon name={name() === "loader" ? "refresh" : name() as IconName} size={16} color={colors().text} />}
      </If>
      <Text style={{ color: colors().text, fontSize: text.body, fontWeight: weight.normal, numberOfLines: 1 }}>
        {props.busy ? `${props.label}…` : props.label}
      </Text>
    </BaseButton>
  );
}

/**
 * A square ghost button with an icon (.btn.ghost.icon-only); `label` is what screen readers say and the desktop's
 * tooltip shows. 32 points square unless `size` says otherwise.
 */
export function IconButton(props: {
  icon: IconName; label: string; onPress: () => void; badge?: number; disabled?: boolean; testID?: string; active?: boolean; tone?: Tone; size?: number;
}) {
  const color = () => (props.tone ? palette().tones[props.tone].text : props.active ? palette().text : palette().muted);
  const size = () => props.size ?? control.small;
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} disabled={props.disabled} onPress={props.onPress} hitSlop={6}
      tooltip={<Tooltip style={{ backgroundColor: palette().primary, borderRadius: radius.small, paddingHorizontal: 8, paddingVertical: 4 }}>
        <Text style={{ fontSize: text.caption, color: palette().onPrimary }}>{props.label}</Text>
      </Tooltip>}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minWidth: size(), height: size(), paddingHorizontal: (props.badge ?? 0) > 0 ? 6 : 0,
        borderRadius: size() > control.small ? radius.medium : radius.small, backgroundColor: props.active ? palette().selection : "transparent" }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.5 }}>
      <Icon name={props.icon} size={16} color={color()} />
      <If when={(props.badge ?? 0) > 0}>
        <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: palette().dots.warning }}>
          <Text style={{ fontSize: 11, fontWeight: weight.semibold, color: "#1b1b1a" }}>{String(props.badge ?? 0)}</Text>
        </View>
      </If>
    </BaseButton>
  );
}

/** .dot: a status at a glance, 7 points; a running one in its own blue. */
export function StatusDot(props: { tone?: Tone; testID?: string; label?: string }) {
  return (
    <View testID={props.testID} accessibilityLabel={props.label}
      style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: palette().dots[props.tone ?? "neutral"] }} />
  );
}

/** .badge: a quiet pill whose words take the status's color; `dot` puts its .dot before them. */
export function Badge(props: { children: string; tone?: Tone; dot?: boolean; icon?: IconName; testID?: string }) {
  const color = () => palette().tones[props.tone ?? "neutral"].text;
  return (
    <View testID={props.testID} style={{ flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radius.pill, paddingHorizontal: 8, height: 22,
      borderWidth: 1, borderColor: palette().border, backgroundColor: palette().control }}>
      <If when={props.dot}>
        <StatusDot tone={props.tone} />
      </If>
      <If when={props.icon}>{name => <Icon name={name()} size={12} color={color()} />}</If>
      <Text style={{ fontSize: text.caption, color: color(), numberOfLines: 1 }}>{props.children}</Text>
    </View>
  );
}

const toneIcons: Record<Tone, IconName> = { neutral: "info", info: "info", running: "info", success: "check", warning: "alert", danger: "alert" };

/**
 * .alert: a notice with a quiet border in its tone and no fill; its icon and title take the tone, what it says is
 * muted, and what can be done about it follows.
 */
export function Banner(props: { tone?: Tone; title?: string; children?: JSX.Element; actions?: JSX.Element; testID?: string; icon?: IconName }) {
  const tone = () => palette().tones[props.tone ?? "neutral"];
  const neutral = () => (props.tone ?? "neutral") === "neutral";
  return (
    <View testID={props.testID} role="alert" style={{ flexDirection: "row", gap: 12, borderRadius: radius.medium, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 16,
      borderColor: tone().border }}>
      <Icon name={props.icon ?? toneIcons[props.tone ?? "neutral"]} size={16} color={neutral() ? palette().muted : tone().text} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <If when={props.title}>
          <Text style={{ fontSize: text.body, lineHeight: 21, fontWeight: weight.medium, color: neutral() ? palette().text : tone().text }}>{props.title}</Text>
        </If>
        <If when={props.children}>
          <Text style={{ fontSize: text.small, lineHeight: 19, color: palette().muted }}>{props.children}</Text>
        </If>
        <If when={props.actions}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 8 }}>{props.actions}</View>
        </If>
      </View>
    </View>
  );
}

/** .card with its .card-body: a bordered surface with padded content. */
export function Card(props: { children?: JSX.Element; testID?: string; style?: ViewStyle }) {
  return (
    <View testID={props.testID} style={{ gap: 12, borderRadius: radius.large, borderWidth: 1, padding: 16, borderColor: palette().border, backgroundColor: palette().surface, ...props.style }}>
      {props.children}
    </View>
  );
}

/**
 * .section: a muted medium title (with an action at its end) over one card of `Row`s, or of `CardBody` content; `bare`
 * leaves the card out.
 */
export function Section(props: { title: string; info?: JSX.Element | string; action?: JSX.Element; children?: JSX.Element; bare?: boolean; testID?: string }) {
  return (
    <View testID={props.testID} style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingHorizontal: 2 }}>
        <Text role="header" style={{ flexShrink: 1, fontSize: text.body, fontWeight: weight.medium, color: palette().muted }}>{props.title}</Text>
        <If when={props.info}><InfoTip>{props.info}</InfoTip></If>
        <View style={{ flex: 1 }} />
        {props.action}
      </View>
      <If when={!props.bare} else={props.children}>
        <View style={{ overflow: "hidden", borderRadius: radius.large, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
          {/* Every row draws a hairline above it; this hides the first one's under the card's own border. */}
          <View style={{ marginTop: -1 }}>{props.children}</View>
        </View>
      </If>
    </View>
  );
}

/** .card-body: free-form content inside a section's card. */
export function CardBody(props: { children?: JSX.Element; testID?: string }) {
  return <View testID={props.testID} style={{ gap: 12, padding: 16, borderTopWidth: 1, borderColor: palette().border }}>{props.children}</View>;
}

/**
 * .row: one line of a section's card: what it is (`title`, a muted `hint` under it) and, at its end, its value or
 * action (`trailing`). With `onPress` and `chevron` it opens something.
 */
export function Row(props: { title: string; hint?: JSX.Element; leading?: JSX.Element; trailing?: JSX.Element | string; onPress?: () => void; chevron?: boolean; testID?: string; hintTestID?: string; selectableHint?: boolean }) {
  /** A value at the row's end is muted words; anything else (a button, a badge) is drawn as it is. */
  const trailing = () => (typeof props.trailing === "string"
    ? <Text style={{ fontSize: text.body, color: palette().muted, textAlign: "right" }}>{props.trailing}</Text>
    : props.trailing);
  const body = () => (
    <>
      <If when={props.leading}>{props.leading}</If>
      <View style={{ flex: 1, minWidth: 96, gap: 2 }}>
        <Text style={{ fontSize: text.body, color: palette().text }}>{props.title}</Text>
        <If when={props.hint}>
          <View selectable={props.selectableHint}>
            <Text testID={props.hintTestID} style={{ fontSize: text.small, lineHeight: 19, color: palette().muted }}>{props.hint}</Text>
          </View>
        </If>
      </View>
      <If when={props.trailing || props.chevron}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, flexShrink: 1 }}>
          {trailing()}
          <If when={props.chevron}><Icon name="chevron-right" size={16} color={palette().muted} /></If>
        </View>
      </If>
    </>
  );
  const style = (): ViewStyle => ({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, minHeight: 52, paddingVertical: 12, paddingHorizontal: 16,
    borderTopWidth: 1, borderColor: palette().border });
  return (
    <If when={props.onPress} else={<View testID={props.testID} style={style()}>{body()}</View>}>
      <BaseButton testID={props.testID} accessibilityLabel={props.title} onPress={() => props.onPress?.()} style={style()}
        hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
        {body()}
      </BaseButton>
    </If>
  );
}

/**
 * One of the sidebar's places (.nav-item): an icon or a badge and a label, muted until it is the one shown. `strong`
 * keeps the label in the text's color, as the app's own name is.
 */
export function NavItem(props: { icon?: IconName; leading?: JSX.Element; label: string; onPress?: () => void; active?: boolean; strong?: boolean; testID?: string; style?: ViewStyle }) {
  const color = () => (props.active || props.strong ? palette().text : palette().muted);
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} selected={props.active} disabled={!props.onPress} onPress={() => props.onPress?.()}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 34, paddingHorizontal: 8, paddingVertical: 6, borderRadius: radius.medium,
        backgroundColor: props.active ? palette().selection : "transparent", ...props.style }}
      hoverStyle={{ backgroundColor: props.active ? palette().selection : palette().hover }} activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 1 }}>
      <If when={props.icon} else={props.leading}>{name => <Icon name={name()} size={16} color={color()} />}</If>
      <Text style={{ flex: 1, numberOfLines: 1, fontSize: text.body, fontWeight: props.strong ? weight.medium : weight.normal, color: color() }}>{props.label}</Text>
    </BaseButton>
  );
}

/**
 * A quiet button that shows a choice and opens its picker (.btn.ghost.sm with a chevron): the chat box's model,
 * reasoning and access. As a `Picker`'s trigger it has no `onPress` of its own (the menu opens); its chevron says it
 * opens one unless it is `disabled`. A `tone` tints it (Auto-approve's warning). `small` is the quieter size of a
 * row of settings under a chat box (the new session's workspace, host and visibility). With `expanded` it discloses
 * what it opens in place instead (the new session's Host details): its chevron turns down while open, and screen
 * readers are told it is on (a toggled trigger's `selected`; NSH's button has no expanded state of its own).
 */
export function Chip(props: {
  label: string; icon?: IconName; onPress?: () => void; disabled?: boolean; tone?: Tone; testID?: string; bordered?: boolean; small?: boolean; expanded?: boolean;
}) {
  const color = () => (props.tone ? palette().tones[props.tone].text : palette().muted);
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} disabled={props.disabled} onPress={() => props.onPress?.()}
      selected={props.expanded}
      style={{ flexDirection: "row", alignItems: "center", gap: props.icon ? 4 : 8, borderRadius: radius.small, paddingHorizontal: props.small ? 8 : 12,
        height: props.small ? control.xsmall : control.small, flexShrink: 1, maxWidth: 260,
        borderWidth: 1, borderColor: props.bordered ? palette().borderStrong : "transparent",
        backgroundColor: props.tone ? palette().tones[props.tone].background : "transparent" }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.8 }} disabledStyle={{ opacity: 0.5 }}>
      <If when={props.icon}>{name => <Icon name={name()} size={14} color={color()} />}</If>
      <Text style={{ fontSize: props.small ? text.small : text.body, color: color(), numberOfLines: 1, flexShrink: 1 }}>{props.label}</Text>
      <If when={!props.disabled}>
        <Icon name={props.expanded === false ? "chevron-right" : "chevron-down"} size={props.small ? 12 : 14} color={color()} />
      </If>
    </BaseButton>
  );
}

/** .empty-state: a muted noun phrase, a short note under it, and at most one action. */
export function EmptyState(props: { title: string; children?: JSX.Element; action?: JSX.Element }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingVertical: 40, paddingHorizontal: 16 }}>
      <Text style={{ fontSize: text.body, textAlign: "center", color: palette().muted }}>{props.title}</Text>
      <If when={props.children}>
        <Text style={{ fontSize: text.small, lineHeight: 20, textAlign: "center", maxWidth: 360, color: palette().muted }}>{props.children}</Text>
      </If>
      {props.action}
    </View>
  );
}

/** .loading-line, centered in what it fills. */
export function Loading(props: { label?: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: text.body, color: palette().muted }}>{props.label ?? "Loading…"}</Text>
    </View>
  );
}

/** An action's outcome, under what it relates to (.field-error, .field-notice): its error, else its notice. */
export function Feedback(props: { error?: string; notice?: string }) {
  return (
    <>
      <If when={props.error}>
        <Text role="alert" style={{ fontSize: text.caption, lineHeight: 18, color: palette().tones.danger.text }}>{props.error}</Text>
      </If>
      <If when={!props.error && props.notice}>
        <Text style={{ fontSize: text.caption, lineHeight: 18, color: palette().tones.success.text }}>{props.notice}</Text>
      </If>
    </>
  );
}

export function Small(props: { children?: JSX.Element; tone?: Tone; testID?: string; center?: boolean }) {
  return (
    <Text testID={props.testID}
      style={{ fontSize: text.small, lineHeight: 19, textAlign: props.center ? "center" : "auto", color: props.tone ? palette().tones[props.tone].text : palette().muted }}>
      {props.children}
    </Text>
  );
}

/** .menu-label: a small medium heading over a group, such as a picker's options. */
export function SectionLabel(props: { children: string; testID?: string }) {
  return (
    <Text testID={props.testID} style={{ fontSize: text.caption, fontWeight: weight.medium, color: palette().muted, numberOfLines: 1 }}>{props.children}</Text>
  );
}

/** .segmented: two or more choices side by side on a track, the chosen one raised. */
export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string; icon?: IconName }[]; onChange: (value: T) => void; testID?: string; small?: boolean }) {
  return (
    <View testID={props.testID} role="tablist" style={{ flexDirection: "row", alignSelf: "flex-start", gap: 2, padding: 2, borderRadius: radius.medium,
      borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surfaceRaised }}>
      <Each of={props.options} key={option => option.value}>
        {option => (
          <BaseButton role="tab" selected={props.value === option().value} onPress={() => props.onChange(option().value)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: props.small ? 8 : 12, height: props.small ? control.xsmall - 6 : control.small - 6,
              borderRadius: radius.small, backgroundColor: props.value === option().value ? palette().control : "transparent" }}
            hoverStyle={{ backgroundColor: props.value === option().value ? palette().control : palette().hover }}>
            <If when={option().icon}>{name => <Icon name={name()} size={14} color={props.value === option().value ? palette().text : palette().muted} />}</If>
            <Text style={{ fontSize: props.small ? text.small : text.body, color: props.value === option().value ? palette().text : palette().muted }}>{option().label}</Text>
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
  /** Shown, but can't be chosen (already configured, not connected). */
  disabled?: boolean;
}

/** One choice of a picker (.menu-item): its icon, label and hint, the current one checked. */
function OptionRow<T>(props: { option: Option<T>; selected: boolean }) {
  const color = () => (props.option.destructive ? palette().tones.danger.text : palette().text);
  return (
    <View style={{ flexDirection: "row", alignItems: props.option.hint ? "flex-start" : "center", gap: 8, flex: 1 }}>
      <If when={props.option.icon}>{name => <Icon name={name()} size={14} color={props.option.destructive ? color() : palette().muted} style={{ marginTop: props.option.hint ? 3 : 0 }} />}</If>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ fontSize: text.body, color: color(), numberOfLines: 1 }}>{props.option.label}</Text>
        <If when={props.option.hint}>
          <Text style={{ fontSize: text.caption, lineHeight: 17, color: palette().muted, numberOfLines: 4 }}>{props.option.hint}</Text>
        </If>
      </View>
      <View style={{ width: 14 }}>
        <If when={props.selected}><Icon name="check" size={14} color={palette().text} style={{ marginTop: props.option.hint ? 3 : 0 }} /></If>
      </View>
    </View>
  );
}

/**
 * A choice among options from a trigger (.popover of .menu-items): a menu at the trigger on the desktops and the web,
 * a sheet from the bottom on touch screens.
 */
export function Picker<T>(props: { trigger: JSX.Element; title: string; options: Option<T>[]; value?: T; onSelect: (value: T) => void; testID?: string; placement?: "top" | "bottom" }) {
  return (
    <Menu trigger={props.trigger} placement={props.placement ?? "top"} offset={4}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={{ minWidth: 240, maxWidth: 360, padding: 4, gap: 0, borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface,
        boxShadow: palette().shadow }}>
      <View testID={props.testID} style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4 }}>
        <SectionLabel>{props.title}</SectionLabel>
      </View>
      {/* A long list (a host's models) scrolls within the popup or sheet rather than running past the screen. */}
      <Scroll style={{ flexShrink: 1, maxHeight: 360 }} contentStyle={{ gap: 0 }}>
      <Each of={props.options} key="index">
        {option => (
          <MenuItem accessibilityLabel={option().label} disabled={option().disabled} onSelect={() => props.onSelect(option().value)} disabledStyle={{ opacity: 0.5 }}
            style={{ flexDirection: "row", alignItems: "center", minHeight: 32, paddingHorizontal: 8, paddingVertical: option().hint ? 6 : 0, borderRadius: radius.small,
              backgroundColor: props.value === option().value ? palette().hoverStrong : "transparent" }}
            hoverStyle={{ backgroundColor: palette().hoverStrong }} focusStyle={{ backgroundColor: palette().hoverStrong }} activeStyle={{ backgroundColor: palette().hoverStrong }}>
            <OptionRow option={option()} selected={props.value === option().value} />
          </MenuItem>
        )}
      </Each>
      </Scroll>
    </Menu>
  );
}

/**
 * A sheet of choices from the bottom edge, the current one marked (the web's phone sheet); for choices that have no
 * trigger of their own.
 */
export function OptionSheet<T>(props: { open: boolean; title: string; options: Option<T>[]; value?: T; onClose: () => void; onSelect: (value: T) => void; testID?: string }) {
  return (
    <Sheet open={props.open} side="bottom" closeOnSwipe onOpenChange={event => { if (!event.open) props.onClose(); }}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={{ backgroundColor: palette().surface, borderTopWidth: 1, borderColor: palette().border, borderTopLeftRadius: radius.large, borderTopRightRadius: radius.large,
        maxHeight: "90%", paddingBottom: 24, width: "100%", maxWidth: 560, alignSelf: "center" }}>
      <View testID={props.testID} style={{ gap: 4, paddingVertical: 12, paddingHorizontal: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingBottom: 4 }}>
          <Text style={{ flex: 1, fontSize: text.body, fontWeight: weight.medium, color: palette().text }}>{props.title}</Text>
          <Button small variant="ghost" label="Done" onPress={props.onClose} />
        </View>
        <Scroll style={{ flexShrink: 1 }}>
          <Each of={props.options} key="index">
            {option => (
              <BaseButton role="menuitem" selected={props.value === option().value} accessibilityLabel={option().label}
                onPress={() => { props.onClose(); props.onSelect(option().value); }}
                style={{ flexDirection: "row", alignItems: "center", minHeight: 40, paddingVertical: option().hint ? 8 : 0, paddingHorizontal: 8, borderRadius: radius.small,
                  backgroundColor: props.value === option().value ? palette().hoverStrong : "transparent" }}
                hoverStyle={{ backgroundColor: palette().hoverStrong }} activeStyle={{ backgroundColor: palette().hoverStrong }}>
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

/** Text that can be selected and copied, such as an ID. */
export function Value(props: { children?: JSX.Element; testID?: string; monospace?: boolean }) {
  return (
    <View selectable style={{ flexShrink: 1 }}>
      <Text testID={props.testID} style={{ fontSize: props.monospace ? text.small : text.body, fontFamily: props.monospace ? "monospace" : undefined, color: palette().text }}>{props.children}</Text>
    </View>
  );
}

/** The web app's identity colors (.identity): a workspace or person keeps one, from their ID. */
const identityColors = ["#5b7cfa", "#e06c4f", "#3fa37a", "#b56fd8", "#d39b2c", "#3e9bc2", "#d1577d", "#7a8c35", "#8a6bd1", "#c4703a"];

/** .identity: a workspace's or person's initial on a rounded square in their color. */
export function IdentityBadge(props: { name: string; id: string; size?: number }) {
  const size = () => props.size ?? 20;
  const color = () => {
    let hash = 0;
    for (const char of props.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return identityColors[hash % identityColors.length]!;
  };
  return (
    <View style={{ width: size(), height: size(), borderRadius: radius.small, alignItems: "center", justifyContent: "center", backgroundColor: color() }}>
      <Text style={{ fontSize: Math.round(size() * 0.55), fontWeight: weight.medium, color: "#ffffff" }}>{(Array.from(props.name.trim())[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

/** Pikibun's mark: its icon, rounded. */
export function Logo(props: { size?: number }) {
  const size = () => props.size ?? 20;
  return <Image src={logo} accessibilityLabel="Pikibun" style={{ width: size(), height: size(), borderRadius: size() * 0.28 }} />;
}

/** A hairline between parts. */
export function Divider(props: { vertical?: boolean }) {
  return <View style={props.vertical ? { width: 1, alignSelf: "stretch", backgroundColor: palette().border } : { height: 1, alignSelf: "stretch", backgroundColor: palette().border }} />;
}

export interface MenuAction {
  label: string;
  icon?: IconName;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  testID?: string;
  onSelect: () => void;
}

/** The popup (desktops, the web) or sheet (touch screens) of a menu of actions (.popover). */
const menuPopupStyle = () => ({ minWidth: 200, maxWidth: 360, padding: 4, borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border,
  backgroundColor: palette().surface, boxShadow: palette().shadow });

/** A menu's actions (.menu-item), "separator" a hairline between them (.menu-separator). */
function MenuActions(props: { items: (MenuAction | "separator")[] }) {
  return (
    <Each of={props.items} key="index">
      {item => (
        <If when={item() !== "separator" ? item() as MenuAction : null} else={<View style={{ height: 1, margin: 4, backgroundColor: palette().border }} />}>
          {action => (
            <MenuItem testID={action().testID} accessibilityLabel={action().label} disabled={action().disabled} onSelect={() => action().onSelect()}
              style={{ flexDirection: "row", alignItems: action().hint ? "flex-start" : "center", gap: 8, minHeight: 32, paddingHorizontal: 8,
                paddingVertical: action().hint ? 6 : 0, borderRadius: radius.small }}
              hoverStyle={{ backgroundColor: palette().hoverStrong }} focusStyle={{ backgroundColor: palette().hoverStrong }} disabledStyle={{ opacity: 0.5 }}>
              <If when={action().icon}>
                {name => <Icon name={name()} size={14} color={action().destructive ? palette().tones.danger.text : palette().muted} style={{ marginTop: action().hint ? 3 : 0 }} />}
              </If>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ fontSize: text.body, color: action().destructive ? palette().tones.danger.text : palette().text }}>{action().label}</Text>
                <If when={action().hint}><Text style={{ fontSize: text.caption, lineHeight: 17, color: palette().muted }}>{action().hint}</Text></If>
              </View>
            </MenuItem>
          )}
        </If>
      )}
    </Each>
  );
}

/** .popover of .menu-items for a small fixed set of actions (a row's kebab menu); "separator" draws a hairline. */
export function DropdownMenu(props: { label: string; items: (MenuAction | "separator")[]; icon?: IconName; trigger?: JSX.Element; testID?: string; placement?: "top" | "bottom" }) {
  return (
    <Menu placement={props.placement ?? "bottom"} align="end" offset={4} backdropStyle={{ backgroundColor: "transparent" }}
      trigger={props.trigger ?? <IconButton testID={props.testID} icon={props.icon ?? "more"} label={props.label} size={control.xsmall} onPress={() => undefined} />}
      popupStyle={menuPopupStyle()}>
      <MenuActions items={props.items} />
    </Menu>
  );
}

/**
 * The right-click menu of what it wraps (the web app's useContextMenu): the secondary button opens it where the pointer
 * is on the desktops and the web; a finger held on it opens it as a sheet on touch screens. `items` are made each time it
 * opens, so they say what can be done then; with none, nothing opens.
 */
export function RowMenu(props: { items: () => (MenuAction | "separator")[]; children: JSX.Element; testID?: string }) {
  return (
    <ContextMenu testID={props.testID} trigger={props.children} disabled={!props.items().some(item => item !== "separator")} offset={2}
      backdropStyle={{ backgroundColor: palette().backdrop }} popupStyle={menuPopupStyle()}>
      <MenuActions items={props.items()} />
    </ContextMenu>
  );
}

/**
 * .collapsible: a row of a section's card that opens in place to show more (a host's settings, an audit event);
 * `plain` draws it on its own, outside a card.
 */
export function CollapsibleRow(props: {
  title: string; hint?: JSX.Element; leading?: JSX.Element; trailing?: JSX.Element | string; children?: JSX.Element; open?: boolean; plain?: boolean; testID?: string;
  onToggle?: (open: boolean) => void;
}) {
  const open = signal(Boolean(props.open));
  const toggle = () => { open.update(value => !value); props.onToggle?.(open()); };
  return (
    <Collapsible testID={props.testID} open={open()} style={props.plain
      ? { borderWidth: 1, borderColor: palette().border, borderRadius: radius.large }
      : { borderTopWidth: 1, borderColor: palette().border }}
      content={<View style={{ gap: 12, paddingHorizontal: 16, paddingBottom: 16 }}>{props.children}</View>}>
      <BaseButton role="button" accessibilityLabel={props.title} onPress={toggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: props.plain ? 44 : 52, paddingVertical: 12, paddingHorizontal: 16 }}
        hoverStyle={{ backgroundColor: palette().hover }}>
        <If when={props.leading}>{props.leading}</If>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ fontSize: text.body, color: props.plain ? palette().muted : palette().text }}>{props.title}</Text>
          <If when={props.hint}><Text style={{ fontSize: text.small, lineHeight: 19, color: palette().muted }}>{props.hint}</Text></If>
        </View>
        <If when={props.trailing}>
          {typeof props.trailing === "string" ? <Text style={{ fontSize: text.body, color: palette().muted }}>{props.trailing}</Text> : props.trailing}
        </If>
        <Icon name={open() ? "chevron-down" : "chevron-right"} size={16} color={palette().muted} />
      </BaseButton>
    </Collapsible>
  );
}

/** A ghost button that copies `value`, and says so for a moment. */
export function CopyButton(props: { value: string; label?: string; testID?: string }) {
  const copied = signal(false);
  async function copy() {
    await Clipboard.writeText(props.value).catch(() => undefined);
    copied.set(true);
    setTimeout(() => copied.set(false), 1500);
  }
  return <IconButton testID={props.testID} icon={copied() ? "check" : "copy"} label={copied() ? "Copied" : props.label ?? "Copy"} size={control.xsmall} onPress={() => void copy()} />;
}

/** .copy-field: a command or secret to copy, selectable for copying by hand too. */
export function CopyField(props: { value: string; label?: string; testID?: string }) {
  return (
    <View testID={props.testID} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4, paddingRight: 4, paddingLeft: 12, borderWidth: 1,
      borderColor: palette().border, borderRadius: radius.medium, backgroundColor: palette().code }}>
      <View selectable style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontFamily: "monospace", fontSize: text.small, color: palette().text }}>{props.value}</Text>
      </View>
      <CopyButton value={props.value} label={props.label} />
    </View>
  );
}

/** .info-tip: an info icon beside a section's title that opens a short note. */
export function InfoTip(props: { children?: JSX.Element; label?: string }) {
  return (
    <Popover placement="bottom" offset={4} closeOnPressOutside
      trigger={<BaseButton accessibilityLabel={props.label ?? "More information"} hitSlop={6}
        style={{ width: 20, height: 20, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" }} hoverStyle={{ backgroundColor: palette().hover }}>
        <Icon name="info" size={14} color={palette().muted} />
      </BaseButton>}
      popupStyle={{ width: 320, maxWidth: "90%", padding: 12, gap: 8, borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border,
        backgroundColor: palette().surface, boxShadow: palette().shadow }}>
      {typeof props.children === "string" ? <Text style={{ fontSize: text.small, lineHeight: 20, color: palette().muted }}>{props.children}</Text> : props.children}
    </Popover>
  );
}

/** Text in an info tip or a sheet: muted, readable. */
export function Note(props: { children?: JSX.Element; testID?: string }) {
  return <Text testID={props.testID} style={{ fontSize: text.small, lineHeight: 20, color: palette().muted }}>{props.children}</Text>;
}

/**
 * dialog.sheet: a focused task over a backdrop, its title and close button, its content scrolling, and its buttons at
 * the end of a footer. A centered card where there is room; on phones it rises from the bottom edge.
 */
export function FormSheet(props: { open: boolean; title: string; onClose: () => void; children?: JSX.Element; footer?: JSX.Element; wide?: boolean; testID?: string }) {
  const phone = () => windowSize().width > 0 && windowSize().width <= 600;
  const body = () => (
    <View testID={props.testID} style={{ flexShrink: 1, maxHeight: "100%" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: phone() ? 12 : 16, paddingHorizontal: phone() ? 16 : 20 }}>
        <Text role="header" style={{ flex: 1, fontSize: text.body, fontWeight: weight.medium, color: palette().text }}>{props.title}</Text>
        <IconButton icon="x" label="Close" onPress={props.onClose} />
      </View>
      <Scroll style={{ flexShrink: 1 }} contentStyle={{ gap: 16, paddingHorizontal: phone() ? 16 : 20, paddingBottom: phone() ? 16 : 20 }}>{props.children}</Scroll>
      <If when={props.footer}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, paddingVertical: 12, paddingHorizontal: phone() ? 16 : 20,
          paddingBottom: phone() ? 24 : 12, borderTopWidth: 1, borderColor: palette().border }}>{props.footer}</View>
      </If>
    </View>
  );
  return (
    <If when={phone()}
      else={
        <Dialog open={props.open} animation="fade" onOpenChange={event => { if (!event.open) props.onClose(); }} backdropStyle={{ backgroundColor: palette().backdrop }}
          style={{ alignSelf: "center", marginVertical: "auto", width: props.wide ? 720 : 520, maxWidth: "94%", maxHeight: "85%", borderRadius: radius.large, borderWidth: 1,
            borderColor: palette().border, backgroundColor: palette().surface, boxShadow: palette().shadow, overflow: "hidden" }}>
          {body()}
        </Dialog>
      }>
      <Sheet open={props.open} side="bottom" closeOnSwipe onOpenChange={event => { if (!event.open) props.onClose(); }} backdropStyle={{ backgroundColor: palette().backdrop }}
        popupStyle={{ width: "100%", maxHeight: "90%", borderTopWidth: 1, borderColor: palette().border, borderTopLeftRadius: radius.large, borderTopRightRadius: radius.large,
          backgroundColor: palette().surface }}>
        {body()}
      </Sheet>
    </If>
  );
}

/** A loaded resource's content, its loading line while it loads, or its error with a way to try again. */
export function ResourceState(props: { loading: boolean; error: string; retry: () => void; children?: JSX.Element; inline?: boolean }) {
  return (
    <If when={!props.loading} else={<Text style={{ fontSize: text.body, color: palette().muted, padding: props.inline ? 0 : 16 }}>Loading…</Text>}>
      <If when={!props.error} else={<Banner tone="danger" title="Couldn't load" actions={<Button small variant="outline" label="Try again" onPress={props.retry} />}>{props.error}</Banner>}>
        {props.children}
      </If>
    </If>
  );
}
