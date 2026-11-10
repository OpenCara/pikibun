import { effect, signal, untracked, View } from "nsh";
import type { NotificationConfig, NotificationDevice, NotificationPreferences } from "../../../../packages/shared/src/notifications";
import { segment } from "../shared";
import { session } from "../lib/auth";
import { timestamp } from "../lib/format";
import { currentDeviceId, deviceSupport, disableNotifications, enableNotifications, notificationsOn, type DeviceSupport } from "../lib/notifications";
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

const supportHints = {
  push: "This browser shows notifications even when no Pikibun tab is open.",
  page: "This browser shows notifications while a Pikibun tab is open.",
};

export function Notifications(_props: SectionProps) {
  const { user } = untracked(session);
  const config = createResource<NotificationConfig>(() => "/api/notifications/config");
  const preferences = createAction();
  const devices = createAction();
  const device = createAction();
  const support = signal<DeviceSupport | null>(null);
  effect(() => {
    const loaded = config.data();
    if (!loaded) return;
    void deviceSupport(loaded.webPushKey).then(value => support.set(value));
  });
  const blocked = () => support()?.kind !== "unsupported" && support()?.permission === "denied";
  function toggleDevice(next: boolean) {
    const loaded = config.data();
    if (device.busy() || !loaded) return;
    void device.run(async () => {
      if (next) support.set(await enableNotifications(user.id, loaded));
      else await disableNotifications(user.id);
      config.refresh();
    }, next ? "Notifications are on for this device." : "Notifications are off for this device.");
  }
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
      if (item.id === await currentDeviceId(user.id)) await disableNotifications(user.id);
      else await session().api(`/api/notifications/devices/${segment(item.id)}`, { method: "DELETE" });
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
        <Note>Turn notifications on in each browser where you want them. They come through its push service (Google's, Mozilla's, Apple's or Microsoft's), encrypted so that only your browser can read them.</Note>
      </View>}>
        <ResourceState inline loading={config.loading() && !config.data()} error={config.error()} retry={config.refresh}>
          <If when={support()}>
            {current => (
              <Row title="Notifications on this device" testID="notifications-device"
                hint={current().kind === "unsupported" ? (current() as { reason: string }).reason
                  : blocked() ? "This browser blocks notifications from Pikibun. Allow them in the site's settings (the icon beside the address)."
                  : supportHints[current().kind as "push" | "page"]}
                trailing={current().kind === "unsupported" ? <Badge>Unavailable</Badge>
                  : <CheckControl testID="notifications-device-toggle" label="Notifications on this device" checked={notificationsOn()}
                    disabled={device.busy() || (blocked() && !notificationsOn())} onChange={toggleDevice} />} />
            )}
          </If>
        </ResourceState>
        <If when={device.error() || device.notice()}><CardBody><Feedback error={device.error()} notice={device.notice()} /></CardBody></If>
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
      <Section title="Devices" info="The browsers that get your notifications even when Pikibun isn't open. Signing out of one stops its notifications."
        action={<Button small variant="outline" icon="bell" label="Send a test" disabled={devices.busy()} onPress={sendTest} />}>
        <If when={config.data()?.devices.length} else={<Row title="No devices yet" hint={support()?.kind === "unsupported" ? "Turn notifications on in Pikibun on the web, or in a browser" : "Turn notifications on above"} />}>
          <Each of={config.data()?.devices ?? []} key={item => item.id}>
            {item => (
              <Row title={`${item().name ?? "Browser"}${item().current ? " · This device" : ""}`}
                hint={`Browser · since ${timestamp(item().createdAt)}`}
                trailing={<Button small variant="outline" label="Remove" disabled={devices.busy()} onPress={() => remove(item())} />} />
            )}
          </Each>
        </If>
        <If when={devices.error() || devices.notice()}><CardBody><Feedback error={devices.error()} notice={devices.notice()} /></CardBody></If>
      </Section>
    </SectionPage>
  );
}
