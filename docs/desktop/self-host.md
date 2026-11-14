# Self host: run your own Pikibun on this computer

When you self host, all of Pikibun runs on this computer: the server, its data, and this computer as the host that runs your sessions. The app starts it, stops it and signs you in to it. You don't need an account at any Pikibun service, nor a GitHub account, and nothing is deployed anywhere.

Choose this mode when:

- you want Pikibun just for yourself, and your work shouldn't leave this computer, or
- you want to try a server of your own before running one for a team. The same server can later [serve a team](#sharing-it-with-your-team).

## Before you start

- **Node.js 24 or newer**, from [nodejs.org](https://nodejs.org) (on a Mac, `brew install node` also works). The app runs Pikibun's server with it.
- **Pi signed in to a model provider** on this computer, so that your sessions have models. If you don't use Pi yet, sign it in under **Settings → This Mac → Sign Pi in to a provider** once you're signed in, then stop and start your Pikibun so it offers the new models. Pi keeps the credential on this computer.

## A fresh install does this for you

The first time the app opens, it starts your own Pikibun on this computer and signs you in to it: steps 1 to 3 below happen on their own. It asks about [running unsandboxed](#2-start-pikibun) first where this computer has no sandbox, and where Pikibun's command isn't installed yet, **Set up Pikibun on this Mac** opens the Self host page to install it. To use a server someone else runs instead, choose **Sign in to another server** on that first screen and open or paste that server's sign-in link: the app remembers a server once you sign in to it, and opens its sign-in screen from then on (see [Client](client.md)).

Once signed in, the server button at the bottom of the sidebar switches between your Pikibun and the other servers the app is signed in to: **Pikibun on this Mac** there starts it if it isn't running.

## 1. Open Self host

- **Signed out** of a server you chose earlier: on the sign-in screen, choose **Run Pikibun on this Mac** (**this computer** on Windows and Linux).
- **Signed in** to another server: open **Settings → Self host**, or choose **Pikibun on this Mac** in the sidebar's server switch, which starts it and signs you in in one step.

The first two open the same page. If **Install Pikibun's command** appears, choose **Install pikibun**: npm installs it into the app's own folder in about a minute, with no `sudo`. The app updates that copy itself the first time it starts after an update of the app, before your Pikibun starts again. When a `pikibun` you installed in a terminal is too old for the app, the page offers **Update pikibun** instead.

## 2. Start Pikibun

Choose **Start Pikibun**. Where this computer has no sandbox (macOS and Windows, or Linux without bubblewrap), the app first asks whether to **Run unsandboxed**: your sessions' commands then run as you, with access to your files and network. Read [Running without the sandbox](../hosts.md#running-without-the-sandbox) before you agree. If you cancel, nothing starts.

The badge turns **Running**, and the page shows your Pikibun's address, `http://127.0.0.1:7878`. It is reachable from this computer only.

## 3. Sign in to it

Choose **Sign in to it**:

- From the sign-in screen, the app signs you in to your Pikibun.
- From Settings, the app asks first, then switches to your Pikibun and stays signed in to the server you were using. Nothing moves: your sessions and workspaces there stay where they are, and **Settings → Profile → Servers** switches back.

There is nothing to type: each time your Pikibun starts, it makes a private sign-in token and tells only the app, which signs you in with it as your Pikibun's owner, the only account that can ever sign in to it. Your first sign-in makes that account, named after your user on this computer (`password:ada` for the user `ada`). Signed out later, the sign-in screen's **Sign in to Pikibun on this Mac** signs you back in.

Once you're signed in, this computer pairs itself with your Pikibun as its host. **This Mac as its host** on the Self host page turns **Online**, and the computer appears under **Settings → Hosts**. Start a session in your **Private** workspace, as in [Client](client.md#3-work-in-sessions).

Your Pikibun runs its own host for this computer. **Settings → This Mac** stays the host of the servers it is paired with (your team's, say), so there's no need to pair This Mac with your Pikibun as well.

### Repositories

Your Pikibun has no GitHub sign-in of its own (that takes a GitHub OAuth app), so your account reaches **github.com** with a personal access token: under **Settings → Profile → Connected accounts**, choose **Connect** on the GitHub row and paste one (classic with the `repo`, `workflow` and `read:user` scopes, or fine-grained with Metadata read and Contents, Pull requests, Issues and Workflows read and write on the repositories your sessions work on). Pikibun checks it with GitHub and keeps it encrypted on this computer; your sessions then bind and clone github.com repositories, open pull requests and use the GitHub tools as that account. Unlike a GitHub sign-in, the token isn't reset after a push with your account: it stays valid until it expires or you revoke it on GitHub, and **Disconnect** only removes it from your Pikibun. Every other Git provider, GitHub Enterprise Server included, connects with its own token on the same page (see [Repositories and Git accounts](../repositories.md)). If you set up your Pikibun before it signed in without GitHub, you keep the GitHub account you signed in with then, and its repositories, for as long as GitHub keeps its token; after that, **Replace token** takes a personal access token of the same GitHub account.

## Day to day

- **It runs while the app is open.** Quitting the app stops it. If it was running when you quit, it starts again at the next launch, and the app signs back in to it.
- **Stop** on the Self host page stops it. It won't start again at the next launch until you start it.
- **Switch to another server:** the server button at the bottom of the sidebar and **Settings → Profile → Servers** list the servers this app is signed in to: **Switch** changes to one, and **Add a server** signs in to another, without signing out of your Pikibun (see [Switching between servers](client.md#switching-between-servers)). Your Pikibun keeps running, and keeps its data, until you stop it.
- **Sign in another app on this computer:** **Settings → Profile → Signed-in apps → Sign in an app** makes a [sign-in code](../accounts.md#signing-in-an-app-with-a-code), with nothing to type. Your Pikibun is reachable from this computer only, so the code works for apps here, not on your phone; for other devices, [share it](#sharing-it-with-your-team).
- **Your data** (the database, session backups, the server's secrets and this computer's pairing with it) is in `~/.local/share/pikibun/server`, shown under **State directory**. It is the same state `pikibun serve` uses in a terminal, so a Pikibun you set up there carries over. Only one of the two runs at a time.
- **Recent activity** at the bottom of the page shows what the server did, and why it couldn't start.

## Sharing it with your team

The app runs your Pikibun for you alone. The same server, with the same data, can serve others too, from a terminal: stop it in the app, then run `npx pikibun@latest serve --share`. It needs a public HTTPS address served by a TLS proxy or tunnel you run (Tailscale Serve or Funnel, Cloudflare Tunnel, Caddy), administrators (list yourself, `password:ada`, and give yourself a password with `--create-admin ada`), and a way for others to sign in: usernames and passwords, or a GitHub OAuth app whose callback is on that address. See [Sharing it with others](../local.md#sharing-it-with-others).

Your teammates then use the app as [clients](client.md) of your server's public address, and can make their own computers [hosts](host.md) for it.
