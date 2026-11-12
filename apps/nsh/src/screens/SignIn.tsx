import { cleanup, effect, openUrl, safeArea, Scroll, signal, Text, untracked, UrlScheme, View, WebView } from "nsh";
import { Dialog, Input } from "nsh/base";
import { authorizeInPage, openServerPage, pageQuery } from "../lib/page";
import { errorMessage } from "../shared";
import {
  auth, checkBrowserSession, isSignInLink, localSignInToken, restore, signInMethods, signInToLocalServer, signInWithPassword, signInWithToken, signOut, signUpWithPassword,
  startGitHubInviteSignIn, startGitHubSignIn, type GitHubSignIn, type SignInMethods,
} from "../lib/auth";
import { createAction } from "../lib/resource";
import { displayOrigin, parseOrigin, usesBrowserSession } from "../lib/server";
import { rememberInvite } from "../lib/sign-in-memory";
import { computerName, hostsHere } from "../lib/this-computer";
import { thisServer } from "../lib/this-server";
import { ThisServerPanel } from "../settings/SelfHost";
import { palette, radius, text } from "../theme";
import { Logo } from "../logo";
import { Banner, Button, Small } from "../ui";

const inputStyle = () => ({
  borderWidth: 1, borderRadius: radius.medium, paddingHorizontal: 12, height: 40, fontSize: text.reading,
  backgroundColor: palette().surface, borderColor: palette().borderStrong, color: palette().text, placeholderColor: palette().faint,
});

export function SignIn(props: { inviteToken?: string }) {
  const state = () => auth();
  const origin = () => {
    const current = state();
    return current.status === "signedOut" || current.status === "unreachable" ? current.origin : "";
  };
  const action = createAction();
  const selfHostOpen = signal(false);
  const loopback = () => selfHosting && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin());
  return (
    <View style={{ flex: 1, backgroundColor: palette().background, paddingTop: safeArea().top, paddingBottom: safeArea().bottom }}>
      <If when={state().status === "unreachable" ? state() as Extract<ReturnType<typeof auth>, { status: "unreachable" }> : null}
        else={<SignInForm inviteToken={props.inviteToken} />}>
        {unreachable => (
          <View style={{ flex: 1, justifyContent: "center", gap: 16, padding: 24, width: "100%", maxWidth: 480, alignSelf: "center" }}>
            <Logo size={44} />
            <Text style={{ fontSize: 26, fontWeight: "300", color: palette().text }}>Can't reach Pikibun</Text>
            <Banner tone="warning" title={displayOrigin(origin())}>{unreachable().error}</Banner>
            <Button variant="primary" label="Try again" disabled={action.busy()} onPress={() => void restore()} />
            <If when={loopback()}>
              <Button testID="unreachable-self-host" variant="outline" icon="database" label={`Pikibun on ${computerName}`} onPress={() => selfHostOpen.set(true)} />
            </If>
            <Button variant="ghost" label={action.busy() ? "Signing out…" : "Sign out"} disabled={action.busy()} onPress={() => void action.run(signOut)} />
            <SelfHostSheet open={selfHostOpen()} onClose={() => selfHostOpen.set(false)} onUse={() => { selfHostOpen.set(false); void restore(); }} />
          </View>
        )}
      </If>
    </View>
  );
}

const selfHosting = !usesBrowserSession && hostsHere;

function SelfHostSheet(props: { open: boolean; onClose: () => void; onUse: (origin: string) => void }) {
  return (
    <If when={selfHosting}>
      <Dialog open={props.open} onOpenChange={event => { if (!event.open) props.onClose(); }}
        style={{ flex: 1, backgroundColor: palette().background }} presentation="pageSheet">
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, minHeight: 52, borderBottomWidth: 1, borderColor: palette().border }}>
            <Text style={{ flex: 1, fontSize: 14, fontWeight: "500", color: palette().text }}>{`Pikibun on ${computerName}`}</Text>
            <Button testID="sign-in-self-host-close" small variant="ghost" label="Close" onPress={props.onClose} />
          </View>
          <If when={props.open}>
            <ThisServerPanel server={thisServer()} onUse={props.onUse} />
          </If>
        </View>
      </Dialog>
    </If>
  );
}

function SignInForm(props: { inviteToken?: string }) {
  const stored = untracked(() => {
    const current = auth();
    return current.status === "signedOut" ? current.origin : "";
  });
  const server = signal(stored);
  const editingServer = signal(false);
  const developerOpen = signal(false);
  const token = signal("");
  const localLink = signal("");
  const username = signal("");
  const password = signal("");
  const confirmPassword = signal("");
  const passwordMode = signal<"signin" | "signup">("signin");
  const action = createAction();
  const methods = signal<SignInMethods | null>(null);
  const github = signal<GitHubSignIn | null>(null);
  const callbackError = signal("");
  const selfHostOpen = signal(false);
  const parsed = () => parseOrigin(server());
  const origin = () => {
    if (usesBrowserSession) return stored;
    const result = parsed();
    return "origin" in result ? result.origin : null;
  };
  effect(() => {
    if (usesBrowserSession && props.inviteToken) void rememberInvite(props.inviteToken);
  });
  if (usesBrowserSession) void pageQuery().then(query => callbackError.set(query.get("error")?.slice(0, 300) ?? ""));
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
  const invited = () => usesBrowserSession && props.inviteToken !== undefined;
  const githubUnconfigured = () => methods()?.githubConfigured === false;
  const passwords = () => methods()?.passwordAuth === true;
  const unconfigured = () => githubUnconfigured() && !passwords();
  const local = () => methods()?.localServer;
  const ownToken = () => {
    const target = origin();
    return selfHosting && target ? thisServer().signInTokenFor(target) : undefined;
  };
  const ownServer = () => (selfHosting ? thisServer().running() : undefined);
  const useServer = (address: string) => { server.set(address); editingServer.set(false); selfHostOpen.set(false); };
  const signInToOwnServer = (address: string) => {
    useServer(address);
    const signInToken = thisServer().signInTokenFor(address);
    if (signInToken) void action.run(() => signInToLocalServer(address, signInToken));
  };
  const passwordSignup = () => methods()?.passwordSignup ?? "off";
  const canSignUp = () => usesBrowserSession && passwords() && (passwordSignup() === "open" || (passwordSignup() === "invite" && invited()));
  const signingUp = () => passwordMode() === "signup" && canSignUp();
  const signupHint = () => {
    const current = methods();
    if (!usesBrowserSession || invited() || !current) return "";
    const offered = [...(!githubUnconfigured() && !current.localServer ? [current.githubSignup ?? "open"] : []), ...(passwords() ? [passwordSignup()] : [])];
    return offered.includes("open") ? "" : offered.includes("invite") ? "New here? Open the invite link a workspace owner or admin shared with you to create an account."
      : "This Pikibun doesn't take new accounts. If you have one, sign in.";
  };

  function continueWithGitHub() {
    const target = origin();
    if (target === null) return;
    void action.run(async () => {
      if (usesBrowserSession) {
        if (props.inviteToken !== undefined) {
          const url = await startGitHubInviteSignIn(props.inviteToken);
          if (!authorizeInPage(url)) await openUrl(url);
          return;
        }
        if (!openServerPage("/api/auth/github")) await openUrl(`${target}/api/auth/github`);
        return;
      }
      const attempt = await startGitHubSignIn(target);
      github.set(attempt);
      await openUrl(attempt.url);
    });
  }

  function signInInApp() {
    const target = origin();
    if (target === null) return;
    void action.run(async () => { github.set(await startGitHubSignIn(target, { inApp: true })); });
  }

  function signInLocally() {
    const target = origin();
    if (target === null || action.busy()) return;
    const signInToken = ownToken() ?? localSignInToken(target, localLink());
    void action.run(async () => {
      if (!signInToken) throw new Error("That isn't this Pikibun's sign-in link. Paste the whole link pikibun serve printed when it started.");
      await signInToLocalServer(target, signInToken);
      localLink.set("");
    });
  }

  if (!usesBrowserSession) {
    cleanup(UrlScheme.on("open", ({ url }) => {
      if (!isSignInLink(url)) return;
      const attempt = untracked(github);
      if (attempt?.inApp) {
        void action.run(async () => { throw new Error("That sign-in link is from the browser you left. Finish signing in on GitHub's page here, or cancel it and continue with GitHub again."); });
        return;
      }
      if (!attempt) {
        void action.run(async () => { throw new Error("That sign-in link isn't from a sign-in this app started. Continue with GitHub again."); });
        return;
      }
      if (!attempt.owns(url)) {
        void action.run(async () => { throw new Error("That sign-in link did not match this attempt. Finish signing in in the browser this app opened."); });
        return;
      }
      github.set(null);
      void action.run(() => attempt.finish(url));
    }));
  }

  function submitPassword() {
    const target = origin();
    if (action.busy() || target === null || !username().trim() || !password()) return;
    if (signingUp()) {
      if (password() !== confirmPassword()) { void action.run(async () => { throw new Error("The passwords don't match."); }); return; }
      void action.run(() => signUpWithPassword(username(), password(), props.inviteToken));
      return;
    }
    void action.run(() => signInWithPassword(target, username(), password()));
  }

  function navigated(url: string) {
    const attempt = github();
    if (!attempt || !attempt.isCallback(url)) return;
    github.set(null);
    void action.run(() => attempt.finish(url));
  }

  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", gap: 14, padding: 24, width: "100%", maxWidth: 420, alignSelf: "center" }}>
      <View style={{ gap: 10, alignItems: "center", paddingBottom: 8 }}>
        <Logo size={56} />
        <Text style={{ fontSize: 26, fontWeight: "300", color: palette().text, textAlign: "center" }}>Sign in to Pikibun</Text>
        <Text style={{ fontSize: text.reading, lineHeight: 22, color: palette().muted, textAlign: "center" }}>Run Pi agents on your own machines, and work on them together with your team.</Text>
      </View>
      <If when={invited()}>
        <Banner testID="sign-in-invited" tone="info" title="You're invited to a workspace">Sign in to ask to join it. An owner or admin accepts you before you can see anything in it.</Banner>
      </If>
      <If when={notice()}>{text => <Banner tone="warning">{text()}</Banner>}</If>
      <If when={action.error() || (callbackError() ? `GitHub sign-in did not complete: ${callbackError()}` : "")}>
        {text => <Banner testID="sign-in-problem" tone="danger" title="Sign-in problem">{text()}</Banner>}
      </If>
      <If when={usesBrowserSession && unconfigured() && !local()}>
        <Banner tone="warning" title="GitHub sign-in is not configured">The operator needs to configure the GitHub OAuth app, its callback URL and the server's GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and VAULT_KEY settings.</Banner>
      </If>
      <If when={usesBrowserSession && local()}>
        <Banner testID="sign-in-local-link" tone="info" title="This Pikibun runs on its owner's computer">Sign in with the link `pikibun serve` printed when it started, or from the Pikibun app that runs it. No GitHub or other account is needed.</Banner>
      </If>
      <If when={!usesBrowserSession}>
        <View style={{ gap: 6 }}>
          <Small>Server</Small>
          <If when={editingServer()}
            else={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ flexShrink: 1, numberOfLines: 1, fontSize: 16, fontWeight: "500", color: palette().text }}>{origin() ? displayOrigin(origin()!) : server()}</Text>
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
          <If when={selfHosting}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <If when={ownServer() && ownServer() !== origin() ? ownServer() : null}>
                {running => <Button testID="sign-in-self-host-use" small variant="outline" icon="database" label={`Use Pikibun on ${computerName}`} onPress={() => signInToOwnServer(running())} />}
              </If>
              <Button testID="sign-in-self-host" small variant="ghost" icon="database" label={ownServer() ? `Pikibun on ${computerName}` : `Run Pikibun on ${computerName}`}
                onPress={() => selfHostOpen.set(true)} />
            </View>
          </If>
        </View>
      </If>
      <If when={passwords()}>
        <View testID="password-form" style={{ gap: 8 }}>
          <Input testID="password-username" value={username()} onChange={event => username.set(event.value)} autoCapitalize="none" autoCorrect={false}
            autoComplete="username" placeholder="Username" accessibilityLabel="Username" style={inputStyle()} maxLength={60} />
          <If when={signingUp()}><Small>3 to 39 letters, digits, - and _. Your user ID is password: and this name; it can't be changed.</Small></If>
          <Input testID="password-password" value={password()} onChange={event => password.set(event.value)} masked autoComplete={signingUp() ? "new-password" : "current-password"}
            placeholder="Password" accessibilityLabel="Password" style={inputStyle()} maxLength={256} onSubmit={() => { if (!signingUp()) submitPassword(); }} />
          <If when={signingUp()}>
            <Small>At least 12 characters. A few unrelated words make a good one.</Small>
            <Input testID="password-confirm" value={confirmPassword()} onChange={event => confirmPassword.set(event.value)} masked autoComplete="new-password"
              placeholder="Confirm password" accessibilityLabel="Confirm password" style={inputStyle()} maxLength={256} onSubmit={submitPassword} />
          </If>
          <Button testID="password-sign-in" variant={githubUnconfigured() ? "primary" : "default"} large block
            label={action.busy() ? (signingUp() ? "Creating account" : "Signing in") : signingUp() ? "Create account" : "Sign in"} busy={action.busy() && !developerOpen()}
            disabled={origin() === null || action.busy() || !username().trim() || !password() || (signingUp() && (password().length < 12 || !confirmPassword()))}
            onPress={submitPassword} />
          <If when={canSignUp()}>
            <Button testID="password-mode" small variant="ghost" label={signingUp() ? "Have an account? Sign in" : "New here? Create an account"} disabled={action.busy()}
              onPress={() => { passwordMode.set(signingUp() ? "signin" : "signup"); confirmPassword.set(""); action.clear(); }} />
          </If>
          <If when={signingUp() && invited()}>
            <Small>Creating an account asks to join the workspace that invited you. An owner or admin accepts you before you can see anything in it.</Small>
          </If>
        </View>
        <If when={!githubUnconfigured()}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: palette().border }} />
            <Small>or</Small>
            <View style={{ flex: 1, height: 1, backgroundColor: palette().border }} />
          </View>
        </If>
      </If>
      <If when={!usesBrowserSession && local()}>
        <If when={ownToken()}
          else={
            <View testID="local-sign-in" style={{ gap: 8 }}>
              <Small>{`This Pikibun runs on ${computerName}. Paste the sign-in link pikibun serve printed when it started.`}</Small>
              <Input testID="local-link" value={localLink()} onChange={event => localLink.set(event.value)} autoCapitalize="none" autoCorrect={false} masked autoComplete="off"
                placeholder="http://127.0.0.1:7878/api/auth/local?token=…" accessibilityLabel="Sign-in link" style={inputStyle()} onSubmit={signInLocally} />
              <Button testID="local-link-sign-in" variant="primary" large block label={action.busy() ? "Signing in" : "Sign in"} busy={action.busy() && !developerOpen()}
                disabled={origin() === null || action.busy() || !localLink().trim()} onPress={signInLocally} />
            </View>
          }>
          <Button testID="sign-in-self-host-sign-in" variant="primary" large block icon="database" label={`Sign in to Pikibun on ${computerName}`} busy={action.busy() && !developerOpen()}
            disabled={origin() === null || action.busy()} onPress={signInLocally} />
        </If>
      </If>
      <If when={!local() && !(githubUnconfigured() && (usesBrowserSession || passwords()))}>
        <Button testID="github-sign-in" variant="primary" large block icon="github" label="Continue with GitHub" busy={action.busy() && !developerOpen()}
          disabled={origin() === null || action.busy() || githubUnconfigured()} onPress={continueWithGitHub} />
      </If>
      <If when={github() && !github()!.inApp ? github() : null}>
        {attempt => (
          <Banner testID="github-browser-wait" tone="info" title="Finish signing in in your browser"
            actions={<>
              <Button small variant="ghost" label="Open it again" onPress={() => void openUrl(attempt().url)} />
              <Button testID="github-in-app" small variant="ghost" label="Sign in here instead" disabled={action.busy()} onPress={signInInApp} />
              <Button small variant="ghost" label="Cancel" onPress={() => github.set(null)} />
            </>}>
            GitHub's page opened in your browser. Pikibun comes back here once you've signed in there.
          </Banner>
        )}
      </If>
      <If when={usesBrowserSession && !githubUnconfigured()}>
        <Button testID="browser-session-check" block label="I've signed in" disabled={action.busy()}
          onPress={() => void action.run(async () => { if (!await checkBrowserSession()) throw new Error("This browser isn't signed in to Pikibun yet."); })} />
      </If>
      <If when={signupHint()}>{hint => <Small center testID="sign-up-hint">{hint()}</Small>}</If>
      <If when={usesBrowserSession && (callbackError() || unconfigured())}>
        <Button block variant="ghost" label="Try again" disabled={action.busy()} onPress={() => { callbackError.set(""); void restore(); }} />
      </If>
      <Small center>
        {`Model credentials stay on your host. GitHub tokens stay on the server, or go only to your own hosts when you push with your account.${passwords() && !githubUnconfigured()
          ? " Repositories on github.com need the GitHub sign-in; a password account reaches other Git providers with their tokens." : ""}`}
      </Small>
      <If when={!usesBrowserSession && methods()?.testMode}>
        <View style={{ gap: 8, borderTopWidth: 1, paddingTop: 12, borderColor: palette().border }}>
          <View style={{ flexDirection: "row" }}>
            <Button testID="developer-toggle" small variant="ghost" icon={developerOpen() ? "chevron-down" : "chevron-right"} label="Developer sign-in" onPress={() => developerOpen.update(value => !value)} />
          </View>
          <If when={developerOpen()}>
            <Small>This server runs in test mode. Sign in with a token from its POST /api/auth/test.</Small>
            <Input testID="developer-token" value={token()} onChange={event => token.set(event.value)} autoCapitalize="none" autoCorrect={false} masked autoComplete="off"
              placeholder="Test-mode token" accessibilityLabel="Test-mode token" style={inputStyle()} />
            <Button testID="developer-sign-in" label="Sign in with token" icon="lock" busy={action.busy() && developerOpen()} disabled={origin() === null || !token().trim() || action.busy()}
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
      <SelfHostSheet open={selfHostOpen()} onClose={() => selfHostOpen.set(false)} onUse={signInToOwnServer} />
      <Dialog open={github()?.inApp === true} onOpenChange={event => { if (!event.open) github.set(null); }}
        style={{ flex: 1, backgroundColor: palette().background }} presentation="pageSheet">
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, minHeight: 52, borderBottomWidth: 1, borderColor: palette().border }}>
            <Text style={{ flex: 1, fontSize: 14, fontWeight: "500", color: palette().text }}>Sign in with GitHub</Text>
            <Button small variant="ghost" label="Cancel" onPress={() => github.set(null)} />
          </View>
          <If when={github()?.inApp ? github() : null}>
            {attempt => <WebView src={attempt().url} style={{ flex: 1 }} onNavigationStateChange={event => navigated(event.url)} />}
          </If>
        </View>
      </Dialog>
    </Scroll>
  );
}
