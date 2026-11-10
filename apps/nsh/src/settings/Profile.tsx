import { platform, signal, View } from "nsh";
import type { SignedInDevice, UserProfile } from "../../../../packages/shared/src/types";
import { segment, usernameWithId } from "../shared";
import { session, signOut, updateUser } from "../lib/auth";
import { timestamp } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import { displayOrigin, usesBrowserSession } from "../lib/server";
import { palette } from "../theme";
import { Field, TextField } from "../form";
import { Button, CardBody, confirm, CopyButton, Feedback, IconButton, ResourceState, Row, Section } from "../ui";
import { ConnectedAccountsSection } from "./accounts";
import { OwnJoinRequests } from "./join-requests";
import { SectionPage, SettingsActions, type SectionProps } from "./parts";
import { serverVersion } from "./index";

export const APP_VERSION = "0.1.0";

type EnvRow = { id: string; key: string; value: string };

function SignedInAppsSection() {
  const devices = createResource<{ devices: SignedInDevice[] }>(() => "/api/me/devices");
  const action = createAction();
  async function revoke(device: SignedInDevice) {
    if (action.busy()) return;
    if (!await confirm({ title: "Sign out this app?", destructive: true, confirmLabel: "Sign out app",
      message: `${device.name ?? "This app"} is signed out at once and has to sign in again to reach your sessions.` })) return;
    void action.run(async () => {
      await session().api(`/api/me/devices/${segment(device.id)}`, { method: "DELETE" });
      devices.refresh();
    }, "App signed out.");
  }
  return (
    <Section title="Signed-in apps" testID="signed-in-apps"
      info="The Pikibun apps on your phone, tablet or computer that signed in as you. Each stays signed in for 30 days unless you sign it out here or in the app.">
      <ResourceState inline loading={devices.loading() && !devices.data()} error={devices.error()} retry={devices.refresh}>
        <If when={devices.data()?.devices.length} else={<Row title="No apps signed in" hint="Sign in from the Pikibun app on iPhone, iPad or Mac" />}>
          <Each of={devices.data()?.devices ?? []} key={device => device.id}>
            {device => (
              <Row title={device().name ?? "Unnamed app"} hint={`Signed in ${timestamp(device().createdAt)} · until ${timestamp(device().expiresAt)}`}
                trailing={<Button small variant="outline" label="Sign out" disabled={action.busy()} onPress={() => void revoke(device())} />} />
            )}
          </Each>
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}

export function Profile(_props: SectionProps) {
  const user = () => session().user;
  const displayName = signal(user().displayName);
  const gitName = signal(user().gitName);
  const gitEmail = signal(user().gitEmail);
  const rows = signal<EnvRow[]>(Object.entries(user().env).map(([key, value]) => ({ id: crypto.randomUUID(), key, value })));
  const action = createAction();
  function save() {
    void action.run(async () => {
      if (!displayName().trim() || !gitName().trim() || !gitEmail().trim()) throw new Error("Enter your display name and Git author name and email.");
      const environment: Record<string, string> = {};
      for (const row of rows()) {
        if (!/^APP_[A-Z0-9_]+$/.test(row.key)) throw new Error("Environment names must start with APP_ and contain only uppercase letters, digits, and underscores.");
        if (Object.hasOwn(environment, row.key)) throw new Error(`Duplicate environment name: ${row.key}`);
        environment[row.key] = row.value;
      }
      const response = await session().api<{ user: UserProfile }>("/api/me", { method: "PATCH",
        body: { displayName: displayName(), gitName: gitName(), gitEmail: gitEmail(), env: environment } });
      updateUser(response.user);
    }, "Profile saved. New sessions use your configured identity.");
  }
  const update = (id: string, change: Partial<EnvRow>) => rows.update(current => current.map(item => (item.id === id ? { ...item, ...change } : item)));
  async function confirmSignOut() {
    if (!await confirm({ title: "Sign out?", message: `This device signs out of ${displayOrigin(session().origin)} and forgets its sign-in.`, confirmLabel: "Sign out", destructive: true })) return;
    await signOut();
  }
  return (
    <SectionPage testID="settings-profile">
      <View style={{ gap: 32 }}>
        <Section title="Identity" info="Sessions you own act with this Git identity and your connected Git accounts. New sessions use the saved values.">
          <CardBody>
            <Field label="Display name"><TextField testID="profile-display-name" value={displayName()} onChange={value => displayName.set(value)} maxLength={120} /></Field>
            <Field label="Git author name"><TextField value={gitName()} onChange={value => gitName.set(value)} maxLength={120} /></Field>
            <Field label="Git author email"><TextField value={gitEmail()} onChange={value => gitEmail.set(value)} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} /></Field>
          </CardBody>
        </Section>
        <Section title="Environment"
          info="Nonsecret APP_ variables only. They are sent to the host of every session you own. Never put Git tokens, provider keys or other credentials here; model credentials belong in Pi on your host."
          action={<Button small variant="outline" icon="plus" label="Add variable" onPress={() => rows.update(current => [...current, { id: crypto.randomUUID(), key: "APP_", value: "" }])} />}>
          <If when={rows().length > 0} else={<Row title="No variables" hint="Add APP_ variables your sessions need" />}>
            <Each of={rows()} key={row => row.id}>
              {(row, index) => (
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: 1, borderColor: palette().border }}>
                  <View style={{ flex: 2, minWidth: 140 }}>
                    <TextField compact monospace value={row().key} onChange={key => update(row().id, { key })} placeholder="APP_PROJECT" accessibilityLabel={`Variable ${index() + 1} name`} />
                  </View>
                  <View style={{ flex: 3, minWidth: 160 }}>
                    <TextField compact value={row().value} onChange={value => update(row().id, { value })} accessibilityLabel={`Variable ${index() + 1} value`} />
                  </View>
                  <IconButton icon="trash" label={`Remove variable ${index() + 1}`} onPress={() => rows.update(current => current.filter(item => item.id !== row().id))} />
                </View>
              )}
            </Each>
          </If>
        </Section>
        <SettingsActions action={action} label={action.busy() ? "Saving…" : "Save profile"} onPress={save} testID="profile-save" />
      </View>
      <ConnectedAccountsSection />
      <SignedInAppsSection />
      <OwnJoinRequests />
      <Section title="Account">
        <If when={user().username}>
          {name => <Row title="Username" hint={name()} selectableHint trailing={<CopyButton value={name()} label="Copy username" />} />}
        </If>
        <Row title="User ID" hint={usernameWithId(user())} hintTestID="settings-user-id" selectableHint
          trailing={<CopyButton value={user().id} label="Copy user ID" />} />
        <Row title="Sign out" hint={`Signed in to ${displayOrigin(session().origin)}${session().expiresAt ? ` until ${timestamp(session().expiresAt!)}` : ""}${usesBrowserSession ? " with this browser's session" : ""}`}
          trailing={<Button testID="sign-out" small variant="outline" label="Sign out" onPress={() => void confirmSignOut()} />} />
      </Section>
      <Section title="This app">
        <Row title="Version" trailing={`Pikibun ${APP_VERSION}`} />
        <Row title="Platform" trailing={`${platform.os} ${platform.version} · ${platform.desktop ? "desktop" : platform.idiom}`} />
        <If when={serverVersion()}>{version => <Row title="Server" trailing={`Pikibun server ${version()}`} />}</If>
      </Section>
    </SectionPage>
  );
}
