import { Scroll, signal, Text, untracked, View } from "nsh";
import { errorMessage } from "../shared";
import { session, signOut, updateUser } from "../lib/auth";
import { createResource } from "../lib/resource";
import { canSignInAgain, chooseUsername, needsRecentSignIn, signInWithGitHubAgain, suggestedUsername } from "../lib/sign-in-again";
import { palette, text, weight } from "../theme";
import { Field, TextField } from "../form";
import { Logo } from "../logo";
import { Banner, Button, Feedback, Loading } from "../ui";

export function UsernameSetup() {
  const user = () => session().user;
  const health = createResource<{ passwordAuth?: boolean }>(() => "/api/health");
  const username = signal(suggestedUsername(untracked(user).githubLogin));
  const password = signal("");
  const again = signal("");
  const busy = signal(false);
  const error = signal("");
  const signInAgain = signal(false);
  const passwords = () => health.data()?.passwordAuth === true;
  function submit() {
    if (busy()) return;
    if (password() && password() !== again()) { error.set("The passwords don't match."); return; }
    busy.set(true);
    error.set("");
    signInAgain.set(false);
    chooseUsername(username(), passwords() ? password() : undefined).then(updateUser, reason => {
      error.set(errorMessage(reason));
      signInAgain.set(needsRecentSignIn(reason));
      busy.set(false);
    });
  }
  return (
    <View testID="username-setup" style={{ flex: 1, backgroundColor: palette().background }}>
      <If when={!(health.loading() && !health.data())} else={<Loading />}>
        <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", paddingVertical: 40, paddingHorizontal: 24 }}>
          <View style={{ width: "100%", maxWidth: 420, gap: 20 }}>
            <View style={{ alignItems: "center" }}><Logo size={40} /></View>
            <Text role="header" style={{ fontSize: text.heading, fontWeight: weight.light, textAlign: "center", color: palette().text }}>Choose your username</Text>
            <Text style={{ fontSize: text.body, lineHeight: 21, textAlign: "center", color: palette().muted }}>
              {`Welcome${user().displayName ? `, ${user().displayName}` : ""}. Teammates find and name you by your username on this Pikibun${passwords() ? ", and you can sign in with it" : ""}. It can't be changed later.`}
            </Text>
            <Field label="Username" hint="3 to 39 lowercase letters, digits, - and _, starting with a letter or digit.">
              <TextField testID="username-input" value={username()} onChange={value => username.set(value)} autoCapitalize="none" autoCorrect={false} maxLength={60} autoFocus onSubmit={submit} />
            </Field>
            <If when={passwords()}>
              <Text style={{ fontSize: text.small, textAlign: "center", color: palette().muted }}>optional</Text>
              <Field label="Password" hint="To also sign in with your username and password, not only GitHub. At least 12 characters. Leave it empty to set one later under Settings → Password.">
                <TextField masked value={password()} onChange={value => password.set(value)} maxLength={256} />
              </Field>
              <If when={password()}>
                <Field label="Confirm password"><TextField masked value={again()} onChange={value => again.set(value)} maxLength={256} onSubmit={submit} /></Field>
              </If>
            </If>
            <Feedback error={error()} />
            <If when={signInAgain()}>
              <Banner tone="info" title="Sign in with GitHub again to set a password"
                actions={canSignInAgain ? <Button small variant="outline" label="Sign in with GitHub again" onPress={signInWithGitHubAgain} /> : undefined}>
                Or leave the password empty for now, and set it later under Settings → Password.
              </Banner>
            </If>
            <Button testID="username-continue" block large variant="primary" label={busy() ? "Saving…" : "Continue"} disabled={busy()} onPress={submit} />
            <Button small variant="ghost" label="Sign out" disabled={busy()} onPress={() => void signOut()} />
          </View>
        </Scroll>
      </If>
    </View>
  );
}
