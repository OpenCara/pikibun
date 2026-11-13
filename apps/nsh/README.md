# Pikibun's Native Shell Preview

An experimental client written in TSX on [Native Shell](https://nsh.dev) (NSH, pinned in `scripts/nsh.mjs`) for the
web, iOS, Android, macOS, Windows and Linux. Its web build is every server's client: the one pikibun.com serves and the
only one the Docker image and `pikibun serve` ship. It replaced the React web client and the Electron desktop app, which
are removed, on the same backend, `@pikibun/client` and `packages/shared`. See [the web client](../../docs/self-hosting.md#the-web-client).

What NSH can't do yet isn't in the client: push notifications (longbridge/nsh#1058), Keychain and Keystore storage
(longbridge/nsh#1061), a system sign-in session (longbridge/nsh#1065, not planned: native sign-in goes through the
system browser and comes back as a `pikibun://` link instead), and bundling the `pikibun` connector inside the app (the
desktop builds run the installed command instead: see [This Computer](#this-computer)).

## Run it

From the repository (the scripts fetch the pinned NSH CLI once into `.cache/nsh`; `NSH_BIN` names another):

```sh
pnpm build:client            # the NSH web preview into dist/client
pnpm dev:client              # the app in a window of this desktop, with hot reload
pnpm nsh run --target ios     # or android, web, macos, windows, linux: any `nsh` command, run in apps/nsh
pnpm dev:native               # a test-mode server with a host and a session to point the app at
```

On the web the client is served by the Pikibun server and signs in with its browser session (cookies and CSRF tokens):
GitHub through the server's own sign-in page, or a username and password where the server allows them, with a new
account made there as its SIGNUP allows. An invite link opened signed out says so, signs in with GitHub for that
workspace and is remembered across GitHub's redirect, as the web app does. The page's host (`web/host.js`, NSH's
`web.host`) gives it the page's address, so the web app's links keep working: `#/s/<id>`, `#/w/<id>/new`,
`#/settings/<section>/<id>`, `#/shared/<token>` (no sign-in) and `#/join/<token>`; it also does what NSH's web runtime
can't: the browser's own file chooser for any file, an image too large for a message drawn again smaller, the query
GitHub's sign-in comes back with, and GitHub's authorization page for an invite's sign-in.

Native builds sign in to a server you enter: GitHub in the system browser, handed back as a `pikibun://auth` link
([GitHub sign-in](#known-gaps-from-nsh-itself)), a username and password where the
server allows them (`POST /api/auth/native/password`, for a bearer token listed under Signed-in apps, as GitHub's), a
code made in a browser or app already signed in (`POST /api/auth/native/code`; **Settings → Profile → Signed-in apps →
Sign in an app** shows its `pikibun://auth/code` link as a QR code, drawn by the app's own encoder, `src/lib/qr.ts`,
as NSH has none; the sign-in screen takes the link pasted or opened, and asks before it signs in), or a test-mode
server's token. New password accounts are made on the web, whose sign-up starts a browser session.

## Design

Quiet chrome in the manner of today's coding-agent apps (Codex, Claude Code, Lody, Paseo), so the conversation and what
needs a decision stand out:

- **Layout**: wider windows have a sidebar (a new session, every session by workspace, the signed-in person and
  settings) beside the open session; with none open, the home asks "What should we work on?" with the chat box that
  starts one: in the box what the first message runs with (model, reasoning, access), under it one quiet row of where
  the session lives (workspace, host, sandbox, visibility), and alerts only when something needs a decision. Phones
  stack the session list, then the session.
- **Session**: a header with where the session lives and runs and its connection; the transcript in one readable column,
  user messages as bubbles, the agent's replies as Markdown, each tool call one quiet line that opens to its exact text;
  the chat box's pickers (shared or side ask, model, reasoning, access)
  along its bottom edge: on a phone one line of them, tighter, that scrolls sideways where it doesn't fit, and any hint
  but "Runs as … (you)" on a line under it. Details (owner, host, visibility, ID) are in the session's panel.
- **Kit**: first drawn as the React web client's. `src/tokens.ts` has its three themes (light, dark and Pikibun's night
  theme) under its CSS variables' names; `src/theme.ts` builds the palettes from
  them, with the type sizes, weights, radii and control heights. `src/ui.tsx` names the web class each widget was drawn from
  (buttons, badges, alerts, sections of rows, nav items, chips, pickers on `Menu`: a popup on the desktops and the web,
  a sheet on phones; right-click menus on `ContextMenu` (`RowMenu`), which a finger held on the row opens as a sheet on
  touch screens, its rows taking presses through `rowPress` so that finger's lift doesn't open the row: see
  [upstream workarounds](../../docs/design/upstream-workarounds.md); and on touch screens a session's row in the list
  slides sideways under a finger, as mail and chat apps' rows do, to show its main actions (`SwipeRow`): right, Copy link
  and Rename; left, More (its whole menu) and Archive or Unarchive); `src/icons.tsx` has the same Lucide outlines, drawn
  with `Canvas` as NSH has no icon font. Where
  it differs from the React client on purpose: the sidebar keeps a search box, tool rows
  name what they work on, and message actions open a sheet rather than
  appear on hover.

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
out, a new account made with a password, its first workspace, a file and an image picked in the browser's own chooser,
and no page errors, Content-Security-Policy violations or console errors on the way. Where the temporary directory's
path is long, Chrome's sockets don't fit: run it with a short relative `TMPDIR`. NSH's headless engine isn't a
browser and has APIs its web runtime lacks, so only this catches the web's own failures.

## Release it

Pushing an `app-v1.2.3` tag on `main` packages the app for every platform (`.github/workflows/release-app.yml`): the
Windows installer ([`windows/installer.iss`](windows/installer.iss), Inno Setup, per user, signed through SignPath), the signed and
notarized macOS `.dmg`, Linux and the signed Android `.apk` on the tag's GitHub release, "Pikibun 1.2.3", which becomes
the latest (`app-v1.2.3-beta.1` makes a prerelease), and iOS to TestFlight. Its identity is `nsh.json`'s: the id
`com.pikibun.app` (the iPhone and Android app's before it, so they update in place) and the icon `icon.png`. Signing
and the secrets it needs are in [docs/development.md](../../docs/development.md). To package one by hand, for this
machine's platforms: `pnpm nsh package App.tsx --target macos` (or `windows`, `linux`, `android`, `ios`).

## Updates

The macOS, Windows and Linux builds offer a newer release themselves (`src/lib/app-update.ts`, `src/components/AppUpdate.tsx`).
NSH can't read the version a package was built with, so each release stamps it into `src/app-version.ts`
(`node scripts/app-version.mjs <version>`, run by `release-app.yml` before `nsh package`); a build from the repository
is a development build, which offers none. The app asks GitHub for the repository's releases at launch and every six
hours, takes the newest published `app-v` one (a prerelease only while it runs one), and shows it on the main page (the home
beside the sidebar, above the chat box; above the session list in a narrow window; **Later** puts it off until the next
launch) and under **Settings → Profile → This app**. **Update** downloads the release's package for
this computer into the app's data folder (`updates/`, `capabilities.fs.write`) with a progress bar, in parts of at most
4 MiB that the platform's own `copy /b` or `cat` joins (NSH writes at most 8 MiB at once), checks it against the SHA-256
GitHub publishes for the asset, installs it and quits; the new version starts once the old one has gone.

The download goes through the proxy the computer's own tools use (`src/lib/update-proxy.ts`). NSH's `fetch` is
`NSURLSession` on macOS, which follows the system's proxy settings but not a shell's variables, and ureq on Windows and
Linux, which follows the app process's own `HTTPS_PROXY`, `ALL_PROXY` and `HTTP_PROXY` but not the system's settings; an
app opened from the Dock, the Start menu or a launcher has no shell variables. So before it downloads, the app looks for
the proxy `fetch` would miss: on Windows, Internet Settings' `ProxyEnable` and `ProxyServer` (`reg query`, what
Settings → Proxy and local proxies such as Clash set), unless the app has its own proxy variables; on macOS, the
`https_proxy`, `all_proxy` or `http_proxy` the login shell exports (`$SHELL -ilc`, as This Computer starts `pikibun`);
on Linux, the same, then GNOME's manual proxy (`gsettings`). Where it finds one, curl (`curl.exe` on Windows 10 and
later, through `cmd`, or through `sh`) downloads the package through it, the app reading the file's size for the
progress bar and its bytes for the checksum. Without curl, or where the proxy doesn't carry it (one a proxy app left
set when it quit), `fetch` downloads it directly, as before; a failure says both why, without the proxy's password. `nsh.json` grants the proxy variables
(`capabilities.process.env`), so the app sees its own and its commands get them. A proxy auto-config (PAC) script
isn't read.

Installing it:

- **Windows**: every program the app starts runs in a job that ends with the app, so the app has Task Scheduler run the
  installer instead (`schtasks`, a hidden one-off task that runs on battery too), silently, with `/RELAUNCH`, which
  [`windows/installer.iss`](windows/installer.iss) answers by starting Pikibun once it is installed. The next launch
  deletes the task.
- **macOS**: the app finds its bundle from its own process, copies `Pikibun.app` from the disk image next to it, swaps the
  two, and leaves a relauncher in a session of its own (NSH ends a child's whole process group) that `open`s the new one
  once the app has quit. An app run from its disk image or its download (App Translocation) is asked to move to
  Applications first.
- **Linux**: the same with the app's folder, unpacked from the `.tar.gz` next to it; the relauncher starts it with the
  display's environment (`DISPLAY`, `WAYLAND_DISPLAY` and the like, granted in `nsh.json`).

The scripts are in `src/lib/update-scripts.ts`; `tests/app-update-scripts.test.ts`, at the repository's root, runs the
Linux one against a stand-in app and checks both parse. A failed update says why and offers the release page; one that
didn't finish by the next launch says so then.

The `pikibun` command isn't in the package, so an update of the app doesn't carry it: the new version's first start
updates the app's own copy from npm ([below](#this-computer)).

## What the React client had that this client doesn't

Every page of the React client is here: sign-in, the sidebar and Sessions, a new session, a
session with its header menu and its panel (Details, Files, Browser, Schedules, Activity), a share link, an
invite link, and every settings section (Profile, Notifications, Hosts, Workspaces, Appearance with the Pikibun theme,
Administration). What is left out, and why:

- **This Computer**: the desktop builds have it ([below](#this-computer)) for this computer as a host of the server
  signed in to, and **Self host** ([below](#self-host)) runs Pikibun itself here. What the Electron app's had is left
  out: hosts for several servers at once, WSL2 on Windows, sharing the Pikibun it runs with others (`pikibun serve
  --share`, in a terminal), installing prerequisites itself, and hosting while the app is closed (its tray). In a
  browser there are no such sections.
- **Notifications while the app is closed**: the native apps show the account's notifications with NSH's
  `Notifications` only while they run (`src/lib/notifications.ts` asks the server's feed every 20 seconds, as a browser
  tab without Web Push does; pressing one opens its session, and one about the session in front isn't shown). Pushed
  ones wait for NSH's push notifications (longbridge/nsh#1058). The web build turns them on in the browser as the web
  app does (Web Push through the `sw.js` the build ships, or while a tab is open), and every build manages the
  account's preferences and devices.
- **Up** in an empty chat box takes back a queued message on the desktops and in desktop browsers; on phones the
  queue's Edit does.
- **Downloads** (backups, exports) and **OAuth sign-ins** to document providers need the browser's own sign-in, so
  they are offered on the web build only; native builds point to Pikibun on the web.

## This Computer

In the macOS, Windows and Linux builds, **Settings → This Mac** (This Computer elsewhere; `#/settings/desktop`, as the
React web client's address for it) makes this computer one of your hosts:

- **Pair in one step** with the server signed in to: the app creates a pairing for you and hands its code straight to
  the host, once everything else is settled (prerequisites, the unsandboxed consent), so a refusal leaves no unused code.
  A computer paired with another server is paired again only by replacing that pairing, after saying so.
- **Start and stop** the host, with the CLI's own `--unsafe-no-sandbox` warning in a native dialog where there is no
  sandbox; on macOS, choose **None** or **macOS sandbox** (Seatbelt, experimental). Linux uses bubblewrap where it is
  installed; Windows its own sandbox, experimental, or none after consent.
- **Read its sessions from it**: a session the server says runs on this host opens from the host itself, over the same
  channel (`view` and `entries`), and carries on, read-only, while the server can't be reached; the server still checks
  who may read it ([the design](../../docs/design/local-views.md), `src/lib/local-sessions.ts`).
- **Models offered** (Pi's choice, or the ones checked), **Sign Pi in to a provider** (Pi's own `/login`, run on this
  computer: its page opens in the browser, a device code or API key is asked here, and the credential stays in Pi's
  configuration), **Prerequisites** with what to run for each missing one, and the host's recent activity.

The connector isn't in the app: NSH bundles no Node.js. The app runs the `pikibun` command as `pikibun host --stdio`
(`apps/runner/src/host-cli.ts` and `app-host.ts`), and talks to it with JSON lines
on its stdin and stdout (`packages/shared/src/app-host-protocol.ts`), where pairing codes and API keys travel; never its command line.
When the command is missing or too old, the page's **Install pikibun** or **Update pikibun** button runs npm, with the
owner's Node.js, into a `cli` folder of the app's data directory (`npm install --prefix <data dir>/cli pikibun@latest`),
not npm's global folder: nothing needs sudo or a PATH change, and the copy is the app's to update. npm's output goes to
the host's activity, and the command to run in a terminal (`npm install -g pikibun@latest`) shows only when that fails.
The app updates that copy with the app: it keeps the app version that last installed or updated it
(`pikibun.commandUpdatedFor` in its storage), and a release build that starts as another version, with a copy in its
`cli` folder (`node_modules/pikibun/package.json` there, `capabilities.fs.read`), runs the same npm command before
either command starts, at launch (`commandUpdated` in `src/lib/this-computer.ts`, which `CommandChannel` waits for).
The host and Self host wait for it, the two pages say so, and a failure is a warning in the host's activity: the
command at hand runs, and the next launch tries again. A `pikibun` installed from a terminal is never touched.
NSH starts a command without a shell and with the app's own PATH, which on a Mac opened from Finder lacks Homebrew's,
nvm's and npm's directories, so the owner's login shell starts it (`$SHELL -ilc 'PATH=<data dir>/cli/node_modules/.bin:"$PATH"; export PATH; exec pikibun host --stdio'`,
as Terminal would; zsh, bash or sh, else the platform's), and on Windows cmd (`cmd /d /c if exist
cli\node_modules\.bin\pikibun.cmd (…) else pikibun host --stdio`, named from the data directory, its working
directory). Either way the app's own copy wins, and a `pikibun` installed from a terminal runs where it has none. `nsh.json` grants exactly those programs (`capabilities.process`), by name, since it is every
target's and an absolute path of one platform isn't one on another (NSH refuses to build or start with one), and the
environment the connector needs. The host uses `pikibun connect`'s state directory, so a computer paired from a terminal carries over, and only
one of them runs at a time. Hosting lasts while the app is open, and starts again at the next launch if it was running
when the app quit, with the consent given then (`src/lib/this-computer.ts`).

`tests/this-computer.test.tsx` runs the page against a stand-in for the command that speaks its protocol
(`tests/harness/this-computer.tsx`); `tests/host-cli.test.ts`, at the repository's root, runs the command itself.

## Self host

In the macOS, Windows and Linux builds, **Settings → Self host** (`#/settings/self-host`), and **Run Pikibun on this
Mac** on the sign-in screen while signed out, run Pikibun itself on this computer, as `pikibun serve` does in a
terminal: the server and its web app on `http://127.0.0.1:7878`, for its owner alone, with this computer as the host
that runs their sessions.

- **Start and stop** it, with nothing to set up: there is no GitHub sign-in. Where this computer has no sandbox, it
  asks the same consent as This Mac before this computer runs sessions.
- **Sign in to it**: the app switches its server to the running Pikibun (from Settings, after signing out of the one it
  is signed in to) and signs in as its owner with the server's sign-in token, which the command's status carries
  while it runs (`POST /api/auth/native/local`). The first sign-in makes the owner's account. Signed out of it, the
  sign-in screen's **Sign in to Pikibun on this Mac** does the same; for a local Pikibun the app doesn't run, it takes
  the link `pikibun serve` printed (`/api/auth/local?token=…`) pasted instead.
- It runs while the app is open, and starts again at the next launch if it was running when the app quit, after which
  the app tries its sign-in again.

The app runs `pikibun serve --stdio` (`apps/server/src/local/app-server.ts`, protocol in `packages/shared/src/app-server-protocol.ts`)
through the same login shell or `cmd` as `pikibun host --stdio` (`src/lib/pikibun-command.ts`), with JSON lines on
its stdin and stdout, where the sign-in token travels. When the command is missing or too old for `--stdio` (or so old
that it still asks for a GitHub OAuth app), the page offers This Mac's **Install pikibun** or **Update pikibun**. It uses `pikibun serve`'s state directory, so a
Pikibun set up in a terminal carries over, and only one of them runs at a time. Its host is the server's own (paired
with the server's state, as `pikibun serve` pairs it), not This Mac's: This Mac stays a host of whichever server it is
paired with.

`tests/self-host.test.tsx` runs the page, the sign-in screen and Settings against a stand-in for the command
(`tests/harness/self-host.tsx`); `tests/serve-stdio.test.ts`, at the repository's root, runs the command itself.

## Known gaps, from NSH itself

Each workaround below is on the [list of upstream workarounds](../../docs/design/upstream-workarounds.md), with what tracks it upstream and when to remove it.

- **App Store builds**: NSH's prebuilt iPhone runner (0.4's, and 0.5's `ios` component) was linked with the iOS 18.5
  SDK, which App Store Connect no longer takes, and `nsh package` writes none of the build keys it requires in Info.plist (`DT*`, `arm64` in
  `UIRequiredDeviceCapabilities`). `release-app.yml` builds the runner from NSH's source with its own Xcode
  (`NSH_RUNTIME`), adds the keys and signs the app again; drop both once an NSH release does them.
- **The web runtime**: its loader inserts an import map and `blob:` modules no hash can allow, so the page's policy
  allows inline scripts (`apps/server/src/static.ts`).
- **Text widths on the web**: NSH (0.4 and 0.5) lays text out with widths the browser's canvas measures and draws it as page
  text, so where a browser's canvas measures a font otherwise (another face for the system font, a minimum font size,
  text-only zoom) each run overlaps the next: inline code over the words before it. `scripts/nsh-web-fixes.mjs` patches
  the built runtime to measure such a font as the page draws it; drop the patch once NSH measures so itself.
- **Secure storage**: native sign-ins are kept in NSH's `Storage`, a plain file in the app's data, not the Keychain or
  Keystore ([nsh#1061](https://github.com/longbridge/nsh/issues/1061)).
- **GitHub sign-in**: NSH has no system authentication session
  ([nsh#1065](https://github.com/longbridge/nsh/issues/1065), closed as not planned). The app claims `pikibun://`
  (`nsh.json` `schemes`), so it opens GitHub's page in the system browser, where the app sees nothing typed, and the
  server hands the sign-in back as `pikibun://auth?code=…&state=…` (`src/screens/SignIn.tsx`). Anyone can open such a
  link: the app takes only one whose state is the attempt's, and its code is worth nothing without the PKCE verifier,
  which never leaves the app. **Sign in here instead** runs the page in the app's own web view, handed back on a page of
  the server's (`/api/auth/native/done`, asked for with `callback=page`), where the browser can't open the app.
- **Types**: NSH (0.4 and 0.5) declares `CryptoKey` only as a value; `src/globals.d.ts` declares the type the shared
  code names.
- **Tests**: screenshots need `--target`. Since NSH 0.5 an app imports only files inside its directory, the nearest one
  up with an `nsh.json`: the harnesses in `tests/harness` build with the app's, but the attach test's, which writes
  files to the home folder, has its own in `tests/harness/home`, so `Logo`, the app's only imported file, is in
  `src/logo.tsx`, apart from the kit it imports.

## Layout

- `App.tsx`: the entry. `src/Root.tsx`: the sign-in gate, the navigation stack, the wide layout and the page's routes.
- `src/lib`: sign-in (`auth.ts`), the page's address (`page.ts`), polled resources and actions, the live session,
  drafts, people and the app-wide lists.
- `src/screens`: sign-in, the session list, a session, new session, open by ID, a shared session, joining a workspace.
- `src/settings`: one file per section (`index.tsx` lists them); `src/session-panel`: one file per tab of a session's
  panel (`index.tsx` lists them).
- `src/components`, `src/ui.tsx`, `src/theme.ts`: the transcript, the chat box and the UI kit.
- `web/host.js`: the page's host on the web.
