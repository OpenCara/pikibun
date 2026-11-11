import { Clipboard, computed, createAnimatedValue, effect, Image, platform, Scroll, signal, Text, untracked, View, windowSize, type JSX, type PanEvent, type ViewStyle } from "nsh";
import { AlertDialog, Button as BaseButton, Collapsible, ContextMenu, Dialog, Menu, MenuItem, Popover, Sheet, Tooltip } from "nsh/base";
import logo from "./assets/logo.png";
import { Icon, type IconName } from "./icons";
import { control, palette, radius, text, weight, type Tone } from "./theme";

/** A phone's window, or one as narrow: at most 600 points wide. */
export const phoneWidth = () => windowSize().width > 0 && windowSize().width <= 600;

type ButtonVariant = "primary" | "default" | "outline" | "ghost" | "danger" | "accent";

export function Button(props: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  small?: boolean;
  large?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
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

export function StatusDot(props: { tone?: Tone; testID?: string; label?: string }) {
  return (
    <View testID={props.testID} accessibilityLabel={props.label}
      style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: palette().dots[props.tone ?? "neutral"] }} />
  );
}

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

export function Card(props: { children?: JSX.Element; testID?: string; style?: ViewStyle }) {
  return (
    <View testID={props.testID} style={{ gap: 12, borderRadius: radius.large, borderWidth: 1, padding: 16, borderColor: palette().border, backgroundColor: palette().surface, ...props.style }}>
      {props.children}
    </View>
  );
}

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
          <View style={{ marginTop: -1 }}>{props.children}</View>
        </View>
      </If>
    </View>
  );
}

export function CardBody(props: { children?: JSX.Element; testID?: string }) {
  return <View testID={props.testID} style={{ gap: 12, padding: 16, borderTopWidth: 1, borderColor: palette().border }}>{props.children}</View>;
}

export function Row(props: { title: string; hint?: JSX.Element; leading?: JSX.Element; trailing?: JSX.Element | string; onPress?: () => void; chevron?: boolean; testID?: string; hintTestID?: string; selectableHint?: boolean }) {
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

export function Chip(props: {
  label: string; icon?: IconName; onPress?: () => void; disabled?: boolean; tone?: Tone; testID?: string; bordered?: boolean; small?: boolean; expanded?: boolean; maxWidth?: number;
  /** Tighter padding and a smaller chevron, for a row of them that has to fit on one line of a phone. */
  dense?: boolean;
}) {
  const color = () => (props.tone ? palette().tones[props.tone].text : palette().muted);
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} disabled={props.disabled} onPress={() => props.onPress?.()}
      selected={props.expanded}
      style={{ flexDirection: "row", alignItems: "center", gap: props.dense ? 3 : props.icon ? 4 : 8, borderRadius: radius.small, paddingHorizontal: props.dense ? 6 : props.small ? 8 : 12,
        height: props.small ? control.xsmall : control.small, flexShrink: 1, maxWidth: props.maxWidth ?? 260,
        borderWidth: 1, borderColor: props.bordered ? palette().borderStrong : "transparent",
        backgroundColor: props.tone ? palette().tones[props.tone].background : "transparent" }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.8 }} disabledStyle={{ opacity: 0.5 }}>
      <If when={props.icon}>{name => <Icon name={name()} size={14} color={color()} />}</If>
      <Text style={{ fontSize: props.small ? text.small : text.body, color: color(), numberOfLines: 1, flexShrink: 1 }}>{props.label}</Text>
      <If when={!props.disabled}>
        <Icon name={props.expanded === false ? "chevron-right" : "chevron-down"} size={props.small || props.dense ? 12 : 14} color={color()} />
      </If>
    </BaseButton>
  );
}

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

export function Loading(props: { label?: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: text.body, color: palette().muted }}>{props.label ?? "Loading…"}</Text>
    </View>
  );
}

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

export function SectionLabel(props: { children: string; testID?: string }) {
  return (
    <Text testID={props.testID} style={{ fontSize: text.caption, fontWeight: weight.medium, color: palette().muted, numberOfLines: 1 }}>{props.children}</Text>
  );
}

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
  disabled?: boolean;
}

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

export function Picker<T>(props: { trigger: JSX.Element; title: string; options: Option<T>[]; value?: T; onSelect: (value: T) => void; testID?: string; placement?: "top" | "bottom" }) {
  return (
    <Menu trigger={props.trigger} placement={props.placement ?? "top"} offset={4}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={{ minWidth: 240, maxWidth: 360, padding: 4, gap: 0, borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface,
        boxShadow: palette().shadow }}>
      <View testID={props.testID} style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4 }}>
        <SectionLabel>{props.title}</SectionLabel>
      </View>
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

export function Value(props: { children?: JSX.Element; testID?: string; monospace?: boolean }) {
  return (
    <View selectable style={{ flexShrink: 1 }}>
      <Text testID={props.testID} style={{ fontSize: props.monospace ? text.small : text.body, fontFamily: props.monospace ? "monospace" : undefined, color: palette().text }}>{props.children}</Text>
    </View>
  );
}

const identityColors = ["#5b7cfa", "#e06c4f", "#3fa37a", "#b56fd8", "#d39b2c", "#3e9bc2", "#d1577d", "#7a8c35", "#8a6bd1", "#c4703a"];

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

export function Logo(props: { size?: number }) {
  const size = () => props.size ?? 20;
  return <Image src={logo} accessibilityLabel="Pikibun" style={{ width: size(), height: size(), borderRadius: size() * 0.28 }} />;
}

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

const menuPopupStyle = () => ({ minWidth: 200, maxWidth: 360, padding: 4, borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border,
  backgroundColor: palette().surface, boxShadow: palette().shadow });

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

export function DropdownMenu(props: { label: string; items: (MenuAction | "separator")[]; icon?: IconName; trigger?: JSX.Element; testID?: string; placement?: "top" | "bottom" }) {
  return (
    <Menu placement={props.placement ?? "bottom"} align="end" offset={4} backdropStyle={{ backgroundColor: "transparent" }}
      trigger={props.trigger ?? <IconButton testID={props.testID} icon={props.icon ?? "more"} label={props.label} size={control.xsmall} onPress={() => undefined} />}
      popupStyle={menuPopupStyle()}>
      <MenuActions items={props.items} />
    </Menu>
  );
}

/** A row's right-click menu, which a finger held on the row opens as a sheet on touch screens. `open` and `onOpenChange` control it, to open it from
 * elsewhere too (a swiped row's More). */
export function RowMenu(props: {
  items: () => (MenuAction | "separator")[]; children: JSX.Element; testID?: string; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  return (
    <ContextMenu testID={props.testID} trigger={props.children} disabled={!props.items().some(item => item !== "separator")} offset={2}
      open={props.open} onOpenChange={event => props.onOpenChange?.(event.open)}
      backdropStyle={{ backgroundColor: palette().backdrop }} popupStyle={menuPopupStyle()}>
      <MenuActions items={props.items()} />
    </ContextMenu>
  );
}

/** An action behind a `SwipeRow`: a tile with its icon and label. */
export interface SwipeAction {
  label: string;
  icon: IconName;
  /** Its tile's color: a tone's, the accent's, or the neutral control's (the default). */
  tone?: Tone | "accent";
  disabled?: boolean;
  testID?: string;
  onPress: () => void;
}

/** Whether rows slide sideways under a finger to show actions: on phones, tablets and the web, not on the desktops, whose mouse
 * opens the rows' right-click menus instead. */
export const swipesRows = !platform.desktop;

const swipeTileWidth = 72;

function swipeColors(tone: SwipeAction["tone"]): { background: string; text: string } {
  const p = palette();
  if (tone === "accent") return { background: p.accent, text: p.onAccent };
  if (!tone || tone === "neutral") return { background: p.control, text: p.text };
  // A status color is dark on the light theme and light on the dark ones: the page's own background reads on it in each.
  return { background: p.tones[tone].text, text: p.background };
}

function SwipeTile(props: { action: SwipeAction; dense?: boolean; onPress: () => void }) {
  const colors = () => swipeColors(props.action.tone);
  return (
    <BaseButton testID={props.action.testID} accessibilityLabel={props.action.label} disabled={props.action.disabled} onPress={props.onPress}
      style={{ width: swipeTileWidth, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 4, backgroundColor: colors().background }}
      activeStyle={{ opacity: 0.8 }} disabledStyle={{ opacity: 0.5 }}>
      <Icon name={props.action.icon} size={props.dense ? 16 : 18} color={colors().text} />
      <If when={!props.dense}>
        <Text style={{ fontSize: text.caption, color: colors().text, numberOfLines: 1 }}>{props.action.label}</Text>
      </If>
    </BaseButton>
  );
}

/**
 * A row that slides sideways under a finger to show actions behind it, as mail and chat apps' lists do: dragged left it shows
 * `trailing` at its right edge, dragged right `leading` at its left. Let go past half of them (or flung) it stays open, else it
 * springs back. A tile runs its action and closes the row. `open` and `onOpenChange` let a list keep one row open at a time:
 * setting `open` false closes it. The drag only takes horizontal moves, so the list around it still scrolls; on the desktops
 * (`swipesRows`) the row stays put.
 */
export function SwipeRow(props: {
  leading?: SwipeAction[]; trailing?: SwipeAction[]; open: boolean; onOpenChange: (open: boolean) => void;
  /** The row's backdrop while it slides, over the tiles: the list's background. */
  background: string;
  /** Icon-only tiles, for short rows. */
  dense?: boolean;
  testID?: string;
  children: JSX.Element;
}) {
  // The offset is where the row rests (0, the leading tiles' width, or minus the trailing ones'); a drag moves the value by its
  // translation, and a settle springs the value back to 0 with the offset at its new rest.
  const x = createAnimatedValue(0);
  const revealed = signal(false);
  let rest = 0;
  let moves = 0;
  const leading = () => props.leading ?? [];
  const trailing = () => props.trailing ?? [];
  const leadingWidth = () => leading().length * swipeTileWidth;
  const trailingWidth = () => trailing().length * swipeTileWidth;
  const enabled = () => swipesRows && leadingWidth() + trailingWidth() > 0;
  // Past its tiles the row gives a little, then stops.
  const track = computed(() => {
    const low = -trailingWidth();
    const high = leadingWidth();
    return x.interpolate({ inputRange: [low - 120, low, high, high + 120], outputRange: [low - 24, low, high, high + 24], extrapolate: "clamp" });
  });
  const leadingOpacity = x.interpolate({ inputRange: [0, 8], outputRange: [0, 1], extrapolate: "clamp" });
  const trailingOpacity = x.interpolate({ inputRange: [-8, 0], outputRange: [1, 0], extrapolate: "clamp" });

  function settle(target: number, from: number, velocity = 0) {
    const move = ++moves;
    rest = target;
    x.setOffset(target);
    x.set(from - target);
    if (target !== 0) revealed.set(true);
    void x.spring(0, { stiffness: 380, damping: 38, velocity }).then(() => { if (move === moves && rest === 0) revealed.set(false); });
    if ((target !== 0) !== untracked(() => props.open)) props.onOpenChange(target !== 0);
  }
  function start() {
    moves++;
    void x.stop();
    revealed.set(true);
  }
  function end(event: PanEvent) {
    const from = rest + event.translation.x;
    const velocity = event.velocity.x;
    const trailingOpen = -trailingWidth();
    const leadingOpen = leadingWidth();
    let target = 0;
    if (event.cancelled) target = 0;
    else if (from < 0 && trailingOpen < 0 && (from < trailingOpen / 2 ? velocity < 600 : velocity < -400)) target = trailingOpen;
    else if (from > 0 && leadingOpen > 0 && (from > leadingOpen / 2 ? velocity > -600 : velocity > 400)) target = leadingOpen;
    settle(target, from, velocity);
  }
  effect(() => {
    if (!props.open && untracked(() => rest !== 0)) settle(0, rest);
  });
  const run = (action: SwipeAction) => {
    settle(0, rest);
    action.onPress();
  };

  return (
    <View testID={props.testID} style={{ overflow: "hidden", borderRadius: radius.medium }}>
      <If when={enabled() && revealed()}>
        <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", opacity: leadingOpacity }}>
            <Each of={leading()} key="index">{action => <SwipeTile action={action()} dense={props.dense} onPress={() => run(action())} />}</Each>
          </View>
          <View style={{ flexDirection: "row", opacity: trailingOpacity }}>
            <Each of={trailing()} key="index">{action => <SwipeTile action={action()} dense={props.dense} onPress={() => run(action())} />}</Each>
          </View>
        </View>
      </If>
      <View pan={enabled() ? { x } : undefined} panActivation={enabled() ? { activeOffsetX: 12, failOffsetY: 12 } : undefined}
        onPanStart={enabled() ? start : undefined} onPanEnd={enabled() ? end : undefined}
        style={{ backgroundColor: enabled() ? props.background : undefined, transform: [{ translateX: enabled() ? track() : 0 }] }}>
        {props.children}
      </View>
    </View>
  );
}

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

export function CopyButton(props: { value: string; label?: string; testID?: string }) {
  const copied = signal(false);
  async function copy() {
    await Clipboard.writeText(props.value).catch(() => undefined);
    copied.set(true);
    setTimeout(() => copied.set(false), 1500);
  }
  return <IconButton testID={props.testID} icon={copied() ? "check" : "copy"} label={copied() ? "Copied" : props.label ?? "Copy"} size={control.xsmall} onPress={() => void copy()} />;
}

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

export function Note(props: { children?: JSX.Element; testID?: string }) {
  return <Text testID={props.testID} style={{ fontSize: text.small, lineHeight: 20, color: palette().muted }}>{props.children}</Text>;
}

export function FormSheet(props: { open: boolean; title: string; onClose: () => void; children?: JSX.Element; footer?: JSX.Element; wide?: boolean; testID?: string }) {
  const phone = phoneWidth;
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

export function ResourceState(props: { loading: boolean; error: string; retry: () => void; children?: JSX.Element; inline?: boolean }) {
  return (
    <If when={!props.loading} else={<Text style={{ fontSize: text.body, color: palette().muted, padding: props.inline ? 0 : 16 }}>Loading…</Text>}>
      <If when={!props.error} else={<Banner tone="danger" title="Couldn't load" actions={<Button small variant="outline" label="Try again" onPress={props.retry} />}>{props.error}</Banner>}>
        {props.children}
      </If>
    </If>
  );
}
