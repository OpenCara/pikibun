import { cleanup, createAnimatedValue, platform, Scroll, View, windowSize, type Accessor, type JSX, type PanEvent } from "nsh";
import type { PageRoute } from "../lib/page";
import type { SessionRecord, SessionView } from "../shared";
import { EmptyState } from "../ui";

export interface PanelTabProps {
  sessionId: string;
  session: Accessor<SessionRecord | null>;
  view: Accessor<SessionView | null>;
  refresh: () => void;
  go: (route: PageRoute) => void;
  expanded?: Accessor<boolean>;
  setExpanded?: (expanded: boolean) => void;
  backs?: PanelBacks;
}

export const compactPanelWidth = 700;
export const compactPanel = () => windowSize().width > 0 && windowSize().width < compactPanelWidth;

export const swipesBack = !platform.desktop;
const swipeBackDistance = 96;
const swipeBackFling = 800;
const swipeBackFlingDistance = 32;

export function swipedBack(event: Pick<PanEvent, "cancelled" | "translation" | "velocity">): boolean {
  return !event.cancelled && event.translation.x > 0 && (event.translation.x >= swipeBackDistance || (event.translation.x >= swipeBackFlingDistance && event.velocity.x >= swipeBackFling));
}

export interface PanelBacks {
  add(handler: () => boolean): void;
  back(): boolean;
}

export function createPanelBacks(): PanelBacks {
  const handlers: (() => boolean)[] = [];
  return {
    add(handler) {
      handlers.push(handler);
      cleanup(() => { const at = handlers.indexOf(handler); if (at >= 0) handlers.splice(at, 1); });
    },
    back() {
      for (let index = handlers.length - 1; index >= 0; index--) if (handlers[index]!()) return true;
      return false;
    },
  };
}

export function SwipeBack(props: { onBack?: () => void; edge?: boolean; testID?: string; children?: JSX.Element }) {
  if (!swipesBack) return props.children;
  const x = createAnimatedValue(0);
  const shift = x.interpolate({ inputRange: [0, 1200], outputRange: [0, 1200], extrapolate: "clamp" });
  const active = () => swipesBack && Boolean(props.onBack);
  function end(event: PanEvent) {
    if (!active()) return;
    if (swipedBack(event)) {
      x.set(0);
      props.onBack?.();
    } else void x.spring(0, { stiffness: 380, damping: 38, velocity: event.velocity.x });
  }
  const activation = { activeOffsetX: 16, failOffsetY: 12 };
  return (
    <View testID={props.testID} style={{ flex: 1, overflow: "hidden" }}>
      <View pan={active() ? { x } : undefined} panActivation={activation} onPanEnd={end} style={{ flex: 1, transform: [{ translateX: active() ? shift : 0 }] }}>
        {props.children}
      </View>
      <If when={active() && props.edge}>
        <View accessible={false} pan={{ x }} panActivation={activation} onPanEnd={end}
          style={{ position: "absolute", left: 0, top: 56, bottom: 56, width: 16 }} />
      </If>
    </View>
  );
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
