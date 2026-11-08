import { Scroll, signal, View, windowSize, type JSX } from "nsh";
import { Sheet } from "nsh/base";
import { palette, radius } from "../theme";
import { IconButton, Segmented } from "../ui";
import { Browser } from "./Browser";
import { Connections } from "./Connections";
import { Files } from "./Files";
import { Overview } from "./Overview";
import type { PanelTabProps } from "./parts";
import { Schedules } from "./Schedules";
import { Sharing } from "./Sharing";

export interface PanelTab {
  id: string;
  label: string;
  Component: (props: PanelTabProps) => JSX.Element;
}

/** The tabs of a session's panel, in order. A tab ported from the web app replaces its file's placeholder. */
export const panelTabs: readonly PanelTab[] = [
  { id: "overview", label: "Overview", Component: Overview },
  { id: "files", label: "Files", Component: Files },
  { id: "browser", label: "Browser", Component: Browser },
  { id: "connections", label: "Connections", Component: Connections },
  { id: "schedules", label: "Schedules", Component: Schedules },
  { id: "sharing", label: "Sharing", Component: Sharing },
];

/** A session's panel: its details and tools beside the conversation, from the edge of the window or the screen. */
export function SessionPanel(props: PanelTabProps & { open: boolean; onClose: () => void }) {
  const tab = signal(panelTabs[0]!.id);
  // Wide windows slide it in from the right, beside the conversation; phones from the bottom.
  const sideways = () => windowSize().width >= 700;
  return (
    <Sheet open={props.open} side={sideways() ? "right" : "bottom"} closeOnSwipe onOpenChange={event => { if (!event.open) props.onClose(); }}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={sideways()
        ? { width: 480, maxWidth: "100%", height: "100%", backgroundColor: palette().background, borderLeftWidth: 1, borderColor: palette().border }
        : { height: "92%", borderTopLeftRadius: radius.large, borderTopRightRadius: radius.large, backgroundColor: palette().background }}>
      <View testID="session-panel" accessibilityLabel="Session details" style={{ flex: 1 }}>
        {/* .session-panel-header: the tabs, scrolling sideways where they don't fit, and the close button. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: palette().border }}>
          <Scroll horizontal scrollbar={false} style={{ flex: 1 }}>
            <Segmented small testID="session-panel-tabs" value={tab()} onChange={value => tab.set(value)}
              options={panelTabs.map(item => ({ value: item.id, label: item.label }))} />
          </Scroll>
          <IconButton testID="session-panel-close" icon="x" label="Close" size={28} onPress={props.onClose} />
        </View>
        {/* Keyed by tab: each is made when it is chosen. */}
        <Each of={[tab()]} key={id => id}>
          {id => {
            const Tab = panelTabs.find(item => item.id === id())!.Component;
            return <Tab sessionId={props.sessionId} session={props.session} view={props.view} refresh={props.refresh} go={props.go} />;
          }}
        </Each>
      </View>
    </Sheet>
  );
}
