import { signal, View } from "nsh";
import type { NotificationConfig, NotificationDevice, NotificationPreferences } from "../../../../packages/shared/src/notifications";
import { segment } from "../shared";
import { session } from "../lib/auth";
import { timestamp } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import { CheckControl } from "../form";
import { Badge, Button, CardBody, Feedback, Note, ResourceState, Row, Section } from "../ui";
import { SectionPage, type SectionProps } from "./parts";

const events: { key: keyof NotificationPreferences; title: string; hint: string }[] = [
  { key: "approvals", title: "Needs approval", hint: "A session's agent waits for someone to approve what it wants to do" },
  { key: "finished", title: "Finished", hint: "A session's agent finished the message it was working on" },
  { key: "failed", title: "Failed", hint: "A session's agent stopped on an error" },
  { key: "details", title: "Show session titles", hint: "Off, notifications only say what happened, not which session or workspace" },
];

/**
 * Settings › Notifications, as the web app's: this device, what to be told about, and the devices that get them. This
 * app can't receive notifications itself yet (longbridge/nsh#1058), so its own device stays off; the rest is the
 * account's and works from here.
 */
export function Notifications(_props: SectionProps) {
  const config = createResource<NotificationConfig>(() => "/api/notifications/config");
  const preferences = createAction();
  const devices = createAction();
  // What was last saved here is the newest there is.
  const saved = signal<NotificationPreferences | null>(null);
  const current = () => saved() ?? config.data()?.preferences;
  function savePreference(key: keyof NotificationPreferences, value: boolean) {
    if (preferences.busy()) return;
    void preferences.run(async () => {
      const result = await session().api<{ preferences: NotificationPreferences }>("/api/notifications/preferences", { method: "PUT", body: { [key]: value } });
      saved.set(result.preferences);
    });
  }
  function remove(item: NotificationDevice) {
    if (devices.busy()) return;
    void devices.run(async () => {
      await session().api(`/api/notifications/devices/${segment(item.id)}`, { method: "DELETE" });
      config.refresh();
    }, `${item.name ?? "The device"} no longer gets notifications.`);
  }
  function sendTest() {
    if (devices.busy()) return;
    void devices.run(async () => {
      await session().api("/api/notifications/test", { method: "POST" });
    }, "Sent. It should appear on each device with notifications on within a few seconds.");
  }
  return (
    <SectionPage testID="settings-notifications">
      <Section title="This device" info={<View style={{ gap: 8 }}>
        <Note>Pikibun tells you when one of your sessions waits for an approval, finishes or fails: sessions you own, and those you sent the latest message to.</Note>
        <Note>Turn notifications on in each browser, and in the Pikibun apps, where you want them.</Note>
      </View>}>
        <Row title="Notifications on this device" hint="This app can't show notifications yet. Turn them on in Pikibun on the web, or in a browser, to be told here."
          trailing={<Badge>Unavailable</Badge>} />
      </Section>
      <Section title="Notify me when" info="These apply to every device you turned notifications on for.">
        <ResourceState inline loading={config.loading() && !config.data()} error={config.error()} retry={config.refresh}>
          <Each of={events} key={event => event.key}>
            {event => (
              <Row title={event().title} hint={event().hint}
                trailing={<CheckControl testID={`notify-${event().key}`} label={event().title} checked={Boolean(current()?.[event().key])} disabled={preferences.busy()}
                  onChange={value => savePreference(event().key, value)} />} />
            )}
          </Each>
        </ResourceState>
        <If when={preferences.error()}><CardBody><Feedback error={preferences.error()} /></CardBody></If>
      </Section>
      <Section title="Devices" info="The browsers and apps that get your notifications even when Pikibun isn't open. Signing out of one stops its notifications."
        action={<Button small variant="outline" icon="bell" label="Send a test" disabled={devices.busy()} onPress={sendTest} />}>
        <If when={config.data()?.devices.length} else={<Row title="No devices yet" hint="Turn notifications on in Pikibun on the web, or in a browser" />}>
          <Each of={config.data()?.devices ?? []} key={item => item.id}>
            {item => (
              <Row title={item().name ?? (item().kind === "expo" ? "Pikibun app" : "Browser")}
                hint={`${item().kind === "expo" ? "App" : "Browser"} · since ${timestamp(item().createdAt)}`}
                trailing={<Button small variant="outline" label="Remove" disabled={devices.busy()} onPress={() => remove(item())} />} />
            )}
          </Each>
        </If>
        <If when={devices.error() || devices.notice()}><CardBody><Feedback error={devices.error()} notice={devices.notice()} /></CardBody></If>
      </Section>
    </SectionPage>
  );
}
