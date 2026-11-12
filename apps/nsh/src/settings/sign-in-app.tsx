import { Clipboard, effect, openUrl, signal, untracked, View } from "nsh";
import type { AppSignInCode, AppSignInCodeState } from "../../../../packages/shared/src/types";
import { ApiError, segment } from "../shared";
import { session } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { usesBrowserSession } from "../lib/server";
import { canSignInAgain, needsRecentSignIn, signInWithGitHubAgain } from "../lib/sign-in-again";
import { QrCode } from "../components/QrCode";
import { Field, TextField } from "../form";
import { Banner, Button, CardBody, Feedback, Small } from "../ui";

const POLL_MS = 2000;

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds} s`;
}

/**
 * Signs the Pikibun app in on another device: makes a one-use code (`POST /api/me/app-codes`) and shows its
 * pikibun://auth/code link as a QR code to scan, a link to open here and a link to copy, until an app uses it, it
 * expires or it is cancelled. Making one needs the password, or a GitHub sign-in from the last 15 minutes.
 */
export function SignInApp(props: { onClose: () => void; onSignedIn: (deviceName: string | null) => void }) {
  const user = () => session().user;
  const code = signal<AppSignInCode | null>(null);
  const password = signal("");
  const needsPassword = signal(Boolean(untracked(session).user.passwordSignIn));
  const signInAgain = signal(false);
  const ended = signal("");
  const copied = signal(false);
  const now = signal(Date.now());
  const action = createAction();
  const state = createResource<AppSignInCodeState>(() => (code() ? `/api/me/app-codes/${segment(code()!.id)}` : null), POLL_MS);

  function make() {
    signInAgain.set(false);
    ended.set("");
    void action.run(async () => {
      try {
        const body = password() ? { currentPassword: password() } : {};
        code.set(await session().api<AppSignInCode>("/api/me/app-codes", { method: "POST", body }));
        password.set("");
        now.set(Date.now());
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === "current_password_required") needsPassword.set(true);
        if (needsRecentSignIn(reason)) {
          signInAgain.set(true);
          if (untracked(user).hasPassword) needsPassword.set(true);
        }
        throw reason;
      }
    });
  }

  function copy(link: string) {
    void Clipboard.writeText(link).then(() => {
      copied.set(true);
      setTimeout(() => copied.set(false), 1500);
    }, () => undefined);
  }

  function cancel() {
    const current = untracked(code);
    code.set(null);
    if (current) void session().api(`/api/me/app-codes/${segment(current.id)}`, { method: "DELETE" }).catch(() => undefined);
    props.onClose();
  }

  effect(() => {
    if (!code()) return;
    const timer = setInterval(() => now.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });

  effect(() => {
    const current = code();
    if (!current) return;
    const answer = state.data();
    if (answer?.id === current.id && answer.status === "used") {
      code.set(null);
      props.onSignedIn(answer.deviceName);
      return;
    }
    if (now() >= Date.parse(current.expiresAt)) {
      code.set(null);
      ended.set("The code expired before an app used it. Make a new one.");
    }
  });

  if (!untracked(needsPassword)) make();

  return (
    <CardBody testID="sign-in-app">
      <If when={code()}
        else={
          <View style={{ gap: 12 }}>
            <Small>Make a code that signs in the Pikibun app on your phone, tablet or computer as you, without GitHub or your password there.</Small>
            <If when={ended()}>{text => <Banner tone="warning">{text()}</Banner>}</If>
            <If when={needsPassword()}>
              <Field label="Your password" hint={user().passwordSignIn ? "A code signs an app in as you, so it takes your password." : "Or sign in with GitHub again."}>
                <TextField testID="sign-in-app-password" masked value={password()} onChange={value => password.set(value)} maxLength={256} onSubmit={make} />
              </Field>
            </If>
            <If when={signInAgain()}>
              <Banner tone="info" title="Sign in with GitHub again"
                actions={canSignInAgain ? <Button small variant="outline" label="Sign in with GitHub again" onPress={signInWithGitHubAgain} /> : undefined}>
                {canSignInAgain ? "A code signs an app in as you, so it needs a GitHub sign-in from the last 15 minutes."
                  : "A code signs an app in as you, so it needs a GitHub sign-in from the last 15 minutes: make it in Pikibun on the web instead."}
              </Banner>
            </If>
            <Feedback error={signInAgain() ? undefined : action.error()} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
              <Button testID="sign-in-app-cancel" variant="ghost" label="Cancel" onPress={cancel} />
              <Button testID="sign-in-app-make" variant="primary" icon="key" label={action.busy() ? "Making code…" : "Make code"} busy={action.busy()}
                disabled={action.busy() || (needsPassword() && !password() && !signInAgain())} onPress={make} />
            </View>
          </View>
        }>
        {current => (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
            <QrCode value={current().link} testID="sign-in-app-qr" label="QR code of the sign-in link" />
            <View style={{ flex: 1, minWidth: 220, gap: 10 }}>
              <Small>On a phone or tablet: scan this with its camera, and open the link in Pikibun.</Small>
              <Small>{usesBrowserSession
                ? "On this computer: choose Open in Pikibun. On another: copy the link, then paste it under Sign in with a code on the app's sign-in screen."
                : "On a computer: copy the link, then paste it under Sign in with a code on the app's sign-in screen."}</Small>
              <Small tone="warning" testID="sign-in-app-expiry">{`Works once, for ${remaining(current().expiresAt, now())} more. Anyone who has it can sign in as you until then, so show it to nobody.`}</Small>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <If when={usesBrowserSession}>
                  <Button testID="sign-in-app-open" small variant="primary" icon="external-link" label="Open in Pikibun"
                    onPress={() => void openUrl(current().link).catch(() => undefined)} />
                </If>
                <Button testID="sign-in-app-copy" small variant="outline" icon={copied() ? "check" : "copy"} label={copied() ? "Copied" : "Copy link"}
                  onPress={() => copy(current().link)} />
                <Button testID="sign-in-app-cancel" small variant="ghost" label="Cancel" onPress={cancel} />
              </View>
            </View>
          </View>
        )}
      </If>
    </CardBody>
  );
}
