import { Scroll, type Accessor, type JSX } from "nsh";
import type { PageRoute } from "../lib/page";
import type { SessionRecord, SessionView } from "../shared";
import { EmptyState } from "../ui";

/** What every tab of a session's panel is given; `session` and `view` follow the live session. */
export interface PanelTabProps {
  sessionId: string;
  session: Accessor<SessionRecord | null>;
  view: Accessor<SessionView | null>;
  /** Reloads the live session now (after a change the tab made). */
  refresh: () => void;
  /** Goes elsewhere in the app, as a link would: another session, a settings section. */
  go: (route: PageRoute) => void;
}

export function TabPage(props: { children?: JSX.Element; testID?: string }) {
  return (
    <Scroll testID={props.testID} style={{ flex: 1 }} contentStyle={{ gap: 12, padding: 16 }}>
      {props.children}
    </Scroll>
  );
}

/** A part of the web app's session panel this client doesn't have yet; each is ported into its own tab file. */
export function NotYetHere(props: { what: string }) {
  return <EmptyState title="Not here yet">{`${props.what} is still being moved to this app.`}</EmptyState>;
}
