# Self host: run your own Pikibun on this computer

When you self host, all of Pikibun runs on this computer: the server, its data, and this computer as the host that runs your sessions. The app starts it, stops it and signs you in to it. You don't need an account at any Pikibun service, nor a GitHub account, and nothing is deployed anywhere.

Choose this mode when:

- you want Pikibun just for yourself, and your work shouldn't leave this computer, or
- you want to try a server of your own before running one for a team. The same server can later [serve a team](#sharing-it-with-your-team).

## Before you start

- **Node.js 24 or newer**, from [nodejs.org](https://nodejs.org) (on a Mac, `brew install node` also works). The app runs Pikibun's server with it.
- **Pi signed in to a model provider** on this computer, so that your sessions have models. If you don't use Pi yet, sign it in under **Settings → This Mac → Sign Pi in to a provider** once you're signed in, then stop and start your Pikibun so it offers the new models. Pi keeps the credential on this computer.

## 1. Open Self host

- **Signed out** (a fresh install, say): on the sign-in screen, choose **Run Pikibun on this Mac** (**this computer** on Windows and Linux).
- **Signed in** to another server: open **Settings → Self host**.

Both open the same page. If **Install Pikibun's command** appears, choose **Install pikibun**: npm installs it into the app's own folder in about a minute, with no `sudo`. The app updates that copy itself the first time it starts after an update of the app, before your Pikibun starts again. When a `pikibun` you installed in a terminal is too old for the app, the page offers **Update pikibun** instead.

## 2. Start Pikibun

Choose **Start Pikibun**. Where this computer has no sandbox (macOS and Windows, or Linux without bubblewrap), the app first asks whether to **Run unsandboxed**: your sessions' commands then run as you, with access to your files and network. Read [Running without the sandbox](../hosts.md#running-without-the-sandbox) before you agree. If you cancel, nothing starts.

The badge turns **Running**, and the page shows your Pikibun's address, `http://127.0.0.1:7878`. It is reachable from this computer only.

## 3. Sign in to it

Choose **Sign in to it**:

- From the sign-in screen, the app switches its **Server** to your Pikibun and signs you in.
- From Settings, the app asks first, then signs out of the server you were using and signs in to your Pikibun. Nothing moves: your sessions and workspaces there stay where they are.

There is nothing to type: each time your Pikibun starts, it makes a private sign-in token and tells only the app, which signs you in with it as your Pikibun's owner, the only account that can ever sign in to it. Your first sign-in makes that account, named after your user on this computer (`password:ada` for the user `ada`). Signed out later, the sign-in screen's **Sign in to Pikibun on this Mac** signs you back in.

Once you're signed in, this computer pairs itself with your Pikibun as its host. **This Mac as its host** on the Self host page turns **Online**, and the computer appears under **Settings → Hosts**. Start a session in your **Private** workspace, as in [Client](client.md#3-work-in-sessions).

Your Pikibun runs its own host for this computer. **Settings → This Mac** stays the host of the servers it is paired with (your team's, say), so there's no need to pair This Mac with your Pikibun as well.

### Repositories

Your account has no GitHub sign-in, so it can't bind or clone **github.com** repositories, or use the GitHub tools. It works with every other Git provider, GitHub Enterprise Server included, through the personal access tokens you add under **Settings → Profile → Git accounts** (see [Repositories and Git accounts](../repositories.md)). If you set up your Pikibun before it signed in without GitHub, you keep the GitHub account you signed in with then, and its repositories, for as long as GitHub keeps its token.

## Day to day

- **It runs while the app is open.** Quitting the app stops it. If it was running when you quit, it starts again at the next launch, and the app signs back in to it.
- **Stop** on the Self host page stops it. It won't start again at the next launch until you start it.
- **Switch to another server:** **Settings → Profile → Sign out**, then **Change** the server on the sign-in screen (see [Switching between modes](README.md#switching-between-modes)). Your Pikibun keeps running, and keeps its data, until you stop it.
- **Your data** (the database, session backups, the server's secrets and this computer's pairing with it) is in `~/.local/share/pikibun/server`, shown under **State directory**. It is the same state `pikibun serve` uses in a terminal, so a Pikibun you set up there carries over. Only one of the two runs at a time.
- **Recent activity** at the bottom of the page shows what the server did, and why it couldn't start.

## Sharing it with your team

The app runs your Pikibun for you alone. The same server, with the same data, can serve others too, from a terminal: stop it in the app, then run `npx pikibun@latest serve --share`. It needs a public HTTPS address served by a TLS proxy or tunnel you run (Tailscale Serve or Funnel, Cloudflare Tunnel, Caddy), administrators (list yourself, `password:ada`, and give yourself a password with `--create-admin ada`), and a way for others to sign in: usernames and passwords, or a GitHub OAuth app whose callback is on that address. See [Sharing it with others](../local.md#sharing-it-with-others).

Your teammates then use the app as [clients](client.md) of your server's public address, and can make their own computers [hosts](host.md) for it.
