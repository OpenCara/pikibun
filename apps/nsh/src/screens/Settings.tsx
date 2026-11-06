import { Clipboard, platform, Scroll, Text, View } from "nsh";
import { usernameWithId } from "../shared";
import { session, signOut } from "../lib/auth";
import { timestamp } from "../lib/format";
import { createAction } from "../lib/resource";
import { displayOrigin, usesBrowserSession } from "../lib/server";
import { palette } from "../theme";
import { Button, Card, confirm, Feedback, Row, Small, Value } from "../ui";

export const APP_VERSION = "0.1.0";

function Heading(props: { children: string }) {
  return <Text style={{ fontSize: 13, fontWeight: "600", textTransform: "uppercase", marginTop: 8, color: palette().muted }}>{props.children}</Text>;
}

export function Settings() {
  const action = createAction();
  const user = () => session().user;
  async function confirmSignOut() {
    const { origin } = session();
    if (!await confirm({ title: "Sign out?", message: `This device signs out of ${displayOrigin(origin)} and forgets its sign-in.`, confirmLabel: "Sign out", destructive: true })) return;
    await signOut();
  }
  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ gap: 10, padding: 20, width: "100%", maxWidth: 640, alignSelf: "center" }}>
      <Heading>Account</Heading>
      <Card>
        <Row label="Name"><Value>{user().displayName}</Value></Row>
        <If when={user().githubLogin}>{login => <Row label="GitHub"><Value>{`@${login()}`}</Value></Row>}</If>
        <Row label="User ID">
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Value testID="settings-user-id">{usernameWithId(user())}</Value>
            <Button small variant="ghost" icon="⧉" label="Copy" onPress={() => void action.run(() => Clipboard.writeText(user().id), "User ID copied")} />
          </View>
        </Row>
        <Small>Workspace owners add you with your user ID.</Small>
      </Card>
      <Heading>Notifications</Heading>
      <Card>
        <Small>
          This NSH client can't receive push notifications yet: NSH has no APNs or FCM registration (longbridge/nsh#1058). Turn notifications on in the web app or the Expo iPhone app.
        </Small>
      </Card>
      <Heading>Server</Heading>
      <Card>
        <Row label="Address"><Value>{session().origin || "This server"}</Value></Row>
        <Row label="Status"><Value>{session().expiresAt ? `Signed in until ${timestamp(session().expiresAt!)}` : "Signed in"}</Value></Row>
        <Small>{usesBrowserSession ? "Signed in with this browser's session, as the web app is." : "Signed-in apps can be reviewed and revoked under Settings › Profile on the web."}</Small>
      </Card>
      <Heading>App</Heading>
      <Card>
        <Row label="Version"><Value>{`Pikibun NSH ${APP_VERSION}`}</Value></Row>
        <Row label="Platform"><Value>{`${platform.os} ${platform.version} · ${platform.desktop ? "desktop" : platform.idiom}`}</Value></Row>
      </Card>
      <Feedback error={action.error()} notice={action.notice()} />
      <Button testID="sign-out" variant="danger" icon="⏻" label="Sign out" onPress={() => void confirmSignOut()} />
    </Scroll>
  );
}
