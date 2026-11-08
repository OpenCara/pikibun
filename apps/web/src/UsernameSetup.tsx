import { useState, type FormEvent } from "react";
import type { UserProfile } from "../../../packages/shared/src/types";
import { api, errorMessage } from "./api";
import { Logo } from "./icons";
import { needsRecentSignIn, signInWithGitHubAgain, suggestedUsername } from "./sign-in-again";
import { Alert, Button, Feedback, Field, PageLoading, useResource } from "./ui";

/** Chooses the signed-in account's username, once, with an optional password; answers with the updated profile. */
export async function chooseUsername(username: string, password?: string): Promise<UserProfile> {
  const body: Record<string, string> = { username: username.trim().toLowerCase() };
  if (password) body.password = password;
  return (await api<{ user: UserProfile }>("/api/me/username", { method: "POST", body })).user;
}

/**
 * The step after a GitHub sign-up, before anything else in the app: a unique username, which teammates know the person
 * by and which can't be changed later, and, where the server takes passwords, an optional password to sign in with that
 * username later, next to GitHub.
 */
export function UsernameSetup({ user, setUser, signOut }: { user: UserProfile; setUser: (user: UserProfile) => void; signOut: () => void }) {
  const health = useResource<{ passwordAuth?: boolean }>("/api/health");
  const [username, setUsername] = useState(() => suggestedUsername(user.githubLogin));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signInAgain, setSignInAgain] = useState(false);
  if (health.loading && !health.data) return <PageLoading />;
  const passwords = health.data?.passwordAuth === true;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (password && password !== confirm) { setError("The passwords don't match."); return; }
    setBusy(true);
    setError("");
    setSignInAgain(false);
    chooseUsername(username, passwords ? password : undefined).then(setUser, reason => {
      setError(errorMessage(reason));
      setSignInAgain(needsRecentSignIn(reason));
      setBusy(false);
    });
  }
  return <div className="welcome">
    <main id="main-content" className="welcome-inner" tabIndex={-1}>
      <Logo size={40} />
      <h1>Choose your username</h1>
      <p>Welcome{user.displayName ? `, ${user.displayName}` : ""}. Teammates find and name you by your username on this Pikibun{passwords ? ", and you can sign in with it" : ""}. It can't be changed later.</p>
      <form className="password-sign-in" onSubmit={submit}>
        <Field label="Username" hint="3 to 39 lowercase letters, digits, - and _, starting with a letter or digit.">
          <input className="input" required autoFocus value={username} onChange={event => setUsername(event.target.value)}
            autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={60} />
        </Field>
        {passwords && <>
          <div className="sign-in-divider" role="separator">optional</div>
          <Field label="Password" hint="To also sign in with your username and password, not only GitHub. At least 12 characters. Leave it empty to set one later under Settings → Password.">
            <input className="input" type="password" value={password} onChange={event => setPassword(event.target.value)}
              autoComplete="new-password" minLength={12} maxLength={256} />
          </Field>
          {password && <Field label="Confirm password">
            <input className="input" type="password" required value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="new-password" maxLength={256} />
          </Field>}
        </>}
        <Feedback error={error} />
        {signInAgain && <Alert variant="info" title="Sign in with GitHub again to set a password"
          actions={<Button variant="outline" size="sm" onClick={signInWithGitHubAgain}>Sign in with GitHub again</Button>}>
          Or leave the password empty for now, and set it later under Settings → Password.
        </Alert>}
        <Button type="submit" variant="default" size="lg" block disabled={busy}>{busy ? "Saving..." : "Continue"}</Button>
        <Button variant="ghost" size="sm" onClick={signOut} disabled={busy}>Sign out</Button>
      </form>
    </main>
  </div>;
}
