import { Scroll, type JSX } from "nsh";
import type { PageRoute } from "../lib/page";
import { EmptyState } from "../ui";

/** What every settings section is given. */
export interface SectionProps {
  /** The item the address names within the section (`#/settings/hosts/<id>`): a host, a workspace. */
  id?: string;
  /** Goes to another place in the app, as a link would: another section or item, a session. */
  go: (route: PageRoute) => void;
}

/** A section's scrolling column, as wide as settings read best. */
export function SectionPage(props: { children?: JSX.Element; testID?: string }) {
  return (
    <Scroll testID={props.testID} style={{ flex: 1 }} contentStyle={{ gap: 10, paddingHorizontal: 24, paddingVertical: 20, width: "100%", maxWidth: 680, alignSelf: "center" }}>
      {props.children}
    </Scroll>
  );
}

/** A part of the web app's settings this client doesn't have yet; each is ported into its own section file. */
export function NotYetHere(props: { what: string }) {
  return (
    <EmptyState icon="clock" title="Coming to this app">
      {`${props.what} isn't in this app yet.`}
    </EmptyState>
  );
}
