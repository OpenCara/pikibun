import { platform, Text, View, type JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { palette } from "../theme";

/** The app draws its pages' headers on the desktops and the web; iOS and Android show their system header. */
export const drawsHeaders = platform.desktop || platform.os === "web";

/** A page's header props: the app's own header where it draws one, the system header's items elsewhere. */
export function headerProps(options: { title: string; onBack?: () => void; actions?: JSX.Element; leading?: JSX.Element }) {
  return drawsHeaders
    ? { header: <PageHeader title={options.title} onBack={options.onBack} actions={options.actions} leading={options.leading} /> }
    : { headerLeft: options.leading, headerRight: options.actions };
}

/**
 * A page's header on the desktops and the web, which have no system header (iOS and Android show their own, from the
 * page's title and header items): a back button, the title and the page's actions.
 */
export function PageHeader(props: { title: string; onBack?: () => void; actions?: JSX.Element; leading?: JSX.Element }) {
  return (
    <View desktop={{ windowDrag: true }} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 52, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
      <If when={props.onBack}>
        <BaseButton testID="header-back" accessibilityLabel="Back" onPress={() => props.onBack?.()} hitSlop={8}
          style={{ paddingHorizontal: 6, paddingVertical: 6, borderRadius: 8 }} activeStyle={{ opacity: 0.6 }}>
          <Text style={{ fontSize: 17, color: palette().text }}>‹ Back</Text>
        </BaseButton>
      </If>
      {props.leading}
      <Text role="header" style={{ flex: 1, numberOfLines: 1, fontSize: 17, fontWeight: "700", color: palette().text }}>{props.title}</Text>
      {props.actions}
    </View>
  );
}
