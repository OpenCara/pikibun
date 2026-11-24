# Pikibun in a terminal

Pikibun's app runs in a terminal too: sign in, start sessions, follow and answer their chats, review their changes and
manage your workspaces, as in the desktop app, from any terminal, over SSH, in tmux or in a container. It is the same
app, drawn in the terminal by [Native Shell](https://github.com/longbridge/nsh)'s terminal backend.

```sh
npm install -g @pikibun/tui
pikibun-tui
```

With the connector installed, `pikibun tui` starts it too, and runs it from npm when it isn't installed.

It needs Linux, macOS or Windows on x64 or arm64, and Node.js 18 or newer. npm installs the part for your computer
(`@pikibun/tui-<platform>-<arch>`) as an optional dependency: an install with `--omit=optional` leaves it out, and
`pikibun-tui` then says so.

## Signing in

It signs in with a code, as the desktop and phone apps do: where you are signed in already, on the web or in another
app, open **Settings → Profile → Signed-in apps**, choose **Sign in an app**, and paste its link into the terminal app.
It lists itself there as "Pikibun in a terminal". Its sign-ins and settings are its own, apart from the desktop app's.

## Keys and the mouse

| Keys | Do |
|---|---|
| Tab, Shift+Tab | The next / previous control |
| The arrows | The nearest control that way |
| Enter, Space | Press the focused control |
| Escape | Leave a field; otherwise go back |
| Page Up, Page Down | Scroll a page |
| Ctrl+S, Ctrl+R | Search the text on screen forward / backward |
| F10 | The menu bar |
| Ctrl+C | Copy the selection; with none, quit |
| Ctrl+H, then E | The log |

Text fields take readline's keys as well (Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+W, Alt+F, Alt+B and the rest), and the app's own
shortcuts work as on the desktop: the command palette, a new session. The mouse works where the terminal reports it:
clicks, the wheel, dragging to select text. `pikibun-tui --no-mouse` leaves the mouse to the terminal and its own text
selection.

Copying goes to your computer's clipboard through the terminal (OSC 52), over SSH too, where the terminal allows it.

## What a terminal can't show

- **Web pages.** An HTML or SVG artifact shows its source, and a session's app (its tunnel) opens in your browser.
- **Pictures.** Images keep their place on the page, blank.
- **Updates.** npm updates it: `npm install -g @pikibun/tui@latest`. Settings → Profile → This app says so, where the
  desktop app offers its own updates.

A terminal with 256 colors or true color shows cards and panels as bands of its own background; 16 colors and
`NO_COLOR` work too, with lines and reverse video.

## Options

| Option | Does |
|---|---|
| `--no-mouse` | Leave the mouse to the terminal |
| `--points-per-cell <WxH>` | The size of one terminal Cell in points (`8x16`): a larger one fits less on the screen |
| `--fps` | The frame rate and frame times in the top right corner |
| `--log-file <path>` | Where the log goes (`~/.local/state/pikibun/tui.log`, `~/Library/Logs/Pikibun/tui.log` on macOS, `%LOCALAPPDATA%\Pikibun\Logs\tui.log` on Windows) |
| `--data-dir <path>` | Where it keeps its sign-ins and settings |

How it is built and released: [its design](design/tui.md).
