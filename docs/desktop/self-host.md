# Self host: run your own Pikibun on this computer

When you self host, all of Pikibun runs on this computer: the server, its data, and this computer as the host that runs your sessions. The app starts it, stops it and signs in to it. You don't need an account at any Pikibun service, and nothing is deployed anywhere.

Choose this mode when:

- you want Pikibun just for yourself, and your work shouldn't leave this computer, or
- you want to try a server of your own before running one for a team. The same server can later [serve a team](#sharing-it-with-your-team).

## Before you start

- **Node.js 24 or newer**, from [nodejs.org](https://nodejs.org) (on a Mac, `brew install node` also works). The app runs Pikibun's server with it.
- **A GitHub account.** Your Pikibun signs you in with GitHub, through an OAuth app you register once. The app shows you how.
- **Pi signed in to a model provider** on this computer, so that your sessions have models. If you don't use Pi yet, sign it in under **Settings → This Mac → Sign Pi in to a provider** once you're signed in, then stop and start your Pikibun so it offers the new models. Pi keeps the credential on this computer.

## 1. Open Self host

- **Signed out** (a fresh install, say): on the sign-in screen, choose **Run Pikibun on this Mac** (**this computer** on Windows and Linux).
- **Signed in** to another server: open **Settings → Self host**.

Both open the same page. If **Install Pikibun's command** appears, choose **Install pikibun**: npm installs it into the app's own folder in about a minute, with no `sudo`. When the app is newer than the command, the page offers **Update pikibun** instead.

## 2. Add your GitHub OAuth app

The first time, **GitHub sign-in** asks for an OAuth app of your own:

1. Choose **Register it on GitHub**. GitHub's page for a new OAuth app opens in your browser.
2. Fill it in with the two addresses the page shows, using **Copy** for each:
   - **Homepage URL:** `http://127.0.0.1`
   - **Authorization callback URL:** `http://127.0.0.1/api/auth/github/callback`
3. Register it, then **Generate a new client secret**.
4. Back in Pikibun, enter the **Client ID** and **Client secret**.

They're saved when Pikibun starts. The secret is kept with your server's private state on this computer, and sent nowhere else. Later starts use the saved app. **Replace** swaps it for another.

## 3. Start Pikibun

Choose **Start Pikibun**. Where this computer has no sandbox (macOS and Windows, or Linux without bubblewrap), the app first asks whether to **Run unsandboxed**: your sessions' commands then run as you, with access to your files and network. Read [Running without the sandbox](../hosts.md#running-without-the-sandbox) before you agree. If you cancel, nothing starts.

The badge turns **Running**, and the page shows your Pikibun's address, `http://127.0.0.1:7878`. It is reachable from this computer only.

## 4. Sign in to it

Choose **Sign in to it**:

- From the sign-in screen, the app switches its **Server** to your Pikibun.
- From Settings, the app asks first, then signs out of the server you were using and switches to your Pikibun. Nothing moves: your sessions and workspaces there stay where they are.

Then choose **Continue with GitHub**. While nobody has signed in yet, the sign-in screen says **Set up Pikibun on this Mac**: the GitHub account you sign in with becomes your Pikibun's owner, and the only account that can ever sign in to it.

Once you're signed in, this computer pairs itself with your Pikibun as its host. **This Mac as its host** on the Self host page turns **Online**, and the computer appears under **Settings → Hosts**. Start a session in your **Private** workspace, as in [Client](client.md#3-work-in-sessions).

Your Pikibun runs its own host for this computer. **Settings → This Mac** stays the host of whichever server it is paired with (your team's, say), so there's no need to pair This Mac with your Pikibun as well.

## Day to day

- **It runs while the app is open.** Quitting the app stops it. If it was running when you quit, it starts again at the next launch, and the app signs back in to it.
- **Stop** on the Self host page stops it. It won't start again at the next launch until you start it.
- **Switch to another server:** **Settings → Profile → Sign out**, then **Change** the server on the sign-in screen (see [Switching between modes](README.md#switching-between-modes)). Your Pikibun keeps running, and keeps its data, until you stop it.
- **Your data** (the database, session backups, the server's secrets and this computer's pairing with it) is in `~/.local/share/pikibun/server`, shown under **State directory**. It is the same state `pikibun serve` uses in a terminal, so a Pikibun you set up there carries over. Only one of the two runs at a time.
- **Recent activity** at the bottom of the page shows what the server did, and why it couldn't start.

## Sharing it with your team

The app runs your Pikibun for you alone. The same server, with the same data, can serve others too, from a terminal: stop it in the app, then run `npx pikibun@latest serve --share`. It needs a public HTTPS address served by a TLS proxy or tunnel you run (Tailscale Serve or Funnel, Cloudflare Tunnel, Caddy), administrators, and a GitHub OAuth app whose callback is on that address. See [Sharing it with others](../local.md#sharing-it-with-others).

Your teammates then use the app as [clients](client.md) of your server's public address, and can make their own computers [hosts](host.md) for it.
