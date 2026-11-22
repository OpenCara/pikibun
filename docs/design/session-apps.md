# A session's app in its panel, and desktops for apps that have no web page

A session that serves a web app with the [tunnel](tunnel.md) could show it only as an address: the panel's **Online**
section opened it in another browser, and the **Browser** tab showed what the agent's own browser saw, as screenshots.
Nobody could use the app beside the conversation, and an app with no web page at all (Blender's window, a game, an
OpenGL viewer) couldn't be shown anywhere. A session on a GPU host is where both matter most: the work runs on the
host's GPU and the person drives it from wherever they are, a phone included. This note covers four parts: the
panel's **App** tab, what lets the web client frame the app, desktops in the sandbox, and NVIDIA's devices.

## Decisions

1. **The App tab shows the tunnel's app itself.** While the session has a tunnel online, the panel's **App** tab is a
   web view of the tunnel's link (`SessionTunnelView.url`, the address with its secret, which the panel already shows
   in **Online**): the person's clicks, typing and scrolling go to the app in the sandbox and its answers come back, so
   it works as a remote control of the app rather than a picture of it. Its toolbar names the address, says whether
   cloudflared is connected, and has **Reload** (the link again, with its secret, so a page that lost its cookie gets
   in), **Open** (in the system's browser) and the panel's full width. Without a tunnel it says how to get one. Nothing
   new is asked of hosts or the Pikibun server: the tab reads the view the panel already has.
2. **Who sees it.** Whoever reads the session's view, as for the **Online** section, which already shows them the link.
   Narrowing who gets the link is a change to the view (decision 12 of [the tunnel](tunnel.md)), not to this tab.
3. **A web view of its own.** The web view is `incognito`, so the app's cookies and storage live as long as the tab
   and never mix with another app's or the client's, and it has no `onMessage`, so the page can't talk to the client.
   In the apps it is the platform's web view, where the app's page is the top-level page; on the web it is Native
   Shell's sandboxed `<iframe>`, which keeps the page's own origin (`allow-same-origin` only for other sites' pages),
   so the page never reaches the client's origin, its cookies or its storage. Where the platform shows no web view,
   or refuses the address, the tab says so and offers **Open**.
4. **The web client may frame quick tunnels, and nothing else.** The client's page had no `frame-src`, so frames fell
   back to `default-src 'self'` and a `trycloudflare.com` frame was refused. The page's policy now has
   `frame-src 'self' https://*.trycloudflare.com`: the same `'self'` as before for the runtime's own frames, and Cloudflare's
   quick tunnels, the only addresses a tunnel has. `frame-ancestors 'none'` is unchanged: nothing may frame the client.
5. **The link's cookie inside a frame.** The tunnel's gate admits a browser by a cookie it sets when the link is
   opened, `SameSite=Lax`. In a frame of the Pikibun page the tunnel is a third party: browsers don't send a `Lax`
   cookie there, and block or partition third-party cookies, so every request after the first was refused. When the
   link is opened in a frame (`Sec-Fetch-Dest: iframe` or `frame`), the gate also sets `pikibun_tunnel_frame`,
   `SameSite=None; Secure; HttpOnly; Partitioned` ([CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies)),
   and admits either cookie. A partitioned cookie is kept for the top-level site it was set under, the page that framed
   the link, and sent only under it: other sites never send it, so cross-site requests to the tunnel (a form another
   page posts) carry no secret, as with the `Lax` cookie. A top-level visit still gets the `Lax` cookie alone, because a
   `SameSite=None` cookie set there would go with cross-site navigations to the tunnel. A browser that keeps no
   third-party cookie at all (Safari, without partitioned cookies) gets the gate's refusal in the frame, which then says
   to open the app in its own tab; the tab's **Open** does that. The gate takes both cookies out of what the server
   receives.
6. **Desktops: `serve.desktop`.** An app with no web page gets one: `serve` (the browser's and the tunnel's) takes
   `desktop: {width?, height?}` (from 320×240 to 3840×2160, 1280×800 by default). The program then starts on a virtual
   display of its own, and the port shows that display: a viewer page (noVNC) whose WebSocket reaches the display's VNC
   server. Through the tunnel it is a remote desktop, in the App tab or any browser; with the browser tool the agent
   sees, and clicks into, the same desktop. Everything else about `serve` is as it was: the program is still one of the
   `node` and `python` tools' programs, checked as those tools check them (a desktop app starts from a Python or Node.js
   launcher), and the tunnel's gate, link and lifetime are unchanged.
7. **The desktop's parts, in the sandbox.** `sandbox-python/desktop.py`, standard-library Python embedded like the
   other drivers and written afresh at each sandbox open, runs between the driver and the program: it starts TigerVNC's
   `Xvnc` on a free display (`-localhost`, `-nolisten tcp`, no VNC password: its RFB port is on the sandbox's own
   loopback, which nothing outside the sandbox reaches but through the gate), runs the program with `DISPLAY` set, a
   fontconfig file of its own (the sandbox has no `/etc/fonts`, as the browser found) and its output passed on, and
   serves the viewer's files and the WebSocket bridge on the declared port, on loopback. The bridge relays binary
   WebSocket frames to the display's RFB port and back (RFC 6455: masked client frames, ping, close; at most 16 viewers,
   frames up to 16 MiB). It pings each viewer every 30 seconds and lets go of one it hasn't heard from in 90 (a laptop
   that slept, a dropped network), so dead viewers don't hold the 16 places. Two desktops of one session (the tunnel's
   and a browser call's) share its `/tmp`, so both can pick the same free display: an `Xvnc` that exits before its
   display is ready is tried again on the next one, five times at most. The viewer's files are served by the request's
   normalized path inside noVNC's directory, which can't climb out of it; where a distribution links a file elsewhere
   (a shared JavaScript library), the link is followed, since that directory is the host's read-only `/usr`, which the
   session can't change. It ends when the program does, or when it is stopped, and takes the display with it. There is
   no window manager: one more program to find on hosts, for an app that is usually one window; windows open at the
   top left without decorations. The viewer's page is noVNC's own `vnc.html`, asked to connect at once, scale the
   display to the frame and reconnect after a drop.
8. **The host's programs.** Nothing is downloaded: `Xvnc` (TigerVNC: `tigervnc-standalone-server` on Debian and Ubuntu,
   `tigervnc-server-minimal` on Fedora, `tigervnc` on Arch) and noVNC's files (`novnc`, found under `/usr/share/novnc`
   or `/usr/share/webapps/novnc`) come from the host's packages, which the sandbox sees in its read-only `/usr`. Where
   one is missing, the call fails before anything starts and says which package installs it. The desktop draws with the
   CPU: `Xvnc` has no GPU acceleration, so OpenGL in it is Mesa's software renderer, while compute (CUDA, ROCm) still
   reaches the GPU the host lends.
9. **NVIDIA's devices with the render nodes.** A host's owner who lends the GPU lent its DRM render nodes (or WSL's
   `/dev/dxg`), which is what OpenGL, Vulkan and VA-API need, but CUDA opens NVIDIA's own character devices. Where the
   host has them, `gpuMounts` now also binds `/dev/nvidiactl`, `/dev/nvidia-uvm`, `/dev/nvidia-uvm-tools`,
   `/dev/nvidia-modeset` and each `/dev/nvidia<N>`, as devices, never through a symbolic link. The driver's libraries
   and `nvidia-smi` are in the host's `/usr`, which the sandbox already sees. The kind the connector reports stays
   `render` (or `dxg`): a new kind would make older Pikibun servers refuse the connector's manifest. A host with
   NVIDIA's devices and no render node lends them as `render` too.

## Where things are

| Part | Where |
|---|---|
| The App tab | `apps/nsh/src/session-panel/App.tsx`; `index.tsx` (the tab, its width) |
| The page's policy | `apps/server/src/static.ts` (`pageContentSecurityPolicy`); `tests/static.test.ts` |
| The gate's cookies | `apps/runner/src/tunnel-gate.ts`; `tests/tunnel.test.ts` |
| `serve.desktop` | `packages/shared/src/browser.ts` (`BrowserServe`, `desktopLimits`); `apps/runner/src/browser-command.ts` (`serveRequest`); `session/tools/browser.ts` |
| The desktop helper | `apps/runner/src/sandbox-python/desktop.py` (`DESKTOP_DRIVER`), started by `service.py` and `browser.py`; `sandbox.ts` mounts it at `/opt/pikibun/desktop/pikibun-desktop` |
| NVIDIA's devices | `apps/runner/src/host-config.ts` (`gpuMounts`); `tests/host-config.test.ts` |
| Tests | `apps/nsh/tests/panel.test.tsx` (the App tab), `tests/desktop-driver.test.ts` (the helper, with a stand-in `Xvnc`), `tests/tunnel.test.ts`, `tests/static.test.ts`, `tests/sandbox-python.test.ts` |

## Later

- **GPU-drawn desktops**: VirtualGL in front of `Xvnc`, or a streamer that encodes on the GPU (WebRTC), for 3D apps.
- **Who may drive the app**: the view gives the link to every reader; a view that shows it to writers alone would make
  the App tab theirs too.
- **Named tunnels** ([the tunnel's Later](tunnel.md#later)) would let the client frame one address per session.
