import { platform, safeArea, Text, View, type JSX } from "nsh";
import { Button as BaseButton, NavPage } from "nsh/base";
import { Icon } from "../icons";
import { palette, radius, text, weight } from "../theme";

export const drawsHeaders = platform.desktop || platform.os === "web";

export const headerInPage = platform.os === "ios";

export const pageStyle = () => ({ backgroundColor: palette().background });

export function headerProps(options: { title: string; subtitle?: string; onBack?: () => void; actions?: JSX.Element; leading?: JSX.Element }) {
  return drawsHeaders
    ? { style: pageStyle(), header: <PageHeader title={options.title} subtitle={options.subtitle} onBack={options.onBack} actions={options.actions} leading={options.leading} /> }
    : { style: pageStyle(), headerLeft: options.leading, headerRight: options.actions };
}

export function InPageHeader(props: { children?: JSX.Element }) {
  return (
    <View style={{ flex: 1, paddingTop: safeArea().top, backgroundColor: palette().background }}>
      {props.children}
    </View>
  );
}

export function Page(props: { title: string; subtitle?: string; onBack?: () => void; actions?: JSX.Element; leading?: JSX.Element; testID?: string; children?: JSX.Element }) {
  if (!headerInPage) {
    return <NavPage title={props.title} {...headerProps(props)}>{props.children}</NavPage>;
  }
  return (
    <NavPage title={props.title} headerVisible={false} style={pageStyle()}>
      <InPageHeader>
        <PageHeader title={props.title} subtitle={props.subtitle} onBack={props.onBack} actions={props.actions} leading={props.leading} testID={props.testID} />
        <View style={{ flex: 1 }}>{props.children}</View>
      </InPageHeader>
    </NavPage>
  );
}

export function BackButton(props: { onPress: () => void; label?: string }) {
  return (
    <BaseButton testID="header-back" accessibilityLabel={props.label ?? "Back"} onPress={props.onPress} hitSlop={8}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 4, paddingRight: 8, height: 28, marginLeft: -4, borderRadius: radius.small }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
      <Icon name="chevron-left" size={16} color={palette().muted} />
      <Text style={{ fontSize: text.small, color: palette().muted }}>{props.label ?? "Back"}</Text>
    </BaseButton>
  );
}

export function PageHeader(props: { title: string; subtitle?: string; onBack?: () => void; actions?: JSX.Element; leading?: JSX.Element; testID?: string }) {
  return (
    <View testID={props.testID} desktop={{ windowDrag: true }}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingLeft: 16, paddingRight: 12, borderBottomWidth: 1, borderColor: palette().border,
        backgroundColor: palette().background }}>
      <If when={props.onBack}>
        <BackButton onPress={() => props.onBack?.()} />
      </If>
      {props.leading}
      <View style={{ flex: 1, flexDirection: "row", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <Text role="header" style={{ flexShrink: 1, numberOfLines: 1, fontSize: text.title, fontWeight: weight.light, color: palette().text }}>{props.title}</Text>
        <If when={props.subtitle}>
          <Text style={{ flexShrink: 2, numberOfLines: 1, fontSize: text.body, color: palette().muted }}>{props.subtitle}</Text>
        </If>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>{props.actions}</View>
    </View>
  );
}
