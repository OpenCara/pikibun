# Pikibun for the desktop

An Electron app with three jobs, each the full version of what the command line and the website do:

- **Pikibun windows** show a Pikibun server's web app, as a browser does (https://pikibun.com by default). Links of the
  same server that ask for a new window (a session opened with ⌘-click or a middle click, **Open Link in New Window**
  in the right-click menu, **File → New Window**) open in another Pikibun window, so sessions can sit side by side.
  **File → Open Server** opens any server this computer connects to.
- **This Mac** runs the `pikibun` connector here, so this computer hosts Pi agent sessions without a terminal, for one
  server or several at once (**Add a server**), each with its own pairing, host process and model choice, as one
  `pikibun connect` per server would.
- **Settings → Pikibun on this computer** runs Pikibun itself here, as `pikibun serve` does: **Just for Me**, on
  loopback for your GitHub account alone, or **Share with Others**, as `pikibun serve --share`, a full multi-user server
  at a public HTTPS address that others sign in to and pair their own hosts with.

Its settings live in the web app's own Settings page: in a Pikibun window, **Settings → This Mac** (⌘, opens it)
shows every server and its host, pairs this computer with the server the page belongs to in one step (also from **Hosts
→ Pair a host**), and runs or shares Pikibun on this computer. The app's own This Mac and Settings windows (**App
Settings…**) remain for what a web page never gets: GitHub OAuth apps' secrets, password administrators, pairing with a
code for any server, and settings while no server answers.

Builds ship for macOS (Apple silicon) and Windows (x64; Windows on Arm runs it emulated); the Linux target is declared
for later. On Windows, each server's host runs its sessions in WSL2 or natively: see [Windows](#windows).

- Pikibun windows load their server with no preload and no Node, in their own persistent session. Each navigates only
  within its server and GitHub (for sign-in); other links open in your default browser. The main window follows
  Pikibun on this computer while it runs, else shows the primary server (Settings); others stay on the server they
  opened.
- Pikibun windows have a preload of their own (`src/preload/remote.ts`) exposing `window.pikibunDesktop`
  (`src/shared/remote-bridge.ts`) for Settings → This Mac. The main process honors its calls only from the main frame
  of a Pikibun window showing one of the owner's servers (a connection, or Pikibun on this computer), validates every
  payload, and asks in a native dialog naming the page's server before adding, removing or changing servers and before
  starting or stopping Pikibun on this computer. A page pairs only the connection to its own server, with a pairing it
  just created for its signed-in user; it sees other servers' hosts but not their activity logs; and it can't send
  secrets, which only the app's own Settings window takes.
- This Mac and Settings are pages bundled with the app (served by its own `pikibun-app:` scheme under a strict CSP).
  Their preload exposes a small typed bridge (`src/shared/bridge.ts`); the main process checks the sender and
  validates every call.
- Each server's connector runs in an Electron utility process of its own (Electron's own Node.js 24):
  `dist/host/desktop-host.mjs`, which `scripts/build.mjs` bundles from `apps/runner/src/desktop-host.ts`. The primary
  server's uses the CLI's private state (`~/.local/share/pikibun/connector`), so a computer paired with
  `pikibun connect` is adopted as is; only one of the two can run at a time, and the app says so when the CLI holds the
  pairing. Every other server's has its own (`~/.local/share/pikibun/connections/<id>`), and This Mac shows the
  `pikibun connect --state-dir` command that runs the same connection from a terminal. Removing a server stops its host
  and leaves its state directory alone. Pairing codes travel only over the IPC channel: never argv, environment, files
  or logs.
- On macOS each server's host chooses its **Sandbox** (This Mac, or Settings › This Mac in the web app, which asks in a
  native dialog first), only while it is stopped, from its next start: **None**, the default, where starting the host
  asks for consent in a native dialog showing the CLI's own `--unsafe-no-sandbox` warning; or **macOS sandbox
  (experimental)**, where the host asks the connector for macOS's own Seatbelt sandbox (the desktop host's
  `experimentalSandbox` request, as `pikibun connect --experimental-sandbox`), and, while its prerequisites are missing
  (macOS 15 or later, the developer tools), offers the same consent naming what is missing. Both use the same connector
  state and pairing. In the sandbox, as the CLI's, shell commands run only in the host owner's own sessions, since
  macOS can't limit a group of processes' memory or count. Linux uses the bubblewrap sandbox when its prerequisites are
  installed and asks the same consent otherwise. Windows runs each host in WSL2's bubblewrap sandbox or natively, as
  its owner chooses ([Windows](#windows)).
- Getting a computer ready to host happens in This Mac (This Computer), without a terminal:
  - **Pi**: the connector bundles Pi, so no separate Pi install is needed, only a provider to sign in to. **Sign Pi in
    to a provider** (under Models offered) lists Pi's providers and runs the provider's own sign-in in the host, as
    `pi`'s `/login` does (`apps/runner/src/pi-login.ts`, through Pi's `ModelRuntime.login`): its page opens in the
    browser, a device code or API key is asked in the window, and the credential is saved in Pi's `auth.json` on that
    computer (inside WSL2 for a WSL2 host) and never sent to Pikibun or a server's page. Answers travel only over the
    IPC channel, as pairing codes do; secret ones are never shown, logged or kept.
  - **Prerequisites**: each missing one says how to get it, with the command to run, and where the app can do it, a
    button that does, once its owner confirms in a native dialog: Apple's installer for the Command Line Tools
    (`xcode-select --install`, which brings Git and Python 3); on Windows Git for Windows (winget), the MXC SDK (npm),
    Windows Update (Settings), WSL itself (`wsl --install`, as administrator), and in WSL2, Node.js 24 (nvm) and the
    sandbox's packages (`sudo apt-get install`). Each runs where its owner sees it (an installer, a PowerShell window
    that stays open, Settings); Refresh shows what changed. The app builds each from a fixed list
    (`src/main/setup-actions.ts`), never from a command a host or a page sent, and only for something the latest
    check found missing. Servers' Settings pages show what is missing and link to This Mac, which alone installs
    things or takes an API key.
- Pikibun on this computer runs the local server (`dist/host/desktop-server.mjs`, bundled from
  `apps/server/src/local/desktop.ts`) in a second utility process, with `pikibun serve`'s state
  (`~/.local/share/pikibun/server`), so the two share their data; a kernel lease on that directory (flock or lockf, as
  the connector's) lets only one of them run at a time. The GitHub OAuth apps' secrets and administrators' passwords
  travel only over the IPC channel. While it runs, the main Pikibun window shows it instead of the primary server,
  opening its sign-in link while nobody has claimed it; this computer becomes its host once the owner (shared, the first
  listed administrator with an account) has signed in, after the same unsandboxed consent where there is no sandbox. It
  starts again at launch while it is on, the way it ran, and stopping it in Settings returns the window to the primary
  server.
- Shared, it needs a public HTTPS address served by a TLS proxy or tunnel you run (`tailscale serve`, Cloudflare
  Tunnel, Caddy) that forwards to the address Settings shows (`http://127.0.0.1:7878`, or every interface). Settings
  takes its administrators as GitHub logins (looked up on api.github.com), `github:12345` or `password:alice`, who may
  create an account, whether usernames and passwords sign in, and a GitHub OAuth app whose callback is on the public
  address; **Create Administrator** makes a listed password administrator's account on the running server. The
  settings are saved with the server's state, which `pikibun serve --share` reads too.
- Updates: a packaged app checks GitHub's releases of this repository soon after launch and every six hours
  (`src/main/updates.ts`) for a `desktop-v1.2.3` release newer than itself, skipping drafts, other release lines and,
  unless it runs a prerelease itself, prereleases. Once one is out, the app menu (**File** outside macOS) and the tray
  offer **Update to Pikibun 1.2.3…**, and Pikibun windows show an **Update** button in the web app's sidebar and in
  Settings › This Mac (`DesktopView.update`). Updating opens the release page, built from the tag, in the browser:
  nothing downloads or installs by itself. **Check for Updates…** in the same menu checks at once.
- A host left running when Pikibun quits starts again the next time it opens, with the consent given at its start;
  stopping the host, or a host failure, ends that, for each server on its own. With a host running, closing every
  window keeps Pikibun in the menu bar, whose menu starts and stops each server's host.

## Develop

```sh
pnpm --filter @pikibun/desktop dev        # builds the app and its connector host, then opens it
pnpm --filter @pikibun/desktop typecheck
```

Development switches, honored only when the app runs unpackaged:

| Variable | Effect |
| --- | --- |
| `PIKIBUN_DESKTOP_ALLOW_FAUX=1` | The host offers the deterministic fixture model instead of Pi's (needs a test-mode server) |
| `PIKIBUN_DESKTOP_STATE_DIR=/path` | Connector state other than the CLI's, so your real pairing is untouched; other servers' go in `connections/` beside it |
| `PIKIBUN_DESKTOP_SERVER_STATE_DIR=/path` | Local server state other than `pikibun serve`'s (with `PIKIBUN_DESKTOP_ALLOW_FAUX=1` it runs in test mode with the fixture model) |
| `PIKIBUN_DESKTOP_USER_DATA=/path` | A separate app profile (settings, window bounds, Pikibun session) |
| `PIKIBUN_DESKTOP_CHECK_UPDATES=1` | Check GitHub for newer releases as a packaged app does (an unpackaged app has the version in `package.json`) |

`PIKIBUN_DESKTOP_SMOKE=/path` works in any build: the app writes `main.png` (Pikibun window), `host.png` (This Mac)
and `settings.png` there once each has rendered, then quits. It never starts or resumes the host.

For an end-to-end run against a local test-mode server, start `pnpm dev:native --port 8789 --no-host --pairing`, set
the server to `http://127.0.0.1:8789` in Settings, and pair from This Mac with the printed pairing ID and code.

A GUI app does not inherit your shell's environment: Pi providers configured only through environment variables (for
example `ANTHROPIC_API_KEY` in `~/.zshrc`) are not visible to the host. Sign Pi in to the provider in This Mac (or
with `pi`'s `/login`), which saves it in Pi's `auth.json`, so the host finds those models.

## Package

```sh
pnpm --filter @pikibun/desktop dist
```

This builds the app, stages the connector and the local server into `dist/connector` (with the web app from the
repository's `dist/web`: run `pnpm build` first) with its production dependencies installed by `npm ci`
from `packages/cli/npm-shrinkwrap.json` (the registry must be reachable), and writes an arm64 DMG to
`dist/release`. The connector is copied to `Pikibun.app/Contents/Resources/connector`, outside the asar.

On Windows, `pnpm --filter @pikibun/desktop dist:win` does the same and writes an x64 NSIS installer,
`Pikibun-<version>-x64-setup.exe`, which installs per user (no administrator rights) into
`%LOCALAPPDATA%\Programs\Pikibun`; the connector is in `resources\connector` beside `app.asar`. Add `--dir` to
`electron-builder --win --x64` for the unpacked app alone (`dist/release/win-unpacked`).

Icons: `build/icon.png` (1024×1024) and `assets/icon.png` (512×512) are the Pikibun artwork (`docs/images/pikibun.webp`)
on a rounded night-sky tile on the macOS icon grid (an 824px tile with 100px margins, transparent outside).
`docs/images/pikibun-icon.png`, at the top of the main README, is that tile alone (without the margins) at 320×320.
`assets/tray.png` is the vector mark (`apps/web/public/favicon.svg`) at 32×32, and `build/tray.svg` (Pikibun's
silhouette, black on transparent, for macOS to tint) is the source of `assets/trayTemplate{,@2x}.png` at 18 and 36px;
re-render the PNGs at those sizes after changing them.

## Signing and notarization

Builds are ad-hoc signed (`mac.identity: "-"`), which is enough to run them on the Mac that built them; Gatekeeper
blocks them elsewhere (right-click › Open, or `xattr -dr com.apple.quarantine Pikibun.app`). For distribution:

1. Install a **Developer ID Application** certificate in the login keychain (or export it as a .p12 and set
   `CSC_LINK` to its path or base64 and `CSC_KEY_PASSWORD` to its password).
2. In `electron-builder.yml`, replace `identity: "-"` with the certificate's name (e.g.
   `identity: "Your Name (TEAMID)"`, or drop the line so electron-builder picks it up), set `hardenedRuntime: true`
   (it uses `build/entitlements.mac.plist`) and `notarize: true`.
3. Provide notarization credentials in the environment, either an App Store Connect API key (`APPLE_API_KEY` = path to
   the .p8, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or an Apple ID (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`), then run `pnpm --filter @pikibun/desktop dist`. electron-builder signs the app and the connector's
   files, submits it to Apple's notary service and staples the ticket.

The desktop release workflow (`.github/workflows/release-desktop.yml`, started by a `desktop-v1.2.3` tag) does all of
this without editing `electron-builder.yml`: once `MAC_CERTIFICATE_P12` and the notarization key are configured (the
root README, "Releasing", lists them), it overrides the identity, hardened runtime and notarization on the command
line. It then attaches the DMG to the tag's GitHub release, and without those secrets it releases the ad-hoc
signed build. A Windows job builds the x64 installer from the same tag and attaches it to the same release: signed when
`WIN_CERTIFICATE_P12` (a base64 code-signing .p12) and `WIN_CERTIFICATE_PASSWORD` are set in the `release`
environment, otherwise unsigned, so SmartScreen asks before its first launch (**More info → Run anyway**). The Linux
build will join as one more job.

`.github/workflows/desktop-windows.yml` builds the unpacked Windows app on every change to the app or its connector
host in a pull request or on main, launches it once with `PIKIBUN_DESKTOP_SMOKE`, and uploads its windows' screenshots
(`desktop-windows-smoke`).

Check the result with `codesign --verify --deep --strict --verbose=2 dist/release/mac-arm64/Pikibun.app` and
`spctl --assess --type execute --verbose dist/release/mac-arm64/Pikibun.app`.

## Windows

The window is **This Computer** instead of This Mac, and each server's host chooses where its sessions run, under
**Sandbox** (This Computer, or Settings › This Computer in the web app, which asks in a native dialog first). The
choice changes only while that host is stopped, and applies from its next start:

- **WSL2** (the default): the host runs inside a WSL2 distribution, WSL's default WSL2 one or the one chosen, and its
  sessions run in WSL2's bubblewrap sandbox, exactly as `pikibun connect` run in that distribution. It needs what the
  CLI needs there: Node.js 24 or newer, Pi configured with its models, and bubblewrap, Python 3, Git and util-linux
  (`sudo apt install bubblewrap python3 git util-linux` on Ubuntu); This Computer lists what is missing. Pi's
  configuration and the connector's state are the distribution's own, so a distribution already paired with
  `pikibun connect` is adopted as is (the primary server uses `~/.local/share/pikibun/connector` there, every other
  one `~/.local/share/pikibun/connections/<id>`), and only one of the two can run at a time.
- **Native Windows**: the host runs in the app, as on macOS, and its sessions run in Windows' own process containers
  (`pikibun connect --experimental-sandbox`: Windows 11 24H2 or later with the October 2026 update, Git for Windows,
  busybox-w32 and Microsoft's MXC SDK; experimental, see `docs/design/windows-sandbox.md`). Every native host shares
  one MXC SDK install, beside the primary connection's state (`%USERPROFILE%\.local\share\pikibun\connector\mxc`,
  or `PIKIBUN_MXC_RUNTIME`); its prerequisite shows the command that installs it. While the sandbox isn't ready, the
  host offers to run unsandboxed instead, after the same consent as `--unsafe-no-sandbox`, which needs only Git for
  Windows. Pi's configuration and the connector's state are your Windows profile's.

The two are separate hosts with separate pairings, so switching a server's host from one to the other shows the other's
pairing, if it has one. Different servers can use different ones: a team's server in WSL2 and another natively, say.

How a WSL2 host runs: the app starts
`wsl.exe --distribution <name> --cd <the app's resources\connector> --exec /bin/sh dist/wsl-host.sh <version> [--state-dir …]`
(`src/main/wsl.ts`). `src/wsl/wsl-host.sh` finds Node.js 24 (on PATH, or from nvm, fnm, Volta, mise or asdf), copies
the connector into `~/.local/share/pikibun/desktop/connector-<version>` the first time a version starts (WSL2's own
filesystem loads modules much faster than the Windows drive, and keeps POSIX permissions), removes older versions' copies,
then runs the same host bundle with `--stdio`: requests are JSON lines on its stdin and events are lines on its stdout
(`STDIO_FRAME`, `desktop-transport.ts`), the only channel wsl.exe carries, and pairing codes cross it as they cross a
utility process's port. What it can't do (no WSL2, a WSL 1 distribution, no Node.js 24) is shown where the host's
isolation is. Unpackaged, WSL2 hosts run the staged `dist/connector` (`node scripts/stage-connector.mjs`), since the
workspace's `node_modules` are Windows links WSL2 can't follow; the development state directory switches apply to
native hosts only.

Pikibun on this computer (Settings) runs on Windows too, but doesn't make this computer its host yet: pair another
machine with it. (Its loopback address isn't WSL2's, unless WSL uses mirrored networking.)

## Linux

The code keeps platform choices explicit (`process.platform` checks in `src/main`): the tray uses a full-color icon
outside macOS, window icons come from `assets/icon.png`, open-at-login is offered only where Electron supports it, and
closing every window quits unless the host is running. `electron-builder.yml` declares AppImage and deb targets, which
`electron-builder --linux` builds; no release ships them yet.
