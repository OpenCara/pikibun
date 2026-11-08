import { Scroll, View, type JSX } from "nsh";
import type { PageRoute } from "../lib/page";
import { layout } from "../theme";
import type { Action } from "../lib/resource";
import { Button, EmptyState, Feedback } from "../ui";

/** What every settings section is given. */
export interface SectionProps {
  /** The item the address names within the section (`#/settings/hosts/<id>`): a host, a workspace. */
  id?: string;
  /** Goes to another place in the app, as a link would: another section or item, a session. */
  go: (route: PageRoute) => void;
}

/** A section's scrolling column, as wide as settings read best (the web's .content-column). */
export function SectionPage(props: { children?: JSX.Element; testID?: string }) {
  return (
    <Scroll testID={props.testID} style={{ flex: 1 }}
      contentStyle={{ gap: 32, paddingHorizontal: 24, paddingTop: 32, paddingBottom: 48, width: "100%", maxWidth: layout.content, alignSelf: "center" }}>
      {props.children}
    </Scroll>
  );
}

/** A part of the web app's settings this client doesn't have yet; each is ported into its own section file. */
export function NotYetHere(props: { what: string }) {
  return (
    <EmptyState title="Coming to this app">
      {`${props.what} isn't in this app yet.`}
    </EmptyState>
  );
}

/** .settings-actions: a form's outcome beside its one accent button, under its sections. */
export function SettingsActions(props: { action: Action; label: string; onPress: () => void; testID?: string; disabled?: boolean }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <View style={{ flex: 1, minWidth: 160 }}><Feedback error={props.action.error()} notice={props.action.notice()} /></View>
      <Button testID={props.testID} variant="primary" label={props.label} disabled={props.action.busy() || props.disabled} onPress={props.onPress} />
    </View>
  );
}
