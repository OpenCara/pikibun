import { usernameWithId } from "@pikibun/client";
import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { NotificationConfig, NotificationPreferences } from "../../../../packages/shared/src/notifications";
import { Button, Card, confirm, Feedback, styles as ui } from "../components/ui";
import { useAuth, useSession } from "../lib/auth";
import { timestamp } from "../lib/format";
import { disableNotifications, enableNotifications, notificationsOn, pushUnavailable } from "../lib/notifications";
import { useAction, useResource } from "../lib/resource";
import { displayOrigin } from "../lib/server";
import { usePalette } from "../theme";

function Row({ label, children }: { label: string; children: ReactNode }) {
  const palette = usePalette();
  return <View style={styles.row}>
    <Text style={[styles.label, { color: palette.muted }]}>{label}</Text>
    {typeof children === "string" ? <Text selectable style={[styles.value, { color: palette.text }]}>{children}</Text> : children}
  </View>;
}

export default function SettingsScreen() {
  const { signOut } = useAuth();
  const { user, origin, expiresAt } = useSession();
  const palette = usePalette();
  const action = useAction();
  const version = [Application.nativeApplicationVersion, Application.nativeBuildVersion && `(${Application.nativeBuildVersion})`].filter(Boolean).join(" ");
  async function confirmSignOut() {
    if (!await confirm({ title: "Sign out?", message: `This device signs out of ${displayOrigin(origin)} and forgets its sign-in.`, confirmLabel: "Sign out", destructive: true })) return;
    await signOut();
  }
  return <ScrollView contentContainerStyle={styles.column}>
    <Text style={[styles.heading, { color: palette.muted }]}>Account</Text>
    <Card>
      <Row label="Name">{user.displayName}</Row>
      {user.githubLogin && <Row label="GitHub">{`@${user.githubLogin}`}</Row>}
      <Row label="User ID">
        <View style={ui.inline}>
          <Text selectable testID="settings-user-id" style={[styles.value, { color: palette.text }]}>{usernameWithId(user)}</Text>
          <Button small variant="ghost" icon="copy-outline" label="Copy" onPress={() => void action.run(async () => { await Clipboard.setStringAsync(user.id); }, "User ID copied")} />
        </View>
      </Row>
      <Text style={[ui.small, { color: palette.muted }]}>Workspace owners add you with your user ID.</Text>
    </Card>
    <Text style={[styles.heading, { color: palette.muted }]}>Notifications</Text>
    <NotificationsCard />
    <Text style={[styles.heading, { color: palette.muted }]}>Server</Text>
    <Card>
      <Row label="Address">{origin}</Row>
      <Row label="Status">{expiresAt ? `Signed in until ${timestamp(expiresAt)}` : "Signed in"}</Row>
      <Text style={[ui.small, { color: palette.muted }]}>Signed-in apps can be reviewed and revoked under Settings › Profile on the web.</Text>
    </Card>
    <Text style={[styles.heading, { color: palette.muted }]}>App</Text>
    <Card>
      <Row label="Version">{version || "Unknown"}</Row>
    </Card>
    <Feedback error={action.error} notice={action.notice} />
    <Button testID="sign-out" variant="danger" icon="log-out-outline" label="Sign out" onPress={() => void confirmSignOut()} />
  </ScrollView>;
}

const preferenceRows: { key: keyof NotificationPreferences; label: string }[] = [
  { key: "approvals", label: "Needs approval" },
  { key: "finished", label: "Finished" },
  { key: "failed", label: "Failed" },
  { key: "details", label: "Show session titles" },
];

/** Notifications on this device, and which ones this person gets on all of theirs (as on the web's Settings). */
function NotificationsCard() {
  const { api, origin, user } = useSession();
  const palette = usePalette();
  const config = useResource<NotificationConfig>("/api/notifications/config");
  const action = useAction();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void notificationsOn(origin, user.id).then(setOn); }, [origin, user.id]);
  const unavailable = pushUnavailable();
  function toggle(next: boolean) {
    void action.run(async () => {
      if (next) await enableNotifications(api, origin, user.id);
      else await disableNotifications(api, origin, user.id);
      setOn(next);
      config.refresh();
    }, next ? "Notifications are on for this device." : "Notifications are off for this device.");
  }
  function save(key: keyof NotificationPreferences, value: boolean) {
    void action.run(async () => {
      await api("/api/notifications/preferences", { method: "PUT", body: { [key]: value } });
      config.refresh();
    });
  }
  return <Card>
    <View style={styles.switchRow}>
      <Text style={[styles.value, styles.switchLabel, { color: palette.text }]}>On this device</Text>
      <Switch testID="notifications-device" value={on === true} disabled={on === null || action.busy || (!!unavailable && !on)} onValueChange={toggle} />
    </View>
    <Text style={[ui.small, { color: palette.muted }]}>
      {unavailable ?? "When one of your sessions waits for an approval, finishes or fails: sessions you own, and those you sent the latest message to."}
    </Text>
    {config.data && preferenceRows.map(row => <View key={row.key} style={styles.switchRow}>
      <Text style={[styles.value, styles.switchLabel, { color: palette.text }]}>{row.label}</Text>
      <Switch value={config.data!.preferences[row.key]} disabled={action.busy} onValueChange={value => save(row.key, value)} />
    </View>)}
    {config.data && <Text style={[ui.small, { color: palette.muted }]}>These apply on every device you turned notifications on for.</Text>}
    {on && <Button small variant="ghost" icon="notifications-outline" label="Send a test" disabled={action.busy}
      onPress={() => void action.run(async () => { await api("/api/notifications/test", { method: "POST" }); }, "Sent. It should arrive within a few seconds.")} />}
    <Feedback error={action.error || config.error} notice={action.notice} />
  </Card>;
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  switchLabel: { flex: 1 },
  column: { gap: 10, padding: 20, width: "100%", maxWidth: 640, alignSelf: "center" },
  heading: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", marginTop: 8 },
  row: { gap: 2 },
  label: { fontSize: 13 },
  value: { fontSize: 16 },
});
