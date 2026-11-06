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
pnpm nsh test --target macos tests/screenshots.test.tsx   # screenshots of the main screens, in .nsh/screenshots
```

## Layout

- `App.tsx`: the entry. `src/Root.tsx`: the sign-in gate, the navigation stack, the wide layout and the page's routes.
- `src/lib`: sign-in (`auth.ts`), the page's address (`page.ts`), polled resources and actions, the live session,
  drafts, people and the app-wide lists.
- `src/screens`: sign-in, the session list, a session, new session, open by ID, a shared session, joining a workspace.
- `src/settings`: one file per section (`index.tsx` lists them); `src/session-panel`: one file per tab of a session's
  panel (`index.tsx` lists them).
- `src/components`, `src/ui.tsx`, `src/theme.ts`: the transcript, approval cards, the chat box and the UI kit.
- `web/host.js`: the page's host on the web.
