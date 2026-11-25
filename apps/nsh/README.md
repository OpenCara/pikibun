# Pikibun's Native Shell Preview

An experimental client written in TSX on [Native Shell](https://nsh.dev) (NSH, pinned in `scripts/nsh.mjs`) for the
web, iOS, Android, macOS, Windows and Linux. Its web build is every server's client: the one pikibun.com serves and the
only one the Docker image and `pikibun serve` ship. It replaced the React web client and the Electron desktop app, which
are removed, on the same backend, `@pikibun/client` and `packages/shared`. See [the web client](../../docs/self-hosting.md#the-web-client).

What NSH can't do yet isn't in the client: Keychain and Keystore storage
(longbridge/nsh#1061), a system sign-in session (0.6 added `open_auth_session` for Rust apps only, and 0.7 still has none in TSX: native
sign-in goes through the system browser and comes back as a `pikibun://` link instead), and bundling the `pikibun` connector inside the app (the
desktop builds run the installed command instead: see [This Computer](#this-computer)). Push notifications are
NSH's since 0.7 (`nsh-extra`'s `push`, iOS and Android), but not yet the client's: the server sends no APNs or FCM
pushes (see [Notifications while the app is closed](#what-the-react-client-had-that-this-client-doesnt)).

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

Native builds sign in with a code made in a browser or app already signed in, and only so: no
GitHub or password sign-in in the app (`POST /api/auth/native/code`, for a bearer token listed under Signed-in apps;
**Settings → Profile → Signed-in apps → Sign in an app** shows its `pikibun://auth/code` link as a QR code, drawn by
the app's own encoder, `src/lib/qr.ts`, as NSH has none; the sign-in screen takes the link pasted or opened, and asks
before it signs in). The screen asks for no server address: the link names its server (`server=`), and a code pasted
without its link goes to the server the app was last on; an app that was on none yet asks for the whole link. A Pikibun on its owner's computer
(`pikibun serve`) also takes the sign-in link it printed, pasted in the same box, whose address is its server, or the
app's own token for the one it runs; a test-mode server the app was last on takes a developer token. Accounts are made
on the web. The app keeps its sign-in to each server (`pikibun.servers` in its storage, beside the current one's
`pikibun.origin` and `pikibun.token`): **Settings → Profile → Servers** switches between them and adds another, and the
sign-in screen lists them.

## Design

Quiet chrome in the manner of today's coding-agent apps (Codex, Claude Code, Lody, Paseo), so the conversation and what
needs a decision stand out:

- **Layout**: wider windows have a sidebar (a new session, every session by workspace, the signed-in person, the
  server switch and settings) beside the open session; with none open, the home asks "What should we work on?" with the chat box that
  starts one: in the box what the first message runs with (model, reasoning, access), under it one quiet row of where
  the session lives (workspace, host, sandbox, visibility), and alerts only when something needs a decision. Phones
  stack the session list, then the session.
- **Session**: a header with where the session lives and runs and its connection; the transcript in one readable column,
  user messages as bubbles, the agent's replies as Markdown, each tool call one quiet line that opens to its exact text;
  the chat box's pickers (shared or side ask, model, reasoning, access)
  along its bottom edge: on a phone one line of them, tighter, that scrolls sideways where it doesn't fit, and any hint
  but "Runs as … (you)" on a line under it; a `/` typed first lists its
  [slash commands](../../docs/sessions.md#slash-commands) inside the box, above the text. On macOS and Linux, typing
  while the transcript or a button has the keyboard goes into the chat box (NSH's `captureKeys="text"`). Details (owner, host, visibility, ID) are in the session's panel.
- **Commands**: the [command palette](../../docs/sessions.md#command-palette) (Ctrl/⌘ K, Ctrl/⌘ O for Switch session…, a
  button in the session's header) lists every action by name. Screens contribute their commands as data to one
  registry (`src/lib/commands.ts`, `useCommands`) while they are in front, and `src/components/CommandPalette.tsx`
  draws them all: a dialog on wider windows, a sheet on phones, with choices and a line of text asked in the same box.
  The matcher is `packages/client/src/command-palette.ts`; see [the design](../../docs/design/command-palette.md).
- **Review**: the panel's Review tab (`src/session-panel/Review.tsx`) is drawn after JetBrains IDEA's pull request
  window, which the React client had no counterpart of: the title, branches and state, then the changed files in NSH's
  `Tree`, grouped by directory and coloured as IDEA colours file statuses (blue modified, green added, grey deleted,
  teal renamed), and a file's diff in NSH's `DiffView`, from the hunks GitHub gives, in IDEA's diff colours (green for
  added lines, grey for deleted ones) with its toolbar: previous and next change, side-by-side or unified viewer, the
  number of differences, previous and next file. Its **Expand to the full window** widens the panel's sheet to the
  window, the tree beside the diff in a `ResizablePanelGroup`; the tree and the patch it draws from are
  `packages/shared/src/pull-request-review.ts`. The **Changes** tab (`src/session-panel/Changes.tsx`) is the same tree
  and diff over what Git sees in a clone of the session's worktree, as IDEA's Commit and Git windows: the uncommitted
  changes, the branch's commits, and one commit's changes, read from the session's host. Under 700 points of width
  (`compactPanel` in `src/session-panel/parts.tsx`) both tabs are a phone's: a list of 44-point rows by directory for
  the tree, and a one-column diff with its controls in a bar at the bottom. `SwipeBack` there is the swipe that goes
  back on touch platforms (a `pan` on the page, and a strip at a diff's left edge for when its lines scroll sideways),
  and `createPanelBacks` the steps Android's back button and Escape take before the panel closes: each tab adds its
  own, and the panel asks them when its sheet is cancelled.
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

## Files and the clipboard

- **Attaching**: a file dropped on the chat box or pasted from a file manager is read wherever it is: since NSH 0.7
  the person's drop or paste lets the app read that one path, so `nsh.json` grants no read of the home folder (only
  the app's own `updates` and `cli` folders). In a browser NSH reads a dropped file itself and hands over its bytes
  (`onFileDrop`'s `files`, `attachDropped` in `src/lib/attachments.ts`). A pasted file larger than the box takes
  (`pasteMaxSize`, the workspace's file limit or 32 MiB for images) is left unread and only named, with the same notice
  as a picked one. A refusal (`ERR_ACCESS_DENIED`) now comes only from a host that narrows what the app reads.
- **Copying**: `Clipboard.writeText` says since 0.7 what became of the write; `writeClipboard` (`src/lib/clipboard.ts`)
  fails only on `"failed"`, so `"requested"` (iOS, Android, Linux and terminals, which don't say) counts as copied.

## Test it

```sh
pnpm typecheck                # the repository's types, then `nsh check`
pnpm test:client              # the headless tests: NSH's own engine against a stubbed server
pnpm test:client-live         # against a real test-mode server: serving, sign-in, the session list, sign-out
pnpm test:client-web          # the web build in headless Chrome (CHROME_BIN, or the first on PATH) against one
pnpm test:client-tui          # tests/terminal.test.tsx in an in-memory terminal (docs/design/tui.md)
pnpm test:client-macos        # on macOS: the app tests and screenshots in real AppKit windows (apps/nsh/.nsh/screenshots)
pnpm test:client-macos --live --display 1  # also a live sign-in with a code, which you complete yourself
```

`pnpm test:client-macos` runs the stubbed app and screenshot tests in native macOS windows. `--live` adds an opt-in,
interactive sign-in against `https://pikibun.com` (or `--server https://your-server.example`) with a code you make on
the web and paste in the app: it takes no live screenshots, redacts URL queries from runtime output, and passes only
when sign-in reaches the session list.
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
(`node scripts/app-version.mjs <version>`, run by `release-app.yml` before `nsh package`), with the version of the
`pikibun` command it installs into its own folder (`CLI_VERSION`: the latest `cli-v` tag at the release's commit, so its
jobs check out the whole history); a build from the repository is a development build, which offers none, and installs
`pikibun@latest`. The app asks GitHub for the repository's releases at launch and every six
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

- **This Computer**: the desktop builds have it ([below](#this-computer)) as **Local hosts**, this computer's hosts
  for any server, WSL2 on Windows among them, and **Self host** ([below](#self-host)) runs Pikibun itself here. What
  the Electron app's had is left out: sharing the Pikibun it runs with others (`pikibun serve --share`, in a terminal),
  installing prerequisites itself, and hosting while the app is closed (its tray). In a browser there are no such
  sections.
- **Notifications while the app is closed**: the native apps show the account's notifications with NSH's
  `Notifications` only while they run (`src/lib/notifications.ts` asks the server's feed every 20 seconds, as a browser
  tab without Web Push does; pressing one opens its session, and one about the session in front isn't shown). Pushed
  ones wait for the server to send them through APNs and FCM, which NSH 0.7's `nsh-extra` `push` would receive on
  iPhone and Android (longbridge/nsh#1058). The web build turns them on in the browser as the web
  app does (Web Push through the `sw.js` the build ships, or while a tab is open), and every build manages the
  account's preferences and devices.
- **Up** in an empty chat box takes back a queued message on the desktops and in desktop browsers; on phones the
  queue's Edit does.
- **Downloads** (backups, exports) and **OAuth sign-ins** to document providers need the browser's own sign-in, so
  they are offered on the web build only; native builds point to Pikibun on the web. A workspace's remote MCP servers
  are the exception: the app opens a one-time link in the system browser, whose last page hands back a
  `pikibun://mcp/sign-in` link or a code to paste, and the app finishes the sign-in with its own.

## This Computer

Settings come in two sets (`scope` in `src/settings/index.tsx`): the signed-in server's (Profile, Password,
Notifications, Hosts, Workspaces, Administration) under its address, and this device's (Local hosts and Self host in
the desktop builds, Appearance everywhere) under **This Mac**, **This Computer** or, on phones and the web, **This
device**. See [the design](../../docs/design/local-hosts.md).

In the macOS, Windows and Linux builds, **Settings → This Mac → Local hosts** (This Computer elsewhere;
`#/settings/desktop`, as the React web client's address for it, and `#/settings/desktop/<id>` for one host's page)
makes this computer one or more of your hosts:

- **Several hosts**, each an entry of its own (`LocalHostConfig` and `LocalHosts` in `src/lib/this-computer.ts`; the
  list is `pikibun.thisComputer.hosts` in the app's storage): a server, a name, a sandbox, a state directory, the
  models it offers, the host IDs it has run as and whether it was running. Several may be for one server, with
  different sandboxes. Each runs its own `pikibun host --stdio [--state-dir <dir>]` process. The first on this computer
  uses `pikibun connect`'s state directory, and a pairing found there that no entry has (a terminal's) becomes an
  entry; every other host gets `~/.local/share/pikibun/hosts/<id>`. Entries are checked on load, so a state directory
  that isn't one of those (or `servers/<server>`, what earlier versions made) never reaches a shell. What earlier
  versions kept (`pikibun.thisComputer`, `pikibun.thisComputer.servers`) becomes the list on the first launch.
- **Add a host** in one step, for any server the app is signed in to (its saved token makes the pairing there): the
  app creates a pairing and hands its code straight to the host, once everything else is settled (prerequisites, the
  unsandboxed consent), so a refusal leaves no unused code. Before pairing, the form inspects where the host would run,
  so it shows the prerequisites, how sessions would be isolated, and Pi's sign-in where Pi has no model yet.
- **Sandbox per host**: on macOS **No sandbox** or **macOS sandbox** (Seatbelt, experimental), changeable while the
  host is stopped; on Windows **Windows sandbox** (its own, experimental, or none after consent) or **WSL2**, chosen
  when the host is added; Linux uses bubblewrap where it is installed. Each start asks the CLI's own
  `--unsafe-no-sandbox` warning in a native dialog where there is no sandbox.
- **WSL2 on Windows**: such a host runs the command inside a WSL distribution, `wsl [--distribution NAME] --cd ~ --exec
  bash -ilc 'PATH="$HOME/.local/share/pikibun/app-cli/node_modules/.bin:$PATH"; … exec pikibun host --stdio --state-dir …'`,
  so its sessions run in WSL's bubblewrap sandbox with that distribution's Node.js, Pi and Git. The distributions come
  from `wsl --list --quiet` (UTF-16, so the app drops its NULs). **Install pikibun** there installs into
  `~/.local/share/pikibun/app-cli` in WSL, and the app keeps the version it installed per distribution
  (`pikibun.commandUpdatedFor:wsl:<distro>`) to update it with the app, as it does its own copy.
- **Per environment**: the command, its installs and updates, and Pi's sign-in belong to where a host runs (this
  computer, or one WSL distribution: `LocalEnvironment`), shared by the hosts there; the models offered are each host's.
- **Continue a private session from here**: a private session whose host is offline says so (`components/OfflineHost.tsx`). Where one of
  this computer's hosts has run as that host ID, or it has only one for that server, **Start host** starts it. Otherwise **Connect This Mac**
  opens Local hosts. The host IDs this computer has run as, per server (`pikibun.thisComputer.connectors`, `ranHere`), still tell when the
  offline host was this computer after its entry was removed.
- **Read its sessions from it**: a session the server signed in to says runs on one of this computer's hosts opens from
  that host, over the same channel (`view` and `entries`), and carries on, read-only, while the server can't be
  reached; the server still checks who may read it ([the design](../../docs/design/local-views.md),
  `src/lib/local-sessions.ts`).
- **A host's page**: start and stop, pair again where its pairing can't be used, its sandbox, **Models offered** (Pi's
  choice, or the ones checked), **Sign Pi in to a provider** (Pi's own `/login`, run where the host runs: its page opens
  in the browser, a device code or API key is asked here, and the credential stays in Pi's configuration there),
  **Prerequisites** with what to run for each missing one, its activity, and **Remove**, which stops it and forgets it
  here (not for the one in `pikibun connect`'s state directory); the host stays on its server, offline, and its
  sessions' files stay in its folder.

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
environment the connector needs. NSH passes a child only a base set and the names granted, never the whole
environment, and the login shell restores only what the shell profile sets. So `SSH_AUTH_SOCK` and `SSH_AGENT_PID` are
granted too, and on macOS and Linux the command first fills an unset `SSH_AUTH_SOCK` from the GUI session
(`agentSocketImport` in `src/lib/agent-socket.ts`: `launchctl getenv`, `systemctl --user show-environment`), so the
owner's on-host sessions reach their ssh agent (see
[upstream workarounds](../../docs/design/upstream-workarounds.md)). The first host uses `pikibun connect`'s state directory, so a computer paired from a terminal carries over, and only
one of them runs at a time. Hosting lasts while the app is open, and each host starts again at the next launch if it was running
when the app quit, with the consent given for it then (`src/lib/this-computer.ts`). A `pikibun` too old to take `--state-dir` there is offered
as an update, as one without `host` is.

`tests/this-computer.test.tsx` runs the page against a stand-in for the command that speaks its protocol
(`tests/harness/this-computer.tsx`); `tests/host-cli.test.ts`, at the repository's root, runs the command itself.

## Self host

The macOS, Windows and Linux builds self host by default: at its first launch (nothing in its storage) the app starts
Pikibun on this computer and signs in to it, and its welcome screen offers **Sign in to another server** instead, which
opens the sign-in screen for that server's sign-in link. The app keeps a server once signed in to
(`pikibun.origin`), so that later launches open the sign-in screen instead. **Settings → Self host** (`#/settings/self-host`), **Pikibun on this Mac** in the sidebar's server switch,
and **Run Pikibun on this Mac** on the sign-in screen while signed out, run Pikibun itself on this computer, as `pikibun serve` does in a
terminal: the server and its web app on `http://127.0.0.1:7878`, for its owner alone, with this computer as the host
that runs their sessions.

- **Start and stop** it, with nothing to set up: there is no GitHub sign-in. Where this computer has no sandbox, it
  asks the same consent as Local hosts before this computer runs sessions.
- **Sign in to it**: the app switches its server to the running Pikibun (from Settings, after signing out of the one it
  is signed in to) and signs in as its owner with the server's sign-in token, which the command's status carries
  while it runs (`POST /api/auth/native/local`). The first sign-in makes the owner's account. Signed out of it, the
  sign-in screen's **Sign in to Pikibun on this Mac** does the same while the app runs it; for a local Pikibun the app
  doesn't run, it takes the link `pikibun serve` printed (`/api/auth/local?token=…`) pasted instead.
- It runs while the app is open, and starts again at the next launch if it was running when the app quit, after which
  the app tries its sign-in again.

The app runs `pikibun serve --stdio` (`apps/server/src/local/app-server.ts`, protocol in `packages/shared/src/app-server-protocol.ts`)
through the same login shell or `cmd` as `pikibun host --stdio` (`src/lib/pikibun-command.ts`), with JSON lines on
its stdin and stdout, where the sign-in token travels. When the command is missing or too old for `--stdio` (or so old
that it still asks for a GitHub OAuth app), the page offers Local hosts' **Install pikibun** or **Update pikibun** (the same copy, `nativeEnvironment()`). It uses `pikibun serve`'s state directory, so a
Pikibun set up in a terminal carries over, and only one of them runs at a time. Its host is the server's own (paired
with the server's state, as `pikibun serve` pairs it), not one of Local hosts': those stay hosts of whichever servers
they are paired with.

The sidebar's server switch (in the apps; the web client, bound to the server that serves it, has none, and reaches Hosts under Settings)
lists the servers the app is signed in to, **Pikibun on this Mac** in the desktop builds, which starts it where it
isn't running and signs in to it, and **Add a server**.

`tests/self-host.test.tsx` runs the page, the first launch, the sign-in screen, the server switch and Settings against a stand-in for the command
(`tests/harness/self-host.tsx`); `tests/serve-stdio.test.ts`, at the repository's root, runs the command itself.

## Known gaps, from NSH itself

Each workaround below is on the [list of upstream workarounds](../../docs/design/upstream-workarounds.md), with what tracks it upstream and when to remove it.

- **Text widths on the web**: NSH (0.4 to 0.7) lays text out with widths the browser's canvas measures and draws it as page
  text, so where a browser's canvas measures a font otherwise (another face for the system font, a minimum font size,
  text-only zoom) each run overlaps the next: inline code over the words before it. `scripts/nsh-web-fixes.mjs` patches
  the built runtime to measure such a font as the page draws it; drop the patch once NSH measures so itself.
- **Secure storage**: native sign-ins are kept in NSH's `Storage`, a plain file in the app's data, not the Keychain or
  Keystore ([nsh#1061](https://github.com/longbridge/nsh/issues/1061)).
- **Types**: NSH (0.4 to 0.7) declares `CryptoKey` only as a value; `src/globals.d.ts` declares the type the shared
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
