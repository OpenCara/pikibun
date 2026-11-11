# Self host: run your own Pikibun on this computer

When you self host, all of Pikibun runs on this computer: the server, its data, and this computer as the host that runs your sessions. The app is your client for it. You don't need an account at any Pikibun service, and nothing is deployed anywhere.

Choose this mode when:

- you want Pikibun just for yourself, and your work shouldn't leave this computer, or
- you want to try a server of your own before running one for a team. The same server can later [serve a team](#sharing-it-with-your-team).

The app can't start the server itself yet. You start it with one command in a terminal, and the app signs in to it like any other server. Everything else happens in the app.

## Before you start

- **Node.js 24 or newer**, from [nodejs.org](https://nodejs.org) (on a Mac, `brew install node` also works).
- **A GitHub OAuth app of your own**, which signs you in to your server. Register it once at <https://github.com/settings/applications/new>:
  - **Homepage URL:** `http://127.0.0.1`
  - **Authorization callback URL:** `http://127.0.0.1/api/auth/github/callback`

  Then keep the page open: you'll need its **Client ID**, and a **client secret** you generate there.
- **Pi signed in to a model provider** on this computer, so that your sessions have models. Run `pi` in a terminal and use `/login`. Or, once you've [signed in from the app](#3-sign-in-from-the-app), use **Settings → This Mac → Sign Pi in to a provider**. That section works without pairing, and Pi keeps the credential on this computer either way. Restart `pikibun serve` after you sign Pi in, so it offers the new models.

## 1. Start your server

Open a terminal and run:

```sh
npx pikibun@latest serve
```

How this computer runs sessions depends on its system:

| This computer | What to run |
| --- | --- |
| **Linux** with bubblewrap, Python 3, Git and `flock` | `npx pikibun@latest serve`: sessions run in the bubblewrap sandbox |
| **macOS**, **Windows**, or Linux without bubblewrap | `npx pikibun@latest serve --unsafe-no-sandbox`: sessions run directly as you. Read the warning and type `unsandboxed` to confirm. It's asked at every start. |
| Any, to let the app host instead | `npx pikibun@latest serve --no-host`: see [Let the app be the host](#let-the-app-be-the-host) |

The first run asks for your OAuth app's **Client ID** and then its secret, at a hidden prompt. Then it prints:

```
Pikibun is running at http://127.0.0.1:7878 (this computer only).
Sign in for the first time with this link; the GitHub account that opens it becomes this Pikibun's owner:
  http://127.0.0.1:7878/api/auth/local/claim?token=…
```

Keep the terminal open: your server runs while it does.

## 2. Claim it in your browser

Open the printed link **in your web browser**, not in the app, and sign in with GitHub. That GitHub account becomes your server's owner, and from then on the only account that can sign in. Keep the link private until you've used it.

The first sign-in has to go through this link in a browser. The app's own sign-in window can't open it, so the app is refused until your server has an owner.

## 3. Sign in from the app

1. If the app is signed in to another server, sign out: **Settings → Profile → Sign out**.
2. On the sign-in screen, choose **Change** next to **Server**, and enter `http://127.0.0.1:7878`.
3. Choose **Continue with GitHub**, and sign in with the GitHub account that claimed the server.

## 4. Check your host and start working

Once you're signed in, `pikibun serve` pairs this computer with your server by itself, with no code to copy. The terminal says *This computer: connected*, and **Settings → Hosts** lists the computer as online. Start a session in your **Private** workspace, pinned at the top of the sidebar, as in [Client](client.md#3-work-in-sessions).

**Don't also choose Pair This Mac** under **Settings → This Mac** while `pikibun serve` runs this computer as its host. That would add a second host for the same computer. It would also move the app's pairing (the one `pikibun connect` uses) away from any other server you host for.

### Let the app be the host

On macOS and Windows, you may prefer the app's host to `pikibun serve`'s. With the app's host, you choose the macOS sandbox, pick the models to offer, and sign Pi in from **Settings → This Mac**. To use it:

1. Start the server with `npx pikibun@latest serve --no-host`.
2. Sign in from the app, as above.
3. Follow [Host](host.md) to pair This Mac with `127.0.0.1:7878`.

The app hosts for one server at a time. If This Mac is already a host of your team's server, pairing it with your own server replaces that pairing. In that case, keep `pikibun serve`'s own host instead.

## Day to day

- **Start:** run the same `npx pikibun@latest serve` command, with the same options. Later runs remember the OAuth app and port, and need no sign-in link.
- **Stop:** press Ctrl+C in its terminal. While it's stopped, the app shows **Can't reach Pikibun**. Start the server again, then choose **Try again**.
- **Switch to another server:** sign out and **Change** the server, as in [Switching between modes](README.md#switching-between-modes). Your own server keeps its data while you're away.
- **Your data** (the database, session backups, the server's secrets and this computer's pairing) is in `~/.local/share/pikibun/server`. It's separate from `pikibun connect`'s, so this computer stays a host of a team's server too. Use `--state-dir` to keep it somewhere else.

Run `npx pikibun@latest serve --help` for every option, and see [Running Pikibun on your own computer](../local.md) for the details.

## Sharing it with your team

The same server, with the same data, can serve others too: `pikibun serve --share`. For that, it needs a public HTTPS address served by a TLS proxy or tunnel you run (Tailscale Serve or Funnel, Cloudflare Tunnel, Caddy), administrators, and a GitHub OAuth app whose callback is on that address. See [Sharing it with others](../local.md#sharing-it-with-others).

Your teammates then use the app as [clients](client.md) of your server's public address, and can make their own computers [hosts](host.md) for it.
