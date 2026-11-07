import { Clipboard, platform, Text, View } from "nsh";
import { usernameWithId } from "../shared";
import { session, signOut } from "../lib/auth";
import { timestamp } from "../lib/format";
import { createAction } from "../lib/resource";
import { displayOrigin, usesBrowserSession } from "../lib/server";
import { palette } from "../theme";
import { Button, Card, confirm, Feedback, Row, Small, Value } from "../ui";
import { SectionPage, type SectionProps } from "./parts";

export const APP_VERSION = "0.1.0";

/** A settings page's group heading, over its card. */
export function Heading(props: { children: string }) {
  return <Text role="header" style={{ fontSize: 13, fontWeight: "600", marginTop: 12, marginBottom: -2, color: palette().muted }}>{props.children}</Text>;
}

/** The signed-in person: their account, this sign-in, the app, signing out. */
export function Profile(_props: SectionProps) {
  const action = createAction();
  const user = () => session().user;
  async function confirmSignOut() {
    const { origin } = session();
    if (!await confirm({ title: "Sign out?", message: `This device signs out of ${displayOrigin(origin)} and forgets its sign-in.`, confirmLabel: "Sign out", destructive: true })) return;
    await signOut();
  }
  return (
    <SectionPage>
      <Heading>Account</Heading>
      <Card>
        <Row label="Name"><Value>{user().displayName}</Value></Row>
        <If when={user().githubLogin}>{login => <Row label="GitHub"><Value>{`@${login()}`}</Value></Row>}</If>
        <Row label="User ID">
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Value testID="settings-user-id">{usernameWithId(user())}</Value>
            <Button small variant="ghost" icon="copy" label="Copy" onPress={() => void action.run(() => Clipboard.writeText(user().id), "User ID copied")} />
          </View>
        </Row>
        <Small>Workspace owners add you with your user ID.</Small>
      </Card>
      <Heading>Server</Heading>
      <Card>
        <Row label="Address"><Value>{session().origin || "This server"}</Value></Row>
        <Row label="Status"><Value>{session().expiresAt ? `Signed in until ${timestamp(session().expiresAt!)}` : "Signed in"}</Value></Row>
        <Small>{usesBrowserSession ? "Signed in with this browser's session." : "This device's sign-in. Review and revoke signed-in apps under Profile."}</Small>
      </Card>
      <Heading>App</Heading>
      <Card>
        <Row label="Version"><Value>{`Pikibun ${APP_VERSION}`}</Value></Row>
        <Row label="Platform"><Value>{`${platform.os} ${platform.version} · ${platform.desktop ? "desktop" : platform.idiom}`}</Value></Row>
      </Card>
      <Feedback error={action.error()} notice={action.notice()} />
      <Button testID="sign-out" variant="danger" block icon="log-out" label="Sign out" onPress={() => void confirmSignOut()} />
    </SectionPage>
  );
}
