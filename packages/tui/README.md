# @pikibun/tui

[Pikibun](https://pikibun.com) in your terminal: sign in, start sessions, follow and answer their chats, review their
changes and manage your workspaces, as in the Pikibun app, drawn in the terminal by
[Native Shell](https://github.com/longbridge/nsh)'s terminal backend. It runs where the terminal does: over SSH on a
server, in tmux, in a container.

```sh
npm install -g @pikibun/tui
pikibun-tui
```

or, with the connector installed, `pikibun tui`, which starts it (and runs it from npm when it isn't installed).

It signs in with a code, as the desktop and phone apps do: under **Settings → Profile → Signed-in apps** on the web
or in another app, choose **Sign in an app**, and paste its link. Its sign-ins and settings are its own, apart from the
desktop app's.

| Keys | Do |
|---|---|
| Tab, Shift+Tab, the arrows | Move between controls |
| Enter, Space | Press the focused control |
| Escape | Leave a field; otherwise go back |
| Ctrl+S, Ctrl+R | Search the text on screen |
| F10 | The menu bar |
| Ctrl+C | Copy the selection; with none, quit |
| Ctrl+H, then E | The log |

The mouse works too, where the terminal reports it: clicks, the wheel, dragging to select text. `--no-mouse` leaves it to
the terminal and its own selection. `pikibun-tui --help` lists the options.

## Requirements

Linux, macOS or Windows, on x64 or arm64, and Node.js 18 or newer for the launcher. npm installs the terminal host for
the computer it installs on (`@pikibun/tui-<platform>-<arch>`, an optional dependency): don't leave optional
dependencies out. A terminal with 256 colors or true color looks best; 16 colors and `NO_COLOR` work too.

## Versions

`@pikibun/tui` is released with the Pikibun app (its `app-v` releases) and has the app's version. It updates with npm:
`npm install -g @pikibun/tui@latest`.

The launcher is MIT licensed, as Pikibun is. Native Shell's terminal host is Apache-2.0, as Native Shell publishes it.
