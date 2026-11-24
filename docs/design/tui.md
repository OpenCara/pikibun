# Pikibun in a terminal (`@pikibun/tui`)

Pikibun's client (`apps/nsh`) runs in a terminal too, drawn by [Native Shell](https://github.com/longbridge/nsh)'s
terminal backend ([its TUI docs](https://nsh.dev/docs/tui.md)): the same `App.tsx`, laid out on the terminal's grid of
Cells with ratatui, in the terminal's own font and colors, with the keyboard and the mouse. There is no second client:
the terminal is a device form of its own (`platform.idiom` is `"terminal"`), with the desktop's behavior
(`platform.desktop` is `true`, `platform.os` is the machine's), so the desktop layout, keyboard shortcuts, the command
palette, This Computer and Self host work there as they are.

## Its own package, not the connector's

The terminal app is published as `@pikibun/tui`, apart from `pikibun` (the connector and server CLI), which only gains
`pikibun tui` to start it:

- **It is the app, not the connector.** It is a build of `apps/nsh`, as the desktop and phone packages are, so it is
  released with them (`app-v` tags) and has their version; a fix to a screen ships with the app, not with a connector
  release, and Native Shell upgrades (which move fast) don't wait for one.
- **Native code.** Native Shell's terminal host (`nsh-tui-host`) is a Rust binary for each platform, about 20 MB packed.
  The connector is plain JavaScript that every host installs, many of them headless servers that would never draw a
  terminal UI; it stays that way.
- **Different people.** Every member of a workspace may want the terminal app on any computer; only a host's owner
  needs the connector, which holds model credentials and runs the sandbox, and keeps a small surface.
- **The app already finds the connector apart.** This Computer and Self host run a `pikibun` command they find or
  install; they do the same in a terminal.

`pikibun tui` keeps one command to remember: it starts the `pikibun-tui` on the `PATH`, or runs `@pikibun/tui@latest`
from npm (`npx --yes`) when none is, saying so (`packages/cli/src/tui.ts`).

## Packages

`packages/tui/scripts/build.mjs` (`pnpm build:tui`) writes them into `packages/tui/dist`:

- `tui/`, **`@pikibun/tui`**: the launcher (`bin/pikibun-tui.js`, `packages/tui/src`, bundled by esbuild, Node.js 18 or
  newer) and the app as `nsh build App.tsx --release` writes it (`app/bundle.js`, its source map, `capabilities.json` and
  `assets/`), with an `app.json` naming its own id, `com.pikibun.tui`. Its optional dependencies are the six hosts, at its
  own version.
- `hosts/<platform>-<arch>/`, **`@pikibun/tui-<platform>-<arch>`** for `linux-x64`, `linux-arm64`, `darwin-arm64`,
  `darwin-x64`, `win32-x64` and `win32-arm64`: `bin/nsh-tui-host` from Native Shell's `nsh-tui-<platform>.tar.gz`
  release asset, each checked against the SHA-256 `scripts/nsh.mjs` pins (`NSH_TUI_HOSTS`, `NSH_ASSET_SHA256`), with
  `os` and `cpu` set so npm installs only the computer's own. Native Shell is Apache-2.0, and each carries its license.

This is how esbuild ships its binaries: npm skips the optional dependencies whose `os` and `cpu` don't match, so an
install downloads one host. The launcher resolves `@pikibun/tui-<platform>-<arch>/bin/nsh-tui-host` from its own
package (or takes `PIKIBUN_TUI_HOST`, for a Native Shell checkout's), makes it executable if the unpacking lost that,
and runs it with `--bundle <app/bundle.js>` and its log in the system's place for logs
(`~/.local/state/pikibun/tui.log`, `~/Library/Logs/Pikibun/tui.log`, `%LOCALAPPDATA%\Pikibun\Logs\tui.log`), passing its
own options on (`--no-mouse`, `--points-per-cell`, `--fps`, `--log-file`, `--data-dir`). It refuses to start where its
input or output isn't a terminal, and returns the host's exit status.

`nsh package` has no terminal target (Native Shell 0.6.1), so the package is put together from `nsh build`'s output
and the prebuilt host. The host loads `bundle.js` as source: it refuses bytecode (`bundle.nshc`) from a file anyone could
replace, so the build leaves that out.

### Its own data

`app.json`'s `com.pikibun.tui` gives the terminal app a data directory of its own, beside the desktop app's
`com.pikibun.app`: its sign-ins, servers and settings are its own, and the two can run at once without sharing a
storage file. It signs in with a code, as the desktop and phone apps do, and names itself "Pikibun in a terminal" under
**Signed-in apps**.

## What differs in a terminal

`apps/nsh/src/lib/terminal.ts` exports `inTerminal`, read where the terminal needs its own behavior:

- **Updates come from npm.** The app's own updater downloads and swaps in the desktop packages, which a terminal app
  doesn't run from, so it isn't offered (`AppUpdater.offered`); Settings → Profile → This app says how npm updates it
  (`app-update-npm`).
- **Web views.** Native Shell draws no `WebView` in a terminal, and reports no error for it either: artifacts show their
  source, as where web views are unavailable, and the session's app (its tunnel) offers to open it in the browser.
- **Attachments.** Native Shell's terminal backend has no file picker, so the chat box has no attach button there
  (`AttachButton`); a pick would only fail.
- **Profile** names the device form `terminal`.

Everything else is the desktop's. Native Shell lays a design made in points out in whole Cells (8 × 16 points each),
shows colors as the terminal theme's meanings, and draws `nsh/base`'s controls in the terminal's forms.

## Tests and releases

- `pnpm test:client-tui` runs `apps/nsh/tests/terminal.test.tsx` with `nsh test --target tui`, on an in-memory terminal.
  The same file runs headless with the other tests (`nsh test` finds every test file, and a test can't tell its
  target): its steps are the same on both, and each asserts what its device form shows, so the headless run checks the
  desktop is unchanged and the terminal run checks the terminal's behavior and its Cells.
- CI's client job also builds `@pikibun/tui` for its runner and starts the packaged app in a pseudo-terminal (`script`),
  where a bundle the host can't load ends the run at once.
- `tests/tui.test.ts` covers the launcher, `pikibun tui` and the package layout, with a stand-in bundle.
- An `app-v` tag's run (`release-app.yml`) builds the packages for every host (`tui`), packs them where the hosts keep
  their executable bit, and publishes them (`npm-tui`): the hosts first, then `@pikibun/tui`, skipping what npm already
  has, with provenance. A prerelease goes to the `next` dist-tag. npm needs a trusted publisher for `release-app.yml` and
  the `release` environment on each of the seven packages, or the `NPM_TOKEN` secret; a package's first publication
  takes the token, as npm sets trusted publishing up only for a package that exists.
