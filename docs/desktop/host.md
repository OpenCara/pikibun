# Host: run sessions on this computer

As a host, this computer runs Pikibun sessions with the models Pi is signed in to here. You keep using the app as a [client](client.md) at the same time. The app makes this computer one of your hosts on the server you're signed in to, and does what `pikibun connect` does in a terminal.

Choose this mode when:

- you want your sessions to run on this computer, with your own model subscription or API keys, or
- you want teammates to use your subscription without seeing your credentials: share this host with their workspace.

Your provider's credentials stay in Pi on this computer. Pikibun never receives them.

## Before you start

- **Sign in** to the server you want to host for (see [Client](client.md)).
- **Node.js 24 or newer**, from [nodejs.org](https://nodejs.org) (on a Mac, `brew install node` also works). The app runs the `pikibun` command with it.
- You don't need to install Pi separately. The app signs Pi in to your provider for you.

## 1. Open This Mac

Open **Settings → This Mac** (**This Computer** on Windows and Linux). The page checks this computer, then shows what to do next.

If **Install Pikibun's command** appears, choose **Install pikibun**. npm installs the version of `pikibun` released with this version of the app into the app's own folder, in about a minute: no `sudo` and no PATH change. Its progress appears under **Recent activity** at the bottom of the page. If that fails, the page shows a command to run in a terminal instead (`npm install -g pikibun@latest`); run it, then choose **Refresh**.

The app keeps that copy current: the first time it starts after an update of the app, it installs the `pikibun` released with the new version from npm before the host starts again, which takes about a minute. It installs that exact version, the latest `cli-v` release when the app was released, never whatever npm calls latest at the time, so nobody who could move npm's `latest` tag changes what runs on your computer without a release of the app. If that fails (no network, say), the host starts with the command it has, **Recent activity** says why, and the app tries again the next time it opens. A `pikibun` you installed in a terminal is yours to update (`npm install -g pikibun@latest`); when it is too old for the app, the same place offers **Update pikibun**.

## 2. Sign Pi in to a provider

Under **Sign Pi in to a provider**, choose the **Provider**, and **How** where it offers a choice (a subscription or an API key), then **Sign in**. Pi's own sign-in runs on this computer:

- for a subscription, its page opens in your browser, or the app shows a code to enter on that page;
- for an API key, the app asks for it.

When it's done, the page says *Pi is signed in to …* and the provider's models are listed under **Models offered**. If you already use Pi in a terminal, it's signed in already, and its models are listed without this step.

## 3. Choose the models to offer

By default Pi chooses: its `enabledModels` setting, or every model it is signed in to. To offer fewer, uncheck the ones to leave out and choose **Offer checked models**. **Let Pi choose** goes back to Pi's choice. Changes apply from the host's next start.

## 4. Choose how sessions are isolated

The **Prerequisites** section lists what this computer has and what it lacks, with the command that installs each missing item. Whether sessions run in a sandbox depends on the computer:

- **macOS:** under **Sandbox**, choose **None** (sessions run directly as you) or **macOS sandbox** (experimental; needs macOS 15 or later and the developer tools, `xcode-select --install`). Stop the host before you change this.
- **Linux:** sessions run in the bubblewrap sandbox once it is installed, along with Python 3, Git and `flock`.
- **Windows:** sessions use Windows' own sandbox where this computer meets its requirements, which **Prerequisites** lists. It's experimental (see [Experimental sandboxes](../hosts.md#experimental-sandboxes-on-macos-and-windows)).

Without a sandbox, the app asks first: **Run unsandboxed** lets the agent's commands run as you, with access to your files, credentials and network. Read [Running without the sandbox](../hosts.md#running-without-the-sandbox) before you agree.

## 5. Pair and start

Under **This Mac and** *your server*, enter a **Host name** (such as *My Mac*) and choose **Pair This Mac**. There's no code to copy: the app creates the pairing and hands it to the host in one step. The badge goes from **Connecting** to **Online**, and the computer appears under **Settings → Hosts**.

From then on, **Stop host** and **Start host** turn hosting off and on. The pairing is kept, so you don't need to pair again.

## 6. Run sessions on it

- **Your own sessions:** in your **Private** workspace, a new session picks this computer while it's online. There it runs [directly on the host](../hosts.md#sessions-on-the-host) by default, as you, with your files. To isolate a session, choose **Where it runs → Sandbox**. In other workspaces, pick it under **Host**.
- **Teammates' sessions:** under **Settings → Hosts →** this host **→ Sharing**, choose **Share** for a workspace (one with a bound repository). Its members can then pick your models, and their sessions run as them, not as you. As the host's operator, you can see the prompts and files of every session that runs on it. **Unshare** stops sharing at once. See [Sharing a host](../hosts.md#sharing-a-host).

## Good to know

- **Hosting lasts while the app is open.** Quitting the app stops the host. Sessions that were working on it wait, and carry on when it starts again. If it was running when you quit, it starts again at the next launch, with the consent you gave before. For a host that runs while you're signed out of your computer, use `pikibun connect` under a service manager instead (see [Hosts](../hosts.md#pairing)).
- **Sessions on this computer open from it.** The app reads a session that runs on this computer straight from its host, rather than through the server, and keeps showing it, read-only, while the server can't be reached. The server still checks every 30 seconds that you may read it, and sending a message still needs the server. See [the design](../design/local-views.md).
- **One pairing, shared with the command line.** The app uses the same pairing as `pikibun connect`, so a computer you paired from a terminal carries over. Only one of the two runs at a time.
- **One server at a time.** The host keeps running for the server it's paired with, even after you sign in to another server. To host for a different server, stop the host, sign in to that server, and pair again. This replaces the old pairing, and the old host stays offline on the previous server until you remove it there.
- **When something goes wrong,** **Recent activity** under **Host** shows what the host did, and **Refresh** checks the computer again. The same section shows the host's **State directory** and the server it's **Paired with**.
