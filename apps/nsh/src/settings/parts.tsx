import { Scroll, View, type JSX } from "nsh";
import type { PageRoute } from "../lib/page";
import { layout } from "../theme";
import type { Action } from "../lib/resource";
import { Button, EmptyState, Feedback } from "../ui";

export interface SectionProps {
  id?: string;
  go: (route: PageRoute) => void;
}

export function SectionPage(props: { children?: JSX.Element; testID?: string }) {
  return (
    <Scroll testID={props.testID} style={{ flex: 1 }}
      contentStyle={{ gap: 32, paddingHorizontal: 24, paddingTop: 32, paddingBottom: 48, width: "100%", maxWidth: layout.content, alignSelf: "center" }}>
      {props.children}
    </Scroll>
  );
}

export function NotYetHere(props: { what: string }) {
  return (
    <EmptyState title="Coming to this app">
      {`${props.what} isn't in this app yet.`}
    </EmptyState>
  );
}

export function SettingsActions(props: { action: Action; label: string; onPress: () => void; testID?: string; disabled?: boolean }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <View style={{ flex: 1, minWidth: 160 }}><Feedback error={props.action.error()} notice={props.action.notice()} /></View>
      <Button testID={props.testID} variant="primary" label={props.label} disabled={props.action.busy() || props.disabled} onPress={props.onPress} />
    </View>
  );
}
