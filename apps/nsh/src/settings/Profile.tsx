import { Clipboard, platform } from "nsh";
import { usernameWithId } from "../shared";
import { session, signOut } from "../lib/auth";
import { timestamp } from "../lib/format";
import { createAction } from "../lib/resource";
import { displayOrigin, usesBrowserSession } from "../lib/server";
import { Button, confirm, Feedback, Row, Section } from "../ui";
import { SectionPage, type SectionProps } from "./parts";

export const APP_VERSION = "0.1.0";

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
      <Section title="Account">
        <Row title="Name" trailing={user().displayName} />
        <If when={user().githubLogin}>{login => <Row title="GitHub" trailing={`@${login()}`} />}</If>
        <Row title="User ID" hint={usernameWithId(user())} hintTestID="settings-user-id" selectableHint
          trailing={<Button small variant="ghost" icon="copy" label="Copy" onPress={() => void action.run(() => Clipboard.writeText(user().id), "User ID copied")} />} />
        <Row title="Sign out" hint="Workspace owners add you with your user ID."
          trailing={<Button testID="sign-out" small variant="outline" label="Sign out" onPress={() => void confirmSignOut()} />} />
      </Section>
      <Feedback error={action.error()} notice={action.notice()} />
      <Section title="Server">
        <Row title="Address" hint={session().origin || "This server"} selectableHint />
        <Row title="Status" hint={`${session().expiresAt ? `Signed in until ${timestamp(session().expiresAt!)}` : "Signed in"} · ${usesBrowserSession
          ? "with this browser's session"
          : "this device's sign-in"}`} />
      </Section>
      <Section title="App">
        <Row title="Version" trailing={`Pikibun ${APP_VERSION}`} />
        <Row title="Platform" trailing={`${platform.os} ${platform.version} · ${platform.desktop ? "desktop" : platform.idiom}`} />
      </Section>
    </SectionPage>
  );
}
