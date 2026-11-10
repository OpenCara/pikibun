import { Scroll, type Accessor, type JSX } from "nsh";
import type { PageRoute } from "../lib/page";
import type { SessionRecord, SessionView } from "../shared";
import { EmptyState } from "../ui";

export interface PanelTabProps {
  sessionId: string;
  session: Accessor<SessionRecord | null>;
  view: Accessor<SessionView | null>;
  refresh: () => void;
  go: (route: PageRoute) => void;
}

export function TabPage(props: { children?: JSX.Element; testID?: string }) {
  return (
    <Scroll testID={props.testID} style={{ flex: 1 }} contentStyle={{ gap: 24, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}>
      {props.children}
    </Scroll>
  );
}

export function NotYetHere(props: { what: string }) {
  return <EmptyState title="Coming to this app">{`${props.what} isn't in this app yet.`}</EmptyState>;
}
