import { cleanup, effect, openUrl, safeArea, Scroll, signal, Text, untracked, UrlScheme, View } from "nsh";
import { Dialog, Input } from "nsh/base";
import { authorizeInPage, openServerPage, pageQuery } from "../lib/page";
import { errorMessage } from "../shared";
import {
  auth, checkBrowserSession, isCodeLink, parseSignInCode, parseSignInLink, refusedLinkServer, restore, servers, signInMethods, signInToLocalServer, signInWithCode, signInWithPassword,
  signInWithToken, signOut, signUpWithPassword, startGitHubInviteSignIn, switchServer, type SignInMethods,
} from "../lib/auth";
import { createAction } from "../lib/resource";
import { displayOrigin, usesBrowserSession } from "../lib/server";
import { rememberInvite } from "../lib/sign-in-memory";
import { computerName, hostsHere } from "../lib/this-computer";
import { signInToThisServer, thisServer } from "../lib/this-server";
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
            <SignedInServers except={origin()} busy={action.busy()} onSwitch={target => void action.run(() => switchServer(target))} />
            <If when={action.error()}>{text => <Banner testID="switch-problem" tone="danger">{text()}</Banner>}</If>
            <SelfHostSheet open={selfHostOpen()} onClose={() => selfHostOpen.set(false)} onUse={() => { selfHostOpen.set(false); void restore(); }} />
          </View>
        )}
      </If>
    </View>
  );
}

const selfHosting = !usesBrowserSession && hostsHere;

function SignedInServers(props: { except?: string; busy: boolean; onSwitch: (origin: string) => void }) {
  const others = () => (usesBrowserSession ? [] : servers().filter(item => item.origin !== props.except));
  return (
    <If when={others().length > 0}>
      <View testID="signed-in-servers" style={{ gap: 6 }}>
        <Small>Servers this app is signed in to</Small>
        <Each of={others()} key={item => item.origin}>
          {item => (
            <Button testID={`switch-server-${displayOrigin(item().origin)}`} block variant="outline" icon="server" disabled={props.busy}
              label={`${displayOrigin(item().origin)} · ${item().account}`} onPress={() => props.onSwitch(item().origin)} />
          )}
        </Each>
      </View>
    </If>
  );
}

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
  const origin = untracked(() => {
    const current = auth();
    return current.status === "signedOut" ? current.origin : "";
  });
  const fresh = untracked(() => {
    const current = auth();
    return current.status === "signedOut" && current.fresh === true;
  });
  const lastServer = fresh ? null : origin;
  const ownFirst = signal(selfHosting && fresh);
  const developerOpen = signal(false);
  const token = signal("");
  const username = signal("");
  const password = signal("");
  const confirmPassword = signal("");
  const passwordMode = signal<"signin" | "signup">("signin");
  const action = createAction();
  const methods = signal<SignInMethods | null>(null);
  const callbackError = signal("");
  const selfHostOpen = signal(false);
  const linkText = signal("");
  const linkOpened = signal(false);
  effect(() => {
    if (usesBrowserSession && props.inviteToken) void rememberInvite(props.inviteToken);
  });
  if (usesBrowserSession) void pageQuery().then(query => callbackError.set(query.get("error")?.slice(0, 300) ?? ""));
  effect(() => {
    if (ownFirst() || lastServer === null) return;
    (usesBrowserSession ? fetch("/api/health").then(response => response.json() as Promise<SignInMethods>) : signInMethods(lastServer))
      .then(value => methods.set(value), () => undefined);
  });
  const notice = () => {
    const current = auth();
    return current.status === "signedOut" ? current.notice : undefined;
  };
  const invited = () => usesBrowserSession && props.inviteToken !== undefined;
  const githubUnconfigured = () => methods()?.githubConfigured === false;
  const passwords = () => usesBrowserSession && methods()?.passwordAuth === true;
  const unconfigured = () => githubUnconfigured() && !passwords();
  const local = () => methods()?.localServer;
  const ownServer = () => (selfHosting ? thisServer().running() : undefined);
  const signInToOwnServer = (address: string) => {
    selfHostOpen.set(false);
    void action.run(() => signInToLocalServer(address, thisServer().requireSignInToken(address)));
  };
  const startOwnServer = () => { if (!action.busy()) void action.run(async () => { await signInToThisServer(); }); };
  const signInElsewhere = () => { action.clear(); ownFirst.set(false); };
  if (untracked(ownFirst)) startOwnServer();
  const signInLink = () => parseSignInLink(linkText());
  const linkTarget = () => signInLink()?.origin ?? lastServer;
  const linkHint = () => {
    if (!linkText().trim()) return null;
    const target = linkTarget();
    if (!signInLink()) return { tone: "danger" as const, text: refusedLinkServer(linkText()) ?? "That isn't a sign-in link or code. Copy the whole link Pikibun shows under Sign in an app." };
    return target ? { tone: undefined, text: `Signs in to ${displayOrigin(target)}.` }
      : { tone: "danger" as const, text: "A code alone doesn't say which server it is for. Copy the whole link Pikibun shows under Sign in an app." };
  };
  const closeLink = () => { linkText.set(""); linkOpened.set(false); };

  function submitLink() {
    const link = signInLink();
    const target = linkTarget();
    if (action.busy() || !link || target === null) return;
    linkOpened.set(false);
    void action.run(() => (link.kind === "local" ? signInToLocalServer(target, link.token) : signInWithCode(target, link.code)));
  }
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
    void action.run(async () => {
      if (props.inviteToken !== undefined) {
        const url = await startGitHubInviteSignIn(props.inviteToken);
        if (!authorizeInPage(url)) await openUrl(url);
        return;
      }
      if (!openServerPage("/api/auth/github")) await openUrl(`${origin}/api/auth/github`);
    });
  }

  if (!usesBrowserSession) {
    cleanup(UrlScheme.on("open", ({ url }) => {
      if (isCodeLink(url)) {
        if (!parseSignInCode(url)) {
          void action.run(async () => { throw new Error("That sign-in link isn't complete. Make a new one under Sign in an app, and open it again."); });
          return;
        }
        action.clear();
        ownFirst.set(false);
        linkText.set(url);
        linkOpened.set(true);
      }
    }));
  }

  function submitPassword() {
    if (action.busy() || !username().trim() || !password()) return;
    if (signingUp()) {
      if (password() !== confirmPassword()) { void action.run(async () => { throw new Error("The passwords don't match."); }); return; }
      void action.run(() => signUpWithPassword(username(), password(), props.inviteToken));
      return;
    }
    void action.run(() => signInWithPassword(username(), password()));
  }

  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", gap: 14, padding: 24, width: "100%", maxWidth: 420, alignSelf: "center" }}>
      <View style={{ gap: 10, alignItems: "center", paddingBottom: 8 }}>
        <Logo size={56} />
        <Text style={{ fontSize: 26, fontWeight: "300", color: palette().text, textAlign: "center" }}>{ownFirst() ? "Welcome to Pikibun" : "Sign in to Pikibun"}</Text>
        <Text style={{ fontSize: text.reading, lineHeight: 22, color: palette().muted, textAlign: "center" }}>Run Pi agents on your own machines, and work on them together with your team.</Text>
      </View>
      <If when={invited()}>
        <Banner testID="sign-in-invited" tone="info" title="You're invited to a workspace">Sign in to ask to join it. An owner or admin accepts you before you can see anything in it.</Banner>
      </If>
      <If when={notice()}>{text => <Banner tone="warning">{text()}</Banner>}</If>
      <If when={action.error() || (callbackError() ? `GitHub sign-in did not complete: ${callbackError()}` : "")}>
        {text => <Banner testID="sign-in-problem" tone="danger" title="Sign-in problem">{text()}</Banner>}
      </If>
      <If when={ownFirst()}>
        <View testID="own-first" style={{ gap: 10 }}>
          <Small center>{`Pikibun runs its own server on ${computerName}, for you alone: your sessions and data stay on this computer, and it needs no account.`}</Small>
          <Button testID="own-first-start" variant="primary" large block icon="database" busy={action.busy()} disabled={action.busy()}
            label={action.busy() ? `Starting Pikibun on ${computerName}` : `Start Pikibun on ${computerName}`} onPress={startOwnServer} />
          <If when={!action.busy() && thisServer().problem()}>
            <Button testID="own-first-setup" block variant="outline" icon="download" label={`Set up Pikibun on ${computerName}`} onPress={() => selfHostOpen.set(true)} />
          </If>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: palette().border }} />
            <Small>or</Small>
            <View style={{ flex: 1, height: 1, backgroundColor: palette().border }} />
          </View>
          <Button testID="own-first-other" block variant="outline" icon="server" label="Sign in to another server" disabled={action.busy()} onPress={signInElsewhere} />
        </View>
      </If>
      <If when={!ownFirst()}>
      <If when={usesBrowserSession && unconfigured() && !local()}>
        <Banner tone="warning" title="GitHub sign-in is not configured">The operator needs to configure the GitHub OAuth app, its callback URL and the server's GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and VAULT_KEY settings.</Banner>
      </If>
      <If when={usesBrowserSession && local()}>
        <Banner testID="sign-in-local-link" tone="info" title="This Pikibun runs on its owner's computer">Sign in with the link `pikibun serve` printed when it started, or from the Pikibun app that runs it. No GitHub or other account is needed.</Banner>
      </If>
      <If when={!usesBrowserSession}>
        <View testID="code-form" style={{ gap: 8 }}>
          <If when={linkOpened() ? linkTarget() : null}>
            {target => (
              <Banner testID="code-link-confirm" tone="info" title={`Sign in to ${displayOrigin(target())}?`}
                actions={<Button testID="code-cancel" small variant="ghost" label="Cancel" disabled={action.busy()} onPress={closeLink} />}>
                A sign-in link opened Pikibun. Sign in only if you made it yourself, in Pikibun on the web or in another of your apps.
              </Banner>
            )}
          </If>
          <Small>
            {`Sign in on the web or in another app, open Settings → Profile → Signed-in apps → Sign in an app there, then open its link on this device, scan its QR code with this device's camera, or paste the link here. The link says which server it signs in to.${selfHosting
              ? " A Pikibun started with pikibun serve also takes the sign-in link it printed." : ""}`}
          </Small>
          <Input testID="code-input" value={linkText()} onChange={event => { linkText.set(event.value); linkOpened.set(false); }} autoCapitalize="none" autoCorrect={false}
            masked autoComplete="off" placeholder="Sign-in link" accessibilityLabel="Sign-in link" style={inputStyle()} onSubmit={submitLink} />
          <If when={linkHint()}>{hint => <Small tone={hint().tone} testID="code-hint">{hint().text}</Small>}</If>
          <Button testID="code-sign-in" variant="primary" large block icon="key" label={action.busy() ? "Signing in" : "Sign in"} busy={action.busy() && !developerOpen()}
            disabled={action.busy() || !signInLink() || linkTarget() === null} onPress={submitLink} />
        </View>
        <If when={selfHosting}>
          <View style={{ gap: 8 }}>
            <If when={ownServer()}>
              {running => <Button testID="sign-in-self-host-sign-in" large block icon="database" label={`Sign in to Pikibun on ${computerName}`} disabled={action.busy()}
                onPress={() => signInToOwnServer(running())} />}
            </If>
            <View style={{ flexDirection: "row", justifyContent: "center" }}>
              <Button testID="sign-in-self-host" small variant="ghost" icon="database" label={ownServer() ? `Pikibun on ${computerName}` : `Run Pikibun on ${computerName}`}
                onPress={() => selfHostOpen.set(true)} />
            </View>
          </View>
        </If>
      </If>
      <SignedInServers busy={action.busy()} onSwitch={target => void action.run(() => switchServer(target))} />
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
            disabled={action.busy() || !username().trim() || !password() || (signingUp() && (password().length < 12 || !confirmPassword()))}
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
      <If when={usesBrowserSession && !local() && !githubUnconfigured()}>
        <Button testID="github-sign-in" variant="primary" large block icon="github" label="Continue with GitHub" busy={action.busy()}
          disabled={action.busy()} onPress={continueWithGitHub} />
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
      <If when={!usesBrowserSession && lastServer !== null && methods()?.testMode}>
        <View style={{ gap: 8, borderTopWidth: 1, paddingTop: 12, borderColor: palette().border }}>
          <View style={{ flexDirection: "row" }}>
            <Button testID="developer-toggle" small variant="ghost" icon={developerOpen() ? "chevron-down" : "chevron-right"} label="Developer sign-in" onPress={() => developerOpen.update(value => !value)} />
          </View>
          <If when={developerOpen()}>
            <Small>{`${displayOrigin(origin)} runs in test mode. Sign in with a token from its POST /api/auth/test.`}</Small>
            <Input testID="developer-token" value={token()} onChange={event => token.set(event.value)} autoCapitalize="none" autoCorrect={false} masked autoComplete="off"
              placeholder="Test-mode token" accessibilityLabel="Test-mode token" style={inputStyle()} />
            <Button testID="developer-sign-in" label="Sign in with token" icon="lock" busy={action.busy() && developerOpen()} disabled={!token().trim() || action.busy()}
              onPress={() => void action.run(async () => {
                try {
                  await signInWithToken(origin, token());
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
          : "Your sign-in is kept in this app's storage on this device, not yet in the Keychain or Keystore."}
      </Small>
      </If>
      <SelfHostSheet open={selfHostOpen()} onClose={() => selfHostOpen.set(false)} onUse={signInToOwnServer} />
    </Scroll>
  );
}
