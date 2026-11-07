# Pikibun's client

Pikibun's one client, written once in TSX on [Native Shell](https://nsh.dev) (NSH, pinned in `scripts/nsh.mjs`): the
web app the server serves, and the iOS, Android, macOS, Windows and Linux apps. It replaced the React web app, the
Expo app and the Electron app, and uses `@pikibun/client` and `packages/shared` as they are.

What NSH can't do yet isn't in the client: push notifications (longbridge/nsh#1058), Keychain and Keystore storage
(longbridge/nsh#1061), a system sign-in session and deep links (longbridge/nsh#1065), picking files other than photos
(longbridge/nsh#162), and running the `pikibun` connector from the app (run `pikibun connect`, or `pikibun serve` for
yourself, instead).

## Run it

From the repository (the scripts fetch the pinned NSH CLI once into `.cache/nsh`; `NSH_BIN` names another):

```sh
pnpm build                    # the web app into dist/web, which the server serves at /
pnpm dev                      # the app in a window of this desktop, with hot reload
pnpm nsh run --target ios     # or android, web, macos, windows, linux: any `nsh` command, run in apps/nsh
pnpm dev:native               # a test-mode server with a host and a session to point the app at
```

On the web the client is served by the Pikibun server and signs in with its browser session (cookies and CSRF tokens):
GitHub through the server's own sign-in page, or a username and password where the server allows them. The page's
host (`web/host.js`, NSH's `web.host`) gives it the page's address, so the web app's links keep working: `#/s/<id>`,
`#/w/<id>/new`, `#/settings/<section>/<id>`, `#/shared/<token>` (no sign-in) and `#/join/<token>`.

Native builds sign in to a server you enter: GitHub in the app's own web view, or a test-mode server's token.

## Test it

```sh
pnpm typecheck                # the repository's types, then `nsh check`
pnpm test:client              # the headless tests: NSH's own engine against a stubbed server
pnpm test:client-live         # against a real test-mode server: serving, sign-in, the session list, sign-out
pnpm test:client-web          # the web build in headless Chrome (CHROME_BIN, or the first on PATH) against one
pnpm test:client-macos        # on macOS: the app tests and screenshots in real AppKit windows (apps/nsh/.nsh/screenshots)
pnpm test:client-macos --github --display 1  # also a live GitHub sign-in, which you complete yourself
```

`pnpm test:client-macos` runs the stubbed app and screenshot tests in native macOS windows. `--github` adds an opt-in,
interactive OAuth smoke test against `https://pikibun.com` (or `--server https://your-server.example`): it takes no
live screenshots, redacts URL queries from runtime output, and passes only when sign-in returns to the session list.
Its storage is isolated and discarded when it ends. `--timeout-ms 600000` sets the interactive wait. See
[Mac test results](MACOS-TESTING.md) for what was observed on a Mac.

`pnpm test:client-web` is the web's own: signed out, signed in with the browser's cookie, a settings address, signing
out, and no page errors, Content-Security-Policy violations or console errors on the way. NSH's headless engine isn't a
browser and has APIs its web runtime lacks, so only this catches the web's own failures.

## Release it

Pushing an `app-v1.2.3` tag on `main` packages the app for every platform (`.github/workflows/release-app.yml`): a
Windows installer ([`windows/installer.iss`](windows/installer.iss), Inno Setup, per user) and portable zip, the macOS
app, Linux and Android on the tag's GitHub release, and iOS to TestFlight. Its identity is `nsh.json`'s: the id
`com.pikibun.app` (the iPhone and Android app's before it, so they update in place) and the icon `icon.png`. Signing
and the secrets it needs are in [docs/development.md](../../docs/development.md). To package one by hand, for this
machine's platforms: `pnpm nsh package App.tsx --target macos` (or `windows`, `linux`, `android`, `ios`).

## Known gaps, from NSH itself

- **App Store builds**: NSH 0.4's prebuilt iPhone runner was linked with the iOS 18.5 SDK, which App Store Connect no
  longer takes, and `nsh package` writes none of the build keys it requires in Info.plist (`DT*`, `arm64` in
  `UIRequiredDeviceCapabilities`). `release-app.yml` builds the runner from NSH's source with its own Xcode
  (`NSH_RUNTIME`), adds the keys and signs the app again; drop both once an NSH release does them.
- **The web runtime**: NSH 0.4's has no `lifecycle` (its import is undefined there), so `src/lib/lifecycle.ts` stands in
  for it and counts a page as always active. Its loader inserts an import map and `blob:` modules no hash can allow, so
  the page's policy allows inline scripts (`apps/server/src/static.ts`).
- **Secure storage**: native sign-ins are kept in NSH's `Storage`, a plain file in the app's data, not the Keychain or
  Keystore ([nsh#1061](https://github.com/longbridge/nsh/issues/1061)).
- **GitHub sign-in**: NSH has neither a system authentication session nor deep links
  ([nsh#1065](https://github.com/longbridge/nsh/issues/1065)), so native sign-in runs GitHub's page in the app's own web
  view, which can see what is typed into it. That web view navigates only to http and https, so the server hands the
  sign-in back on a page of its own (`/api/auth/native/done`, asked for with `callback=page`) rather than
  `pikibun://auth`; the code there is worth nothing without the PKCE verifier, which never leaves the app.
- **Types**: NSH 0.4 declares `CryptoKey` only as a value; `src/globals.d.ts` declares the type the shared code names.
- **Tests**: headless `texts()` lists a scroll view's content in view-tree order, not screen order (fixed upstream in
  [nsh#1105](https://github.com/longbridge/nsh/pull/1105)), and screenshots need `--target`. After `setColorScheme`,
  the headless engine reports the window as 0×0, so the layout ignores zero sizes (`src/Root.tsx`).

## Layout

- `App.tsx`: the entry. `src/Root.tsx`: the sign-in gate, the navigation stack, the wide layout and the page's routes.
- `src/lib`: sign-in (`auth.ts`), the page's address (`page.ts`), polled resources and actions, the live session,
  drafts, people and the app-wide lists.
- `src/screens`: sign-in, the session list, a session, new session, open by ID, a shared session, joining a workspace.
- `src/settings`: one file per section (`index.tsx` lists them); `src/session-panel`: one file per tab of a session's
  panel (`index.tsx` lists them).
- `src/components`, `src/ui.tsx`, `src/theme.ts`: the transcript, approval cards, the chat box and the UI kit.
- `web/host.js`: the page's host on the web.
