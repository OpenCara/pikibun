import { useState, type FormEvent } from "react";
import type { UserProfile } from "../../../../packages/shared/src/types";
import { api } from "../api";
import { useApp } from "../app-context";
import { needsRecentSignIn, signInWithGitHubAgain, suggestedUsername } from "../sign-in-again";
import { Alert, Button, CardBody, confirmDialog, Feedback, Field, Loading, Row, Section, useAction, useResource } from "../ui";
import { chooseUsername } from "../UsernameSetup";
import "./settings.css";

/** Runs a change that may need a recent GitHub sign-in, and says whether it did, for the "Sign in with GitHub again" offer. */
function useGuardedAction() {
  const action = useAction();
  const [signInAgain, setSignInAgain] = useState(false);
  function run(work: () => Promise<void>, success: string) {
    setSignInAgain(false);
    return action.run(async () => {
      try { await work(); } catch (reason) { setSignInAgain(needsRecentSignIn(reason)); throw reason; }
    }, success);
  }
  return { ...action, run, signInAgain };
}

function SignInAgain() {
  return <Alert variant="info" title="Sign in with GitHub again"
    actions={<Button variant="outline" size="sm" onClick={signInWithGitHubAgain}>Sign in with GitHub again</Button>}>
    A GitHub sign-in from the last 15 minutes stands in for your current password. You come back here afterwards.
  </Alert>;
}

/** Only for an account without a username yet, such as a test account: GitHub accounts choose theirs before using the app. */
function ChooseUsernameSection() {
  const { user, setUser } = useApp();
  const [username, setUsername] = useState(() => suggestedUsername(user.githubLogin));
  const action = useAction();
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => setUser(await chooseUsername(username)), "Username saved.");
  }
  return <form className="settings-form" onSubmit={submit}>
    <Section title="Username" info="You sign in with your username and password, and teammates find you by it. It can't be changed later.">
      <CardBody>
        <Field label="Username" hint="3 to 39 lowercase letters, digits, - and _, starting with a letter or digit.">
          <input className="input" required value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={60} />
        </Field>
      </CardBody>
    </Section>
    <div className="settings-actions">
      <Feedback {...action} />
      <span className="spacer" />
      <Button type="submit" variant="default" disabled={action.busy}>{action.busy ? "Saving..." : "Choose username"}</Button>
    </div>
  </form>;
}

/** How this account signs in: its username, GitHub, and whether it has a password. */
function SignInSection({ passwords }: { passwords: boolean }) {
  const { user } = useApp();
  const github = user.githubId !== null;
  return <Section title="Sign-in" info="The ways you can sign in to this Pikibun.">
    <Row title="Username" hint={user.username ? <code>{user.username}</code> : "Not chosen yet"} />
    {github && <Row title="GitHub" hint={user.githubLogin ? `@${user.githubLogin}` : "Connected"} />}
    <Row title="Password" hint={user.hasPassword
      ? (passwords ? "Set: you can sign in with your username and password" : "Set, but this server doesn't take passwords now")
      : (passwords ? "Not set: you sign in with GitHub only" : "This server doesn't offer passwords")} />
  </Section>;
}

/**
 * Sets the first password, or changes it. A password account needs its current one. A GitHub account can give its
 * current one or, within 15 minutes of signing in with GitHub, leave it out: a forgotten password is replaced that way.
 */
function PasswordForm() {
  const { user, setUser } = useApp();
  const changing = !!user.hasPassword;
  const github = !user.passwordSignIn;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const action = useGuardedAction();
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      if (next !== confirm) throw new Error("The new passwords don't match.");
      const body: Record<string, string> = { newPassword: next };
      if (current) body.currentPassword = current;
      const response = await api<{ user?: UserProfile }>("/api/me/password", { method: "POST", body });
      setCurrent("");
      setNext("");
      setConfirm("");
      if (response.user) setUser(response.user);
    }, changing ? "Password changed. Your other browsers and apps are signed out." : "Password set. You can now sign in with your username and this password.");
  }
  const info = changing
    ? "Changing your password signs out every other browser and app signed in as you."
    : "Sign in with your username and this password, besides GitHub. Setting it needs a GitHub sign-in from the last 15 minutes.";
  return <form className="settings-form" onSubmit={submit}>
    <Section title={changing ? "Change password" : "Set a password"} info={info}>
      <CardBody>
        {/* A hidden username lets password managers save the pair. */}
        <input type="text" hidden readOnly value={user.username ?? ""} autoComplete="username" />
        {changing && <Field label="Current password" hint={github ? "Forgot it? Leave this empty within 15 minutes of signing in with GitHub." : undefined}>
          <input className="input" type="password" required={!github} value={current} onChange={event => setCurrent(event.target.value)} autoComplete="current-password" maxLength={256} />
        </Field>}
        <Field label="New password" hint="At least 12 characters, other than your username. A few unrelated words make a good one.">
          <input className="input" type="password" required minLength={12} maxLength={256} value={next} onChange={event => setNext(event.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password">
          <input className="input" type="password" required maxLength={256} value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="new-password" />
        </Field>
      </CardBody>
    </Section>
    {action.signInAgain && <SignInAgain />}
    <div className="settings-actions">
      <Feedback error={action.error} notice={action.notice} />
      <span className="spacer" />
      <Button type="submit" variant="default" disabled={action.busy}>{action.busy ? "Saving..." : changing ? "Change password" : "Set password"}</Button>
    </div>
  </form>;
}

/** A GitHub account goes back to signing in with GitHub only; browsers and apps signed in with the password are signed out. */
function RemovePasswordSection() {
  const { setUser } = useApp();
  const [current, setCurrent] = useState("");
  const action = useGuardedAction();
  async function remove() {
    const confirmed = await confirmDialog({ title: "Remove password", destructive: true, confirmLabel: "Remove password",
      message: "You'll sign in with GitHub only. Browsers and apps signed in with your username and password are signed out." });
    if (!confirmed) return;
    await action.run(async () => {
      const response = await api<{ user?: UserProfile }>("/api/me/password", { method: "DELETE", body: current ? { currentPassword: current } : {} });
      setCurrent("");
      if (response.user) setUser(response.user);
    }, "Password removed. You sign in with GitHub only.");
  }
  return <>
    <Section title="Remove password" info="Sign in with GitHub only again. Needs your current password, or a GitHub sign-in from the last 15 minutes.">
      <CardBody>
        <Field label="Current password" hint="Or leave it empty within 15 minutes of signing in with GitHub.">
          <input className="input" type="password" value={current} onChange={event => setCurrent(event.target.value)} autoComplete="current-password" maxLength={256} />
        </Field>
      </CardBody>
    </Section>
    {action.signInAgain && <SignInAgain />}
    <div className="settings-actions">
      <Feedback error={action.error} notice={action.notice} />
      <span className="spacer" />
      <Button variant="outline" disabled={action.busy} onClick={() => void remove()}>{action.busy ? "Removing..." : "Remove password"}</Button>
    </div>
  </>;
}

/** Settings → Password: the account's username, and setting, changing or removing its password. */
export function PasswordSettings() {
  const { user } = useApp();
  const health = useResource<{ passwordAuth?: boolean }>("/api/health");
  if (!health.data) return health.error ? <Alert variant="error" title="Could not load the server's sign-in settings" actions={<Button size="sm" onClick={health.refresh}>Try again</Button>}>{health.error}</Alert> : <Loading />;
  const passwords = health.data.passwordAuth === true;
  return <>
    {!passwords && <Alert variant="info" title="Passwords are off on this server">Its operator hasn't turned on sign-in with a username and password{user.hasPassword && !user.passwordSignIn ? "; you can still remove the password you set." : "."}</Alert>}
    {!user.username && <ChooseUsernameSection />}
    <SignInSection passwords={passwords} />
    {passwords && user.username && <PasswordForm />}
    {user.hasPassword && !user.passwordSignIn && <RemovePasswordSection />}
  </>;
}
