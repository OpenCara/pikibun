import { signal, untracked, View } from "nsh";
import type { UserProfile } from "../shared";
import { session, updateUser } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { canSignInAgain, chooseUsername, needsRecentSignIn, signInWithGitHubAgain, suggestedUsername } from "../lib/sign-in-again";
import { Field, TextField } from "../form";
import { Banner, Button, CardBody, confirm, Feedback, Row, Section, Small } from "../ui";
import { SectionPage, SettingsActions, type SectionProps } from "./parts";

function createGuardedAction() {
  const action = createAction();
  const signInAgain = signal(false);
  const run = (work: () => Promise<void>, success = "") => {
    signInAgain.set(false);
    return action.run(async () => {
      try { await work(); } catch (reason) { signInAgain.set(needsRecentSignIn(reason)); throw reason; }
    }, success);
  };
  return { ...action, run, signInAgain };
}

function SignInAgain() {
  return (
    <Banner tone="info" title="Sign in with GitHub again"
      actions={canSignInAgain ? <Button small variant="outline" label="Sign in with GitHub again" onPress={signInWithGitHubAgain} /> : undefined}>
      {canSignInAgain ? "A GitHub sign-in from the last 15 minutes stands in for your current password."
        : "A GitHub sign-in from the last 15 minutes stands in for your current password: sign in again on Pikibun on the web to do this there."}
    </Banner>
  );
}

function ChooseUsernameSection() {
  const username = signal(suggestedUsername(untracked(session).user.githubLogin));
  const action = createAction();
  const submit = () => void action.run(async () => updateUser(await chooseUsername(username())), "Username saved.");
  return (
    <View style={{ gap: 16 }}>
      <Section title="Username" info="You sign in with your username and password, and teammates find you by it. It can't be changed later.">
        <CardBody>
          <Field label="Username" hint="3 to 39 lowercase letters, digits, - and _, starting with a letter or digit.">
            <TextField value={username()} onChange={value => username.set(value)} autoCapitalize="none" autoCorrect={false} maxLength={60} onSubmit={submit} />
          </Field>
        </CardBody>
      </Section>
      <SettingsActions action={action} label={action.busy() ? "Saving…" : "Choose username"} onPress={submit} />
    </View>
  );
}

function SignInSection(props: { passwords: boolean }) {
  const user = () => session().user;
  return (
    <Section title="Sign-in" info="The ways you can sign in to this Pikibun.">
      <Row title="Username" hint={user().username ?? "Not chosen yet"} />
      <If when={user().githubId !== null}><Row title="GitHub" hint={user().githubLogin ? `@${user().githubLogin}` : "Connected"} /></If>
      <Row title="Password" hint={user().hasPassword
        ? (props.passwords ? "Set: you can sign in with your username and password" : "Set, but this server doesn't take passwords now")
        : (props.passwords ? "Not set: you sign in with GitHub only" : "This server doesn't offer passwords")} />
    </Section>
  );
}

function PasswordForm() {
  const user = () => session().user;
  const changing = () => Boolean(user().hasPassword);
  const github = () => !user().passwordSignIn;
  const current = signal("");
  const next = signal("");
  const again = signal("");
  const action = createGuardedAction();
  function submit() {
    void action.run(async () => {
      if (next() !== again()) throw new Error("The new passwords don't match.");
      const body: Record<string, string> = { newPassword: next() };
      if (current()) body.currentPassword = current();
      const response = await session().api<{ user?: UserProfile }>("/api/me/password", { method: "POST", body });
      current.set(""); next.set(""); again.set("");
      if (response.user) updateUser(response.user);
    }, changing() ? "Password changed. Your other browsers and apps are signed out." : "Password set. You can now sign in with your username and this password.");
  }
  return (
    <View style={{ gap: 16 }}>
      <Section title={changing() ? "Change password" : "Set a password"} testID="password-form"
        info={changing() ? "Changing your password signs out every other browser and app signed in as you."
          : "Sign in with your username and this password, besides GitHub. Setting it needs a GitHub sign-in from the last 15 minutes."}>
        <CardBody>
          <If when={changing()}>
            <Field label="Current password" hint={github() ? "Forgot it? Leave this empty within 15 minutes of signing in with GitHub." : undefined}>
              <TextField masked value={current()} onChange={value => current.set(value)} maxLength={256} />
            </Field>
          </If>
          <Field label="New password" hint="At least 12 characters, other than your username. A few unrelated words make a good one.">
            <TextField testID="password-new" masked value={next()} onChange={value => next.set(value)} maxLength={256} />
          </Field>
          <Field label="Confirm new password">
            <TextField testID="password-confirm" masked value={again()} onChange={value => again.set(value)} maxLength={256} onSubmit={submit} />
          </Field>
        </CardBody>
      </Section>
      <If when={action.signInAgain()}><SignInAgain /></If>
      <SettingsActions action={action} testID="password-save" label={action.busy() ? "Saving…" : changing() ? "Change password" : "Set password"} onPress={submit} />
    </View>
  );
}

function RemovePasswordSection() {
  const current = signal("");
  const action = createGuardedAction();
  async function remove() {
    if (!await confirm({ title: "Remove password", destructive: true, confirmLabel: "Remove password",
      message: "You'll sign in with GitHub only. Browsers and apps signed in with your username and password are signed out." })) return;
    await action.run(async () => {
      const response = await session().api<{ user?: UserProfile }>("/api/me/password", { method: "DELETE", body: current() ? { currentPassword: current() } : {} });
      current.set("");
      if (response.user) updateUser(response.user);
    }, "Password removed. You sign in with GitHub only.");
  }
  return (
    <View style={{ gap: 16 }}>
      <Section title="Remove password" info="Sign in with GitHub only again. Needs your current password, or a GitHub sign-in from the last 15 minutes.">
        <CardBody>
          <Field label="Current password" hint="Or leave it empty within 15 minutes of signing in with GitHub.">
            <TextField masked value={current()} onChange={value => current.set(value)} maxLength={256} />
          </Field>
        </CardBody>
      </Section>
      <If when={action.signInAgain()}><SignInAgain /></If>
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button variant="outline" label={action.busy() ? "Removing…" : "Remove password"} disabled={action.busy()} onPress={() => void remove()} />
      </View>
      <Feedback error={action.error()} notice={action.notice()} />
    </View>
  );
}

export function createPasswordAuth() {
  return createResource<{ passwordAuth?: boolean }>(() => "/api/health");
}

export function Password(_props: SectionProps) {
  const health = createPasswordAuth();
  const user = () => session().user;
  const passwords = () => health.data()?.passwordAuth === true;
  return (
    <SectionPage testID="settings-password">
      <If when={health.data()}
        else={<If when={health.error()} else={<Small>Loading…</Small>}>
          <Banner tone="danger" title="Could not load the server's sign-in settings" actions={<Button small variant="outline" label="Try again" onPress={health.refresh} />}>{health.error()}</Banner>
        </If>}>
        <If when={!passwords()}>
          <Banner tone="info" title="Passwords are off on this server">
            {`Its operator hasn't turned on sign-in with a username and password${user().hasPassword && !user().passwordSignIn ? "; you can still remove the password you set." : "."}`}
          </Banner>
        </If>
        <If when={!user().username}><ChooseUsernameSection /></If>
        <SignInSection passwords={passwords()} />
        <If when={passwords() && user().username}><PasswordForm /></If>
        <If when={user().hasPassword && !user().passwordSignIn}><RemovePasswordSection /></If>
      </If>
    </SectionPage>
  );
}
