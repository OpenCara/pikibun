# Pikibun on Native Shell (prototype)

A Pikibun client written once in TSX on [Native Shell](https://nsh.dev) (NSH 0.4), to try one UI across iOS, Android,
macOS, Windows, Linux and the web. It ports the iPhone app's features (`apps/mobile`) and reuses `@pikibun/client` and
`packages/shared` unchanged. It sits beside the React web app, the Expo app and the Electron app, which stay what users
get; nothing else depends on it.

## What it does

| Area | In the NSH client |
|---|---|
| Sign-in | A test-mode server's token (any platform); on the web, the server's own browser session (GitHub in a new tab, or a username and password); natively, GitHub in an in-app web view that catches the `pikibun://auth` redirect (untested on devices, see below) |
| Sessions | Grouped by workspace, search, archived on request, live status and pull request state, pull to refresh; on wide windows the open session beside the list |
| A session | Live transcript over `/events` (Markdown in NSH's native `TextView`, tool calls and results collapsed), pending approvals with every decision the iPhone app offers, the approvals sheet, shared messages and side asks, model, reasoning and access pickers with the Auto-approve confirmation, stop, the queue, copy, go back and fork from a message, earlier messages, repository preparation, restarting a session that didn't start |
| New session | Workspace, host, model, visibility, trust in another member's host, a first message |
| Also | Open a session by ID, settings (account, server, sign-out), light and dark appearance |

Not here: push notifications, attachments, and everything the web app has beyond the iPhone app (workspace, host,
repository and extension settings, administration, backups, schedules, the session panel, sharing and invites), nor the
desktop app's running of the `pikibun` connector.

## Run it

Install the `nsh` CLI ([nsh.dev/docs/installation](https://nsh.dev/docs/installation)), then from this directory:

```sh
nsh run --target ios        # iOS simulator (Xcode)
nsh run --target android    # emulator or device (Android SDK)
nsh run                     # this desktop: AppKit, Win32 or GTK
nsh run --target web        # a browser; see below for a server
```

Native builds sign in to a server you enter. For development, run the server in test mode (docs/development.md) on
`http://127.0.0.1:8787`, enter that address, and use **Developer sign-in** with a token from
`POST /api/auth/test` with `{ "client": "native" }`.

The web build is meant to be served by the Pikibun server itself, so it shares the web app's sign-in:

```sh
pnpm build:nsh-web          # writes dist/nsh/Pikibun
pnpm start                  # then open <APP_ORIGIN>/nsh/
```

The server serves `dist/nsh/Pikibun` (or `NSH_STATIC_DIR`) under `/nsh/` when it exists, with a Content-Security-Policy
that allows the page's inline loader by hash and WebAssembly (`apps/server/src/nsh-web.ts`).

## Test it

```sh
nsh check && nsh test       # type check, then the headless tests (pnpm test:nsh from the repository)
pnpm test:nsh-live          # against a real server: starts one in test mode, checks /nsh/, signs in, signs out
# From the repository root:
pnpm test:nsh-macos         # real AppKit tests and screenshots, in apps/nsh/.nsh/screenshots
pnpm test:nsh-macos --github --display 1  # additionally complete GitHub sign-in yourself
```

`tests/app.test.tsx` runs the app on NSH's headless engine against a stubbed server: signing in and out, the session
list, opening a session, approving, sending, starting a session, and the side-by-side layout of a desktop as the window
changes. `pnpm test:nsh-live` checks the native sign-in against a real server and that the server serves the web
build. The web build's own sign-in (relative URLs and the browser's cookie) needs a browser to test: the headless engine
has no page to resolve relative URLs against (`nsh test --target web` runs in one).

`pnpm test:nsh-macos` creates the screenshot directory and runs the stubbed app and screenshot tests in native
macOS windows. Add `--github` for an opt-in, interactive OAuth smoke test against `https://pikibun.com`, or pass
`--server https://your-server.example`. It takes no live screenshots, redacts URL queries from runtime output, and
passes only when sign-in returns to the authenticated session list. Complete any credentials, MFA and authorization
yourself. The test uses isolated storage that is discarded when it ends; it does not sign in the installed app.
`--timeout-ms 600000` sets the interactive wait, and `NSH_BIN` selects a locally installed CLI.

See [Mac test results](MACOS-TESTING.md) for the observed browser failures and the blocked native OAuth callback.

## Known gaps, from NSH itself

- **Push notifications**: NSH has local notifications only, no APNs or FCM registration ([nsh#1058](https://github.com/longbridge/nsh/issues/1058)).
- **Secure storage**: the sign-in token is kept in NSH's `Storage`, a plain file in the app's data, not the Keychain or
  Keystore ([nsh#1061](https://github.com/longbridge/nsh/issues/1061)). Don't ship this to users as it is.
- **GitHub sign-in**: NSH has neither a system authentication session nor deep links ([nsh#1065](https://github.com/longbridge/nsh/issues/1065)),
  so native sign-in runs GitHub's page in the app's own web view, which can see what is typed into it. Whether each
  platform's web view reports the `pikibun://auth` redirect before failing to load it is untested.
- **Types**: NSH 0.4 declares `CryptoKey` only as a value; `src/globals.d.ts` declares the type the shared code names.
- **Tests**: headless `texts()` lists a scroll view's content in view-tree order, not screen order (fixed upstream in
  [nsh#1105](https://github.com/longbridge/nsh/pull/1105)), and screenshots need `--target`. After `setColorScheme`,
  the headless engine reports the window as 0×0, so the layout ignores zero sizes (`src/Root.tsx`).

## Layout

- `App.tsx`: the entry. `src/Root.tsx`: sign-in gate, navigation stack, the wide layout.
- `src/lib`: sign-in (`auth.ts`), polled resources and actions, the live session, drafts, people, app-wide lists.
- `src/screens`, `src/components`: the iPhone app's screens and components, one for one.
- `src/ui.tsx`, `src/theme.ts`: the iPhone app's UI kit and palette on NSH's primitives.
