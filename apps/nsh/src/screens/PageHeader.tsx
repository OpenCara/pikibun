import { platform, Text, View, type JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon } from "../icons";
import { palette, radius, text } from "../theme";

/** The app draws its pages' headers on the desktops and the web; iOS and Android show their system header. */
export const drawsHeaders = platform.desktop || platform.os === "web";

/**
 * A stack page's own background. Pages are transparent by default, so one pushed over another showed the page under it
 * through its content, while it slid in and after.
 */
export const pageStyle = () => ({ backgroundColor: palette().background });

/** A page's header props, with its background: the app's own header where it draws one, the system header's items elsewhere. */
export function headerProps(options: { title: string; subtitle?: string; onBack?: () => void; actions?: JSX.Element; leading?: JSX.Element }) {
  return drawsHeaders
    ? { style: pageStyle(), header: <PageHeader title={options.title} subtitle={options.subtitle} onBack={options.onBack} actions={options.actions} leading={options.leading} /> }
    : { style: pageStyle(), headerLeft: options.leading, headerRight: options.actions };
}

/** The back button of a page's header. */
export function BackButton(props: { onPress: () => void; label?: string }) {
  return (
    <BaseButton testID="header-back" accessibilityLabel={props.label ?? "Back"} onPress={props.onPress} hitSlop={8}
      style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 8, height: 32, borderRadius: radius.medium }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.6 }}>
      <Icon name="chevron-left" size={18} color={palette().muted} />
      <Text style={{ fontSize: text.body, color: palette().muted }}>{props.label ?? "Back"}</Text>
    </BaseButton>
  );
}

/**
 * A page's header on the desktops and the web, which have no system header (iOS and Android show their own, from the
 * page's title and header items): a back button, the title with what it belongs to, and the page's actions.
 */
export function PageHeader(props: { title: string; subtitle?: string; onBack?: () => void; actions?: JSX.Element; leading?: JSX.Element; testID?: string }) {
  return (
    <View testID={props.testID} desktop={{ windowDrag: true }}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 52, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: palette().border, backgroundColor: palette().background }}>
      <If when={props.onBack}>
        <BackButton onPress={() => props.onBack?.()} />
      </If>
      {props.leading}
      <View style={{ flex: 1, gap: 1, paddingLeft: props.onBack || props.leading ? 0 : 4 }}>
        <Text role="header" style={{ numberOfLines: 1, fontSize: text.title, fontWeight: "600", color: palette().text }}>{props.title}</Text>
        <If when={props.subtitle}>
          <Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>{props.subtitle}</Text>
        </If>
      </View>
      {props.actions}
    </View>
  );
}
