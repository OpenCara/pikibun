import type { NotificationConfig, NotificationDevice, NotificationPreferences } from "../../../../packages/shared/src/notifications";
import { api, segment } from "../api";
import { useApp } from "../app-context";
import { currentDeviceId, deviceSupport, disableNotifications, enableNotifications, useNotificationsOn } from "../notifications";
import { Button, CardBody, Feedback, ResourceState, Row, Section, StatusBadge, Timestamp, useAction, useResource } from "../ui";

const events: { key: keyof NotificationPreferences; title: string; hint: string }[] = [
  { key: "approvals", title: "Needs approval", hint: "A session's agent waits for someone to approve what it wants to do" },
  { key: "finished", title: "Finished", hint: "A session's agent finished the message it was working on" },
  { key: "failed", title: "Failed", hint: "A session's agent stopped on an error" },
  { key: "details", title: "Show session titles", hint: "Off, notifications only say what happened, not which session or workspace" },
];

const supportHints = {
  desktop: "This app shows notifications while it is open, even with its windows hidden.",
  push: "This browser shows notifications even when no Pikibun tab is open.",
  page: "This browser shows notifications while a Pikibun tab is open.",
};

/** Settings › Notifications: this device on or off, what to be told about, and the devices that get notifications. */
export function NotificationSettings() {
  const { user } = useApp();
  const config = useResource<NotificationConfig>("/api/notifications/config");
  const on = useNotificationsOn(user.id);
  const device = useAction();
  const preferences = useAction();
  const devices = useAction();
  const support = deviceSupport(config.data?.webPushKey ?? null);
  const blocked = support.kind !== "desktop" && support.kind !== "unsupported" && Notification.permission === "denied";

  function toggleDevice(next: boolean) {
    if (device.busy || !config.data) return;
    void device.run(async () => {
      if (next) await enableNotifications(user.id, config.data!);
      else await disableNotifications(user.id);
      config.refresh();
    }, next ? "Notifications are on for this device." : "Notifications are off for this device.");
  }
  function savePreference(key: keyof NotificationPreferences, value: boolean) {
    if (preferences.busy) return;
    void preferences.run(async () => {
      const { preferences: saved } = await api<{ preferences: NotificationPreferences }>("/api/notifications/preferences", { method: "PUT", body: { [key]: value } });
      config.setData(current => current ? { ...current, preferences: saved } : current);
    });
  }
  function remove(item: NotificationDevice) {
    if (devices.busy) return;
    void devices.run(async () => {
      if (item.id === currentDeviceId(user.id)) await disableNotifications(user.id);
      else await api(`/api/notifications/devices/${segment(item.id)}`, { method: "DELETE" });
      config.refresh();
    }, `${item.name ?? "The device"} no longer gets notifications.`);
  }
  function sendTest() {
    if (devices.busy) return;
    void devices.run(async () => {
      await api("/api/notifications/test", { method: "POST" });
    }, "Sent. It should appear on each device with notifications on within a few seconds.");
  }

  return <>
    <Section title="This device" info={<div className="stack">
      <p>Pikibun tells you when one of your sessions waits for an approval, finishes or fails: sessions you own, and those you sent the latest message to.</p>
      <p>Turn notifications on in each browser, and in the Pikibun apps, where you want them. In a browser they come through its push service (Google's, Mozilla's, Apple's or Microsoft's), encrypted so that only your browser can read them.</p>
    </div>}>
      <ResourceState loading={config.loading && !config.data} error={config.error} retry={config.refresh}>
        {config.data && <Row title="Notifications on this device"
          hint={support.kind === "unsupported" ? support.reason
            : blocked ? "This browser blocks notifications from Pikibun. Allow them in the site's settings (the icon beside the address)."
            : supportHints[support.kind]}
          trailing={support.kind === "unsupported"
            ? <StatusBadge tone="neutral">Unavailable</StatusBadge>
            : <input type="checkbox" className="checkbox" role="switch" aria-label="Notifications on this device" checked={on} disabled={device.busy || (blocked && !on)}
              onChange={event => toggleDevice(event.target.checked)} />} />}
        {(device.error || device.notice) && <CardBody><Feedback {...device} /></CardBody>}
      </ResourceState>
    </Section>
    <Section title="Notify me when" info="These apply to every device you turned notifications on for.">
      {config.data && events.map(event => <Row key={event.key} title={event.title} hint={event.hint}
        trailing={<input type="checkbox" className="checkbox" role="switch" aria-label={event.title} checked={config.data!.preferences[event.key]}
          disabled={preferences.busy} onChange={change => savePreference(event.key, change.target.checked)} />} />)}
      {preferences.error && <CardBody><Feedback error={preferences.error} /></CardBody>}
    </Section>
    <Section title="Devices" info="The browsers and apps that get your notifications even when Pikibun isn't open. Signing out of one stops its notifications."
      action={<Button size="sm" variant="outline" icon="bell" disabled={devices.busy} onClick={sendTest}>Send a test</Button>}>
      {config.data && !config.data.devices.length && <Row title="No devices yet" hint="Turn notifications on above, or in the Pikibun app's settings" />}
      {config.data?.devices.map(item => <Row key={item.id}
        title={<>{item.name ?? (item.kind === "expo" ? "Pikibun app" : "Browser")}{item.current && <> <StatusBadge tone="info">This device</StatusBadge></>}</>}
        hint={<>{item.kind === "expo" ? "App" : "Browser"} · since <Timestamp value={item.createdAt} /></>}
        trailing={<Button variant="outline" size="sm" disabled={devices.busy} onClick={() => remove(item)}>Remove</Button>} />)}
      {(devices.error || devices.notice) && <CardBody><Feedback {...devices} /></CardBody>}
    </Section>
  </>;
}
