# Host: run sessions on this computer

As a host, this computer runs Pikibun sessions with the models Pi is signed in to here. You keep using the app as a [client](client.md) at the same time. The app makes this computer one of your hosts on a Pikibun server you're signed in to, and does what `pikibun connect` does in a terminal.

One computer can run several hosts: one for each server you use, or more than one for the same server with different settings. On Windows, for example, one host can run its sessions in Windows' own sandbox and another in WSL2, both for `pikibun.com`. Each host has its own pairing, sandbox and models, and appears as a host of its own on its server.

Choose this mode when:

- you want your sessions to run on this computer, with your own model subscription or API keys, or
- you want teammates to use your subscription without seeing your credentials: share this host with their workspace.

Your provider's credentials stay in Pi on this computer. Pikibun never receives them.

## Before you start

- **Sign in** to the server you want to host for (see [Client](client.md)). You can add hosts for any server the app is signed in to, without switching to it.
- **Node.js 24 or newer**, from [nodejs.org](https://nodejs.org) (on a Mac, `brew install node` also works). The app runs the `pikibun` command with it. For a host in WSL2, Node.js 24 inside the WSL distribution.
- You don't need to install Pi separately. The app signs Pi in to your provider for you.

## 1. Open Local hosts

Settings come in two sets: the ones of the server you're signed in to (Profile, Notifications, Hosts, Workspaces…), under its address, and the ones of this computer, under **This Mac** (**This Computer** on Windows and Linux). Open **Settings → This Mac → Local hosts**. The page checks this computer, then lists its hosts, or offers to add the first.

If **Install Pikibun's command** appears, choose **Install pikibun**. npm installs the version of `pikibun` released with this version of the app into the app's own folder, in about a minute: no `sudo` and no PATH change. Its progress appears under **Recent activity** at the bottom of the page. If that fails, the page shows a command to run in a terminal instead (`npm install -g pikibun@latest`); run it, then choose **Refresh**.

The app keeps that copy current: the first time it starts after an update of the app, it installs the `pikibun` released with the new version from npm before any host starts again, which takes about a minute. It installs that exact version, the latest `cli-v` release when the app was released, never whatever npm calls latest at the time, so nobody who could move npm's `latest` tag changes what runs on your computer without a release of the app. If that fails (no network, say), the hosts start with the command they have, **Recent activity** says why, and the app tries again the next time it opens. A `pikibun` you installed in a terminal is yours to update (`npm install -g pikibun@latest`); when it is too old for the app, the same place offers **Update pikibun**. Stop the hosts that run there first: the app never replaces the command under a running host.

## 2. Add a host

Under **Add a host** (or **Add a host** beside **Hosts on this Mac**, once there is one):

- **Pikibun server**: where the host runs sessions. It lists the servers the app is signed in to, the one you're on first.
- **Host name**: how the server lists it, such as *My Mac*.
- **Sandbox**: how its sessions are isolated:
  - **macOS:** **No sandbox** (sessions run directly as you) or **macOS sandbox** (experimental; needs macOS 15 or later and the developer tools, `xcode-select --install`).
  - **Windows:** **Windows sandbox** (Windows' own, experimental, where this computer meets its requirements, which **Prerequisites** lists) or **WSL2** (WSL2's bubblewrap sandbox, with the **WSL distribution** you choose, or WSL's default). See [WSL2](#wsl2) below.
  - **Linux:** the bubblewrap sandbox once it is installed, along with Python 3, Git and `flock`.

The form says how sessions would run, and lists the **Prerequisites** with the command that installs each missing item. Without a sandbox, the app asks first: **Run unsandboxed** lets the agent's commands run as you, with access to your files, credentials and network. Read [Running without the sandbox](../hosts.md#running-without-the-sandbox) before you agree.

Choose **Pair host**. There's no code to copy: the app creates the pairing on that server and hands it to the host in one step. The host appears under **Hosts on this Mac**, its badge goes from **Connecting** to **Online**, and it appears under that server's **Settings → Hosts**.

If Pi has no model yet, the form says so and shows **Sign Pi in to a provider** below it: see step 3.

## 3. Sign Pi in to a provider

On a host's page (the arrow at the end of its row), under **Sign Pi in to a provider**, choose the **Provider**, and **How** where it offers a choice (a subscription or an API key), then **Sign in**. Pi's own sign-in runs where the host runs:

- for a subscription, its page opens in your browser, or the app shows a code to enter on that page;
- for an API key, the app asks for it.

When it's done, the page says *Pi is signed in to …* and the provider's models are listed under **Models offered**. If you already use Pi in a terminal, it's signed in already, and its models are listed without this step.

Pi's sign-in belongs to where it runs, not to one host: every host that runs on this computer shares it, and every host in the same WSL distribution shares that distribution's.

## 4. Choose the models to offer

Each host offers its own models. By default Pi chooses: its `enabledModels` setting, or every model it is signed in to. To offer fewer, uncheck the ones to leave out on the host's page and choose **Offer checked models**. **Let Pi choose** goes back to Pi's choice. Changes apply from the host's next start.

## 5. Start and stop

**Start** and **Stop** on a host's row, or **Start host** and **Stop host** on its page, turn it on and off. The pairing is kept, so you don't need to pair again. Each host runs on its own: stopping one leaves the others as they are.

On a Mac, a host's page also changes its sandbox between **No sandbox** and **macOS sandbox** while it is stopped. On Windows, a host stays in the sandbox it was added with: to run sessions in the other one, add another host.

## 6. Run sessions on it

- **Your own sessions:** in your **Private** workspace, a new session picks one of this computer's hosts for that server while it's online. There it runs [directly on the host](../hosts.md#sessions-on-the-host) by default, as you, with your files. To isolate a session, choose **Where it runs → Sandbox**. Pick another of your hosts, or one in other workspaces, under **Host**.
- **Teammates' sessions:** under the server's **Settings → Hosts →** this host **→ Sharing**, choose **Share** for a workspace (one with a bound repository). Its members can then pick your models, and their sessions run as them, not as you. As the host's operator, you can see the prompts and files of every session that runs on it. **Unshare** stops sharing at once. See [Sharing a host](../hosts.md#sharing-a-host).

## WSL2

On Windows, a host with the **WSL2** sandbox runs `pikibun host` inside a WSL distribution, as `pikibun connect` does in a WSL terminal, so its sessions run in WSL2's bubblewrap sandbox, with that distribution's Node.js, Pi sign-in and Git.

- **Set up WSL** first if you haven't: in PowerShell, `wsl --install`, restart if Windows asks, and open Ubuntu once to create your Linux user. Then install Node.js 24 there (for example with [nvm](https://github.com/nvm-sh/nvm): `nvm install 24`), and bubblewrap, Python 3, Git and util-linux (on Ubuntu: `sudo apt install bubblewrap python3 git util-linux`). The host's **Prerequisites** list what is still missing.
- **Install Pikibun's command in WSL**: where the distribution has no `pikibun`, the form and the host's page offer **Install pikibun**, which installs it with npm into `~/.local/share/pikibun/app-cli` inside WSL. The app updates that copy with the app, as it does its own.
- **Its state** (pairing and sessions) is inside WSL, under `~/.local/share/pikibun/hosts/`.

## Good to know

- **Hosting lasts while the app is open.** Quitting the app stops its hosts. Sessions that were working on them wait, and carry on when they start again. Each host that was running when you quit starts again at the next launch, with the consent you gave before. For a host that runs while you're signed out of your computer, use `pikibun connect` under a service manager instead (see [Hosts](../hosts.md#pairing)).
- **Sessions on this computer open from it.** The app reads a session that runs on one of this computer's hosts straight from that host, rather than through the server, and keeps showing it, read-only, while the server can't be reached. The server still checks every 30 seconds that you may read it, and sending a message still needs the server. See [the design](../design/local-views.md).
- **One pairing shared with the command line.** The first host on this computer uses the same state directory as `pikibun connect` (`~/.local/share/pikibun/connector`), so a computer you paired from a terminal shows up as a host here. Only one of the two runs at a time. Every other host has a folder of its own, `~/.local/share/pikibun/hosts/<id>` (hosts added for a second server before this version keep `~/.local/share/pikibun/servers/<server>`).
- **A private session whose host is offline** says so at the top. If it ran on one of this computer's hosts, **Start host** starts it. Otherwise **Connect This Mac** opens Local hosts to add one for that server; where this computer has several hosts for that server and the app can't tell which, **Local hosts** opens the list.
- **Removing a host:** **Remove this host** on its page stops it and forgets it here; the host stays in that server's **Settings → Hosts**, offline, until you remove it there, and its sessions' files stay in its folder. The host in `pikibun connect`'s state directory can't be removed here, only stopped.
- **When something goes wrong,** **Recent activity** on a host's page shows what it did, and **Refresh** checks again. The same section shows the host's **State directory** and the server it's **Paired with**.
