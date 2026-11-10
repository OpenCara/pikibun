import { Scroll, signal, View, windowSize, type JSX } from "nsh";
import { Sheet } from "nsh/base";
import { segment, type ConnectorInfo } from "../shared";
import { createUsername } from "../lib/people";
import { relativeTime } from "../lib/format";
import { createResource } from "../lib/resource";
import type { SessionActions } from "../lib/session-actions";
import { withUsernames, type Person } from "../../../../packages/client/src/usernames";
import { palette, radius } from "../theme";
import { CollapsibleRow, EmptyState, IconButton, Note, ResourceState, Section, Segmented, Value } from "../ui";
import { Browser } from "./Browser";
import { Details } from "./Details";
import { Files } from "./Files";
import type { PanelTabProps } from "./parts";
import { Schedules } from "./Schedules";
import { TabPage } from "./parts";
import { createWorkspacePeople } from "../lib/people";

export interface PanelProps extends PanelTabProps {
  actions: SessionActions;
  hosts: () => ConnectorInfo[] | null;
  hostsLoading: () => boolean;
}

export interface PanelTab {
  id: string;
  label: string;
  Component: (props: PanelProps) => JSX.Element;
}

type AuditEvent = { id: string; actorId: string; action: string; detail: unknown; createdAt: string };

function detailText(detail: unknown, person: (id: string) => Person): string {
  let value = detail;
  if (typeof detail === "string") {
    try { value = JSON.parse(detail); } catch { return detail; }
  }
  return JSON.stringify(withUsernames(value, person), null, 2) ?? "";
}

function Activity(props: PanelProps) {
  const audit = createResource<{ events: AuditEvent[] }>(() => `/api/sessions/${segment(props.sessionId)}/audit`);
  const people = createWorkspacePeople(() => props.session()?.workspaceId ?? null);
  const name = createUsername();
  return (
    <TabPage testID="panel-activity">
      <Section title="Audit log" action={<IconButton icon="refresh" label="Refresh activity" size={28} disabled={audit.loading()} onPress={audit.refresh} />}>
        <ResourceState inline loading={audit.loading() && !audit.data()} error={audit.error()} retry={audit.refresh}>
          <If when={audit.data()?.events.length} else={<EmptyState title="No activity" />}>
            <Each of={audit.data()?.events ?? []} key={event => event.id}>
              {event => (
                <CollapsibleRow title={event().action} hint={`${name(event().actorId)} · ${relativeTime(event().createdAt)}`}>
                  <View style={{ borderRadius: radius.medium, backgroundColor: palette().code, padding: 12 }}>
                    <Value monospace>{detailText(event().detail, people().person)}</Value>
                  </View>
                </CollapsibleRow>
              )}
            </Each>
          </If>
        </ResourceState>
      </Section>
    </TabPage>
  );
}

function DetailsTab(props: PanelProps) {
  return <TabPage testID="panel-overview"><Details {...props} /></TabPage>;
}

export const panelTabs: readonly PanelTab[] = [
  { id: "details", label: "Details", Component: DetailsTab },
  { id: "files", label: "Files", Component: Files },
  { id: "browser", label: "Browser", Component: Browser },
  { id: "schedules", label: "Schedules", Component: Schedules },
  { id: "activity", label: "Activity", Component: Activity },
];

export function SessionPanel(props: PanelProps & { open: boolean; onClose: () => void }) {
  const tab = signal(panelTabs[0]!.id);
  const sideways = () => windowSize().width >= 700;
  const wide = () => tab() === "files" || tab() === "browser";
  return (
    <Sheet open={props.open} side={sideways() ? "right" : "bottom"} closeOnSwipe onOpenChange={event => { if (!event.open) props.onClose(); }}
      backdropStyle={{ backgroundColor: palette().backdrop }}
      popupStyle={sideways()
        ? { width: wide() ? 720 : 480, maxWidth: "100%", height: "100%", backgroundColor: palette().background, borderLeftWidth: 1, borderColor: palette().border }
        : { height: "92%", borderTopLeftRadius: radius.large, borderTopRightRadius: radius.large, backgroundColor: palette().background }}>
      <View testID="session-panel" accessibilityLabel="Session details" style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: palette().border }}>
          <Scroll horizontal scrollbar={false} style={{ flex: 1 }}>
            <Segmented small testID="session-panel-tabs" value={tab()} onChange={value => tab.set(value)}
              options={panelTabs.map(item => ({ value: item.id, label: item.label }))} />
          </Scroll>
          <IconButton testID="session-panel-close" icon="x" label="Close panel" size={28} onPress={props.onClose} />
        </View>
        <Each of={[tab()]} key={id => id}>
          {id => {
            const Tab = panelTabs.find(item => item.id === id())!.Component;
            return <Tab {...props} />;
          }}
        </Each>
      </View>
    </Sheet>
  );
}
