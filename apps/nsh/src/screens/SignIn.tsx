import { effect, openUrl, safeArea, Scroll, signal, Text, untracked, View } from "nsh";
import { Dialog, Input } from "nsh/base";
import { WebView } from "nsh";
import { openServerPage } from "../lib/page";
import { errorMessage } from "../shared";
import { auth, checkBrowserSession, restore, signInMethods, signInWithPassword, signInWithToken, signOut, startGitHubSignIn, type GitHubSignIn, type SignInMethods } from "../lib/auth";
import { createAction } from "../lib/resource";
import { displayOrigin, parseOrigin, usesBrowserSession } from "../lib/server";
import { palette } from "../theme";
import { Banner, Button, Small } from "../ui";

const inputStyle = () => ({
  borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16,
  backgroundColor: palette().surface, borderColor: palette().border, color: palette().text, placeholderColor: palette().muted,
});

/** Signed out, or a stored sign-in whose server could not be reached. */
export function SignIn() {
  const state = () => auth();
  const origin = () => {
    const current = state();
    return current.status === "signedOut" || current.status === "unreachable" ? current.origin : "";
  };
  const action = createAction();
  return (
    <View style={{ flex: 1, backgroundColor: palette().background, paddingTop: safeArea().top, paddingBottom: safeArea().bottom }}>
      <If when={state().status === "unreachable" ? state() as Extract<ReturnType<typeof auth>, { status: "unreachable" }> : null}
        else={<SignInForm />}>
        {unreachable => (
          <View style={{ flex: 1, justifyContent: "center", gap: 16, padding: 24, width: "100%", maxWidth: 480, alignSelf: "center" }}>
            <Text style={{ fontSize: 32, fontWeight: "800", color: palette().text }}>Can't reach Pikibun</Text>
            <Banner tone="warning" title={displayOrigin(origin())}>{unreachable().error}</Banner>
            <Button variant="primary" label="Try again" disabled={action.busy()} onPress={() => void restore()} />
            <Button variant="ghost" label={action.busy() ? "Signing out…" : "Sign out"} disabled={action.busy()} onPress={() => void action.run(signOut)} />
          </View>
        )}
      </If>
    </View>
  );
}

function SignInForm() {
  const stored = untracked(() => {
    const current = auth();
    return current.status === "signedOut" ? current.origin : "";
  });
  const server = signal(stored);
  const editingServer = signal(false);
  const developerOpen = signal(false);
  const token = signal("");
  const username = signal("");
  const password = signal("");
  const action = createAction();
  const methods = signal<SignInMethods | null>(null);
  const github = signal<GitHubSignIn | null>(null);
  const parsed = () => parseOrigin(server());
  const origin = () => {
    if (usesBrowserSession) return stored;
    const result = parsed();
    return "origin" in result ? result.origin : null;
  };
  // What this server offers (password sign-in, a test-mode server's tokens), for the server chosen.
  effect(() => {
    const target = origin();
    methods.set(null);
    if (target === null) return;
    const ask = usesBrowserSession ? fetch("/api/health").then(response => response.json() as Promise<SignInMethods>) : signInMethods(target);
    ask.then(value => { if (untracked(origin) === target) methods.set(value); }, () => undefined);
  });
  const notice = () => {
    const current = auth();
    return current.status === "signedOut" ? current.notice : undefined;
  };

  function continueWithGitHub() {
    const target = origin();
    if (target === null) return;
    void action.run(async () => {
      if (usesBrowserSession) {
        // The server's own GitHub sign-in, in place of the app: it sets this browser's session cookie and comes back to
        // the app, which then starts signed in.
        if (!openServerPage("/api/auth/github")) await openUrl(`${target}/api/auth/github`);
        return;
      }
      github.set(await startGitHubSignIn(target));
    });
  }

  /** The web view went somewhere: the server's callback page finishes the sign-in. */
  function navigated(url: string) {
    const attempt = github();
    if (!attempt || !attempt.isCallback(url)) return;
    github.set(null);
    void action.run(() => attempt.finish(url));
  }

  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", gap: 16, padding: 24, width: "100%", maxWidth: 480, alignSelf: "center" }}>
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 32, fontWeight: "800", color: palette().text }}>Pikibun</Text>
        <Text style={{ fontSize: 16, lineHeight: 22, color: palette().muted }}>Run Pi agents on your own machine, and work on them together with your team.</Text>
      </View>
      <If when={notice()}>{text => <Banner tone="warning">{text()}</Banner>}</If>
      <If when={action.error()}>{text => <Banner tone="danger" title="Sign-in problem">{text()}</Banner>}</If>
      <If when={!usesBrowserSession}>
        <View style={{ gap: 6 }}>
          <Small>Server</Small>
          <If when={editingServer()}
            else={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ flexShrink: 1, numberOfLines: 1, fontSize: 16, fontWeight: "600", color: palette().text }}>{origin() ? displayOrigin(origin()!) : server()}</Text>
                <Button testID="server-change" small variant="ghost" label="Change" onPress={() => editingServer.set(true)} />
              </View>
            }>
            <Input testID="server-input" value={server()} onChange={event => server.set(event.value)} autoCapitalize="none" autoCorrect={false} keyboardType="url"
              placeholder="https://pikibun.com" accessibilityLabel="Server address" style={inputStyle()} />
            <If when={"error" in parsed() ? (parsed() as { error: string }).error : null}>
              {error => <Small tone="danger">{error()}</Small>}
            </If>
            <Small>For a self-hosted Pikibun, enter its address.</Small>
          </If>
        </View>
      </If>
      <Button testID="github-sign-in" variant="primary" icon="⌥" label="Continue with GitHub" busy={action.busy() && !developerOpen()}
        disabled={origin() === null || action.busy() || methods()?.githubConfigured === false} onPress={continueWithGitHub} />
      <If when={usesBrowserSession}>
        <Button testID="browser-session-check" label="I've signed in" disabled={action.busy()}
          onPress={() => void action.run(async () => { if (!await checkBrowserSession()) throw new Error("This browser isn't signed in to Pikibun yet."); })} />
      </If>
      <If when={usesBrowserSession && methods()?.passwordAuth}>
        <View style={{ gap: 8, borderTopWidth: 1, paddingTop: 12, borderColor: palette().border }}>
          <Small>Or sign in with a username and password</Small>
          <Input testID="password-username" value={username()} onChange={event => username.set(event.value)} autoCapitalize="none" autoCorrect={false}
            autoComplete="username" placeholder="Username" accessibilityLabel="Username" style={inputStyle()} />
          <Input testID="password-password" value={password()} onChange={event => password.set(event.value)} masked autoComplete="current-password"
            placeholder="Password" accessibilityLabel="Password" style={inputStyle()}
            onSubmit={() => void action.run(() => signInWithPassword(username(), password()))} />
          <Button testID="password-sign-in" label="Sign in" disabled={action.busy() || !username().trim() || !password()}
            onPress={() => void action.run(() => signInWithPassword(username(), password()))} />
        </View>
      </If>
      <Small center>Model credentials stay on your host. GitHub tokens stay on the server, or go only to your own hosts when you push with your account.</Small>
      <If when={!usesBrowserSession && methods()?.testMode}>
        <View style={{ gap: 8, borderTopWidth: 1, paddingTop: 12, borderColor: palette().border }}>
          <View style={{ flexDirection: "row" }}>
            <Button testID="developer-toggle" small variant="ghost" icon={developerOpen() ? "▾" : "▸"} label="Developer sign-in" onPress={() => developerOpen.update(value => !value)} />
          </View>
          <If when={developerOpen()}>
            <Small>This server runs in test mode. Sign in with a token from its POST /api/auth/test.</Small>
            <Input testID="developer-token" value={token()} onChange={event => token.set(event.value)} autoCapitalize="none" autoCorrect={false} masked autoComplete="off"
              placeholder="Test-mode token" accessibilityLabel="Test-mode token" style={inputStyle()} />
            <Button testID="developer-sign-in" label="Sign in with token" icon="⚿" busy={action.busy() && developerOpen()} disabled={origin() === null || !token().trim() || action.busy()}
              onPress={() => void action.run(async () => {
                try {
                  await signInWithToken(origin()!, token());
                } catch (reason) {
                  throw new Error(`Developer sign-in failed: ${errorMessage(reason)}`);
                }
              })} />
          </If>
        </View>
      </If>
      <Small center>
        {usesBrowserSession
          ? "On the web this app uses the server's own browser sign-in."
          : "Your sign-in is kept in this app's storage on this device (NSH has no Keychain or Keystore storage yet)."}
      </Small>
      <Dialog open={github() !== null} onOpenChange={event => { if (!event.open) github.set(null); }}
        style={{ flex: 1, backgroundColor: palette().background }} presentation="pageSheet">
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, minHeight: 52, borderBottomWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
            <Text style={{ flex: 1, fontSize: 17, fontWeight: "700", color: palette().text }}>Sign in with GitHub</Text>
            <Button small variant="ghost" label="Cancel" onPress={() => github.set(null)} />
          </View>
          <If when={github()}>
            {attempt => <WebView src={attempt().url} style={{ flex: 1 }} onNavigationStateChange={event => navigated(event.url)} />}
          </If>
        </View>
      </Dialog>
    </Scroll>
  );
}
