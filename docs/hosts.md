# Hosts

A host is a machine where you run the `pikibun` connector next to [Pi](https://github.com/earendil-works/pi). Sessions on it use the models and credentials configured in Pi there (by default in `~/.pi/agent`); provider credentials, Pi history and personal extensions are never uploaded.

**Requirements:** Linux or WSL2 with Node.js 24 or newer, Pi configured with the providers and models to offer, and `bubblewrap`, Python 3, Git and `flock` (util-linux) for the sandbox. On Windows, run the connector inside WSL2 for that sandbox. macOS and native Windows can also try their own [experimental sandboxes](#experimental-sandboxes-on-macos-and-windows), and macOS, native Windows or Linux without bubblewrap can run [without the sandbox](#running-without-the-sandbox).

On a Mac, Windows or Linux desktop, the [app](apps.md)'s **This Mac** (This Computer elsewhere) lists what is missing with the command that installs it, and signs Pi in to your provider in its own window.

## Pairing

1. In **Settings → Hosts**, choose **Pair a host**, enter a **Host name**, then **Create pairing code**. A pairing names no workspace: the host is yours, and you can use it in every workspace you belong to, including ones you create or join later.
2. On the host, run the command shown under **Run this on your host**:

   ```sh
   npx pikibun@latest connect --server https://pikibun.example.com --pairing-id PAIRING_ID
   ```

3. Paste the code at the hidden prompt. It is never accepted as an argument, works once and expires after 10 minutes.

Each person can hold at most five unexpired pairing codes and 20 active hosts. The connector saves its token in `~/.local/share/pikibun/connector` (`--state-dir` chooses another directory), so later runs need no arguments:

```sh
npx pikibun@latest connect
```

Keep it running, for example in `tmux` or under your service manager: it reconnects by itself after network failures, without interrupting the sessions at work on the host, and sessions on the host work only while it runs. When it starts again, sessions that were at work when it stopped carry on without waiting for someone to open them. Restart it after changing Pi's configuration, and run it with `@latest` to update it; newer features need a newer connector, and the web app says when a host's is too old. The host's page (**Settings → Hosts →** the host) shows, under **Connector**, the version its connector reported when it last connected (`desktop 0.9.0` for the former Electron app's); the server's own version is at the foot of **Settings**. The connector and the server are released separately, so their numbers needn't match. Connectors from 0.23 and older report none. A connector reports the code it is running, not what is installed: after `@latest` installs a newer one, restart it.

To pair a machine again (after revoking its host, or to move it to another server), create a new code and add `--force` to its command. The saved token is replaced only once the new code is accepted; the old host stays in **Settings → Hosts**, offline, until you revoke it, and its sessions don't move. Use a separate `--state-dir` to run a second connection on the same machine.

An offline host's page in **Settings → Hosts** has **Reconnect**, which shows the command to restart its saved connection on that machine (Pikibun can't start it remotely), or **Pair again** once it's revoked. **Remove permanently** (owner only) takes a host off the list for good: it revokes its credentials, stops sharing it, and marks its models unavailable. Its sessions and their history stay, but can't run again, and nothing on the machine is deleted; pair it as a new host to use it again.

> **Upgrading to connector 0.8.0:** it keeps its state in `~/.local/share/pikibun/connector` instead of `~/.local/share/opencara/connector`, without moving anything. To keep a pairing made by an older connector, run `npx pikibun@latest connect --state-dir ~/.local/share/opencara/connector`, or pair the machine again.

## Models

A host offers the models matched by `enabledModels` in Pi's `settings.json` (the same patterns Pi uses for model cycling, such as `"anthropic/*"`), or every authenticated Pi model when that list is unset; `--model PROVIDER/MODEL` (repeatable) overrides both. A host offers at most 200 models. Each model starts at the reasoning level Pi gives it; see [Chat options](sessions.md#chat-options).

The host's owner and its [admins](#host-admins-and-host-command-grants) can also turn models off without touching the machine: under **Settings → Hosts →** the host **→ Models**, clear a model's **Enabled** box. Disabling a model applies to everyone who uses the host, the owner included, in every workspace, and takes effect at once:

- It leaves every model picker, and no session starts from it or moves onto it. Only the host's **Models** section still lists it, to its owner and admins.
- No message switches to it. Sessions already on it keep their history and continue on another model; while the host has a disabled model, each message names the model it runs on, as the apps always do (scheduled prompts and messages between sessions name the conversation's current model), so a conversation still on a disabled model asks you to choose another.
- A message already running on it when it is disabled runs to its end.

The setting stays with the host until someone enables the model again, even if Pi on the host stops offering the model for a while. Disabling a model doesn't change Pi's own configuration on the host.

Sessions on a host also follow two more of its Pi settings:

- **Compaction**: `compaction` (`enabled`, `reserveTokens`, `keepRecentTokens`) decides when a long conversation is summarized, and `compaction.modelOverrides` sets the token values per exact `provider/modelId`, so a session that switches between a small-window and a large-window model compacts in time for each. Pi's defaults apply where these are unset, with one exception: a reasoning model keeps a tenth of its context window, between 16K and 64K tokens, as `reserveTokens` instead of Pi's 16K. Pi summarizes at the conversation's reasoning level within 80% of `reserveTokens`, so at 16K a model thinking at a high level can spend the whole budget thinking, and once the context is past the threshold every message fails the same compaction. Set `reserveTokens` (overall or for the model) to use another value.

  The host's owner and its admins can also set these token counts in Pikibun, without touching the machine: under **Settings → Hosts →** the host **→ Compaction**, enter **Reserve** and **Keep recent** tokens for all models, or for single models under **Per model**. Each count set there replaces the one in the host's `settings.json`; an empty one keeps it. Sessions pick up a change within a minute, from their next message, without restarting the connector. This needs a connector from this release or later.
- **Provider attribution**: with Pi's `enableInstallTelemetry` set to `false` (or `PI_TELEMETRY=0`), sessions' model requests carry no attribution headers to pi, as Pi's own don't.

The connector reads these when it starts; restart it after changing them.

## Sharing a host

A paired host is private: only you can start sessions on it, in any of your workspaces. Under **Settings → Hosts →** the host **→ Sharing**, **Share** it with a workspace you belong to (one with a bound repository) to let its members run their own sessions on it; **Unshare** stops that at once.

This is how a team shares one model subscription or set of API keys. Sign Pi in once on one machine and share that machine, and everyone in the workspace can pick its models when they start a session. The provider's credentials stay on that machine, and teammates never see or copy them. Revoking the host or unsharing it cuts everyone off at once. Check that your provider's terms allow sharing your plan this way.

- Sessions on a shared host still belong to the members who start them: they run as those members, with their Git accounts, not yours. Agents, session permissions and Git credentials are not shared, and your Pi history is never imported.
- As the host's operator, you can see the prompts and repository files of every session that runs on it. Members starting a session on someone else's host confirm they trust it (**I trust …'s host**).
- **Settings → Hosts → Shared with you** lists the hosts others shared into your workspaces.
- To guard what lies on your machine from members' messages, require the [prompt audit](extensions.md#prompt-audit-pikiprompt-audit) of every session on it: a model on the host checks each of their messages before it reaches the agent. You can require any extension of every session on your host the same way, such as a tool-call guard ([required extensions](extensions.md)).

The host's page shows its **Status** (online or offline, owner, capabilities), **Models** (where its owner and admins [enable or disable](#models) each one), **Sharing**, **[Configuration](#host-configuration)**, **Host command access**, **Admins**, **Details** (the connection ID) and **Danger zone**. **Revoke host** disconnects it and blocks work in every workspace, your own sessions included; session records are kept, and the machine needs a new pairing to come back.

## Host admins and host command grants

By default only a host's owner manages its sharing and models and decides its host commands (its extensions' tools, and the commands of sessions that run on it), which run outside the sandbox on their machine. The owner can hand some of that out on the host's page:

- **Admins**: **Add admin** makes another member of a workspace the host is connected to an admin. Admins share and unshare the host, in workspaces they and the owner both belong to, give or remove host command grants, and [enable or disable its models](#models) for everyone who uses it, but hold no host command access themselves unless a grant gives it to them. Only the owner adds or removes admins, reconnects, revokes or removes the host; an admin can **Step down**.
- **Host command access**: in a workspace the host is shared with, grant one member or **All members** either **Approve host commands** (they decide each host command in sessions they can approve) or **Auto-approve host commands** (their own **Auto-approve** messages also run host commands without asking). On a host without [resource limits](#the-sandbox), either level also lets the member's own sandboxed sessions run shell commands there, decided like host commands. The owner (not an admin) can also tick **Sessions on the host**, so the member may start their own [sessions directly on the host](#sessions-on-the-host); an admin can take that away, and changing a grant's level keeps it. A grant can expire after a day, a week or a month, or never. It ends when it expires, when an owner or admin removes it, or when the host stops being shared there. Viewers can't hold one.

The host asks the control plane who holds which grant each time a host command is created, decided or run, so a grant that ends stops working at the next command. Grants need a connector advertising `hostGrants`; until it is updated, only the owner decides host commands. Sessions on the host for members need one advertising `hostSessionGrants`; until then, only the owner's run there. Members' sandboxed commands on a host without resource limits need one advertising `unboundedShellGrants`; until then, they are refused. Every admin, grant and model change is recorded in the audit log.

## Host configuration

How a host runs its sessions is set on its page, under **Configuration**, rather than with connector options (connector newer than 0.9.0):

| Setting | Effect | Changed by |
|---|---|---|
| **Command time limit** | How long a shell command may run before it is stopped, from 30 seconds (the default) to an hour. A longer limit also lifts the per-process limits of short commands (25 seconds of CPU, 64 MiB per file, 256 open files) so builds fit: each process may use every CPU for the whole limit, write files of up to 16 GiB and open 8192 files | Owner and admins |
| **GPU** | Sandboxed commands get the host's GPU render device for rendering and compute: `/dev/dxg` on WSL2, or Linux DRM render nodes with their sysfs entries. Never the screen, windows, input or display (`card`) nodes, so the agent renders offscreen, for example to image files it reads back. Offered only where the connector found such a device. On WSL2, Mesa's `vulkan-dzn` on the host gives Vulkan over the Windows driver | Owner and admins |
| **Git credentials** | Pushes in the owner's own sessions may use the credentials Git on the host would use (see [push access](pushes.md#push-access)) | Owner |
| **Repository cache** | Off, or a full mirror of each repository on the host for every session (**Shared**) or one per session owner (**Per owner**), filled with the host's own Git credentials; see [Repository cache](#repository-cache-preview) | Owner |
| **Sessions on the host** | The owner, and members they [grant](#host-admins-and-host-command-grants) it, may start sessions that run directly on the host, without the sandbox; see [Sessions on the host](#sessions-on-the-host) | Owner |
| **Service lifetime** | The longest a session service runs, from 5 minutes to a day, 4 hours by default: a server a session keeps running in its sandbox after the call that started it, such as the one the [tunnel tool](extensions.md#the-tunnel-pikitunnel) puts online. It stops then, and goes offline. It runs with the per-process limits of a command as long as the lifetime, and, with provisioned resource limits, within the same limits as the session's commands, in a resource domain of its own | Owner and admins |

Running sessions pick up a change within a minute, and the agent finds the time limit and GPU in `identity` (`commands`); a repository cache change applies when the connector next connects. Saving changes only the settings you changed, so it never undoes one someone else saved meanwhile. Turning on Git credentials, the cache or the GPU asks first, and every change is recorded in the audit log (`host.config.updated`).

- A command approved by hand no longer holds the approval until it ends: its card shows it running and settles with its outcome, as host commands do. Stopping the message, or the session closing, stops a running command.
- Without provisioned resource limits (`--resources`), a command can use the whole machine for its time limit.
- A host started with `--git-credentials` or `--repo-cache` keeps those settings here; current connectors ignore the options. A connector that predates host configuration keeps its options until it is updated, and the page says so.

## Sessions on the host

A sandboxed host can also run some sessions directly on the machine, for work the sandbox doesn't allow: an app or game that opens windows or uses the GPU and the machine's drivers as installed, or tools and SDKs the sandbox can't see. Turn on **Sessions on the host** in the host's [configuration](#host-configuration) (owner only; it asks first), then choose **Where it runs → On this host** when you start a session on it. To let another member do the same, include **Sessions on the host** in their [host command grant](#host-admins-and-host-command-grants). Each session keeps the choice it started with; restored and moved copies start in the sandbox.

Such a session runs like one on an [unsandboxed host](#running-without-the-sandbox): commands run as the connector's OS user, in the session's own folder, with the host owner's files, credentials and network and no resource limits, and the workspace's network access doesn't apply. They start with the connector's `PATH`, the session's own `HOME` and no display: set `DISPLAY` to open windows (for example `DISPLAY=:0` under WSLg). The host's command time limit still applies. Clones use the host's own Git and credentials, so push with `git` itself rather than `git_push`. In addition:

- Only the host's owner starts one, or a member whose grant in the session's workspace includes **Sessions on the host**; other members always get the sandbox. The session owner is still whoever started it.
- Its commands are decided like [host commands](host-commands.md): only by the host's owner, or a member they granted host commands (a member running their own session there holds a grant, so they can decide its commands). Approve permission on the session isn't enough. Under **Auto-approve**, its commands run without asking only for the host's owner or a member holding **Auto-approve host commands**; otherwise each one asks.
- Turning **Sessions on the host** off stops the next command of every such session (within half a minute) before it runs; nothing else of theirs changes. So does a member's grant ending or no longer including sessions on the host, for their sessions.
- Pushes with the [host's Git credentials](pushes.md#push-access) stay the owner's alone; a member's clones still use Git on the host, with whatever credential helpers it has set up.
- Everyone who can see the session is warned that it runs without a sandbox (**Runs on the host**).

## The sandbox

With bubblewrap, every session runs in its own sandbox: no direct network (see [Network access](#network-access)), read-only system directories, and only the session's own worktree writable. Commands in it stop after the host's [command time limit](#host-configuration), 30 seconds unless its owner or an admin sets a longer one. Git there runs without hooks, stored credentials or SSH: an approved push gets a credential for that push alone (see [Commits, pushes and pull requests](pushes.md)), and GitHub actions go through Pikibun.

Commands (`git`, `node`, `python`) also need resource limits. A connector started with `--resources PATH` (an operator-provisioned cgroup v2 configuration: CPU, memory, process and disk limits, described in [`apps/runner/src/resources.ts`](../apps/runner/src/resources.ts)) runs them in every session. Without it, the host's owner can let commands run without limits in their own sessions, through a [permission request](approvals.md#permission-requests). So can a member they [granted host commands](#host-admins-and-host-command-grants) there, in their own sessions, since that grant already lets them run any command on the host itself. Their commands still run in the sandbox, as the session's owner, but are decided like host commands: only by the host's owner or a member granted host commands, either with approve permission on the session. Under the session owner's **Auto-approve** they run without asking only with **Auto-approve host commands**, and once the grant ends, the next command is refused. In every other member's session on that host, commands are refused.

### A browser for sessions

The agent's [browser tool](extensions.md#the-browser-pikibrowser) runs a headless Chromium in the session's sandbox: the host's, since sessions download nothing. Its owner chooses where it comes from on the host's page, under **Extensions** → `piki:browser`, which also shows how it stands (**Ready**, **No Chromium**, **Downloading**, **Download failed**, **Off**), the executable sessions run and, when there is one, what went wrong:

- **Find it** (the default). The connector looks on the host: `PIKIBUN_BROWSER`, the path of a Chromium executable (Chromium, Google Chrome, Microsoft Edge, or Chrome for Testing's `chrome-headless-shell`) set in the connector's environment, which is that one or none; else a system install, such as Debian's and Fedora's `chromium` packages (`sudo apt install chromium`; Ubuntu's is a snap, which can't run in another sandbox), or Google Chrome or Microsoft Edge in `/opt`; else the newest one Playwright or Puppeteer downloaded for the connector's user (`npx playwright install chromium-headless-shell`, `npx @puppeteer/browsers install chrome-headless-shell@stable`); else one the connector downloaded before.
- **This path.** The Chromium executable you name, and no other: the program itself, beside Chromium's own files (`/usr/lib/chromium/chromium`, not the `/usr/bin/chromium` script). One that isn't an installation leaves the host without a browser, and its page says why.
- **Download.** The connector downloads Chrome for Testing's headless shell, the build Google publishes for automation (about 110 MB, 240 MB unpacked), into its own folder (`browser/` in its state directory), and checks once a day for a newer Stable to replace it with. Sessions switch to a new one once it is in place; the one it replaced stays for a day, while commands that started with it may still run it. It fetches the current version from `googlechromelabs.github.io` and the build from `storage.googleapis.com`, which a host behind a firewall must reach (behind a proxy, run the connector with `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY`). A failed download is tried again ten minutes later. Chrome for Testing builds for Linux on x86-64 only: on ARM, install your distribution's `chromium` and find it. The headless shell, like any Chromium, needs the system libraries it links (`libnss3`, `libgbm1`, `libasound2` and others), which desktop distributions have and minimal servers may not (`sudo apt install chromium` pulls them in).

Only you see the executable's path and what went wrong; the host's admins and its workspaces see how it stands.
- **Off.** Sessions on the host get no browser.

The connector applies a change, an install or a finished download within a minute, without a restart, and open sessions get the tool at their next message. Only that browser's own installation directory is given to sandboxed commands, read-only (at `/opt/pikibun/chromium`), and only where they don't already see it under `/usr`. It runs with `python3` from `/usr`, as the sandbox's helper does, and the system's fonts. Sessions without the Linux sandbox are never offered the tool: the browser never runs on the host itself, as its user.

### Tunnels for sessions

The agent's [tunnel tool](extensions.md#the-tunnel-pikitunnel) puts a session's web server online through a Cloudflare quick tunnel. The server runs in the session's sandbox; `cloudflared` runs in the connector, on the host, as the connector's OS user, since it must reach Cloudflare's edge on port 7844 (UDP or TCP), which no session's proxy tunnels (see [the design](design/egress.md#tunnels-stay-out-of-the-sandbox)). Its owner chooses where it comes from on the host's page, under **Extensions** → `piki:tunnel`, which shows how it stands as the browser's does (**Ready**, **No cloudflared**, **Downloading**, **Download failed**, **Off**):

- **Find it** (the default). `PIKIBUN_CLOUDFLARED`, the path of a cloudflared executable set in the connector's environment, which is that one or none; else `cloudflared` on the connector's `PATH`, in `/usr/local/bin` or `/usr/bin` (Cloudflare's packages, `sudo apt install cloudflared` from its repository), or Homebrew's; else one the connector downloaded before.
- **This path.** The cloudflared executable you name, and no other.
- **Download.** The connector downloads Cloudflare's latest release for the host (`cloudflared-linux-amd64` or `-arm64`, about 40 MB) from `github.com/cloudflare/cloudflared` into its own folder (`cloudflared/` in its state directory), checks it against the SHA-256 its release notes list, and checks once a day for a newer one. A host behind a firewall must reach `api.github.com` and `github.com` for it. A failed download is tried again ten minutes later.
- **Off.** Sessions on the host put nothing online, whatever their workspace chose. A tunnel online when you turn it off stays until it stops.

Each tunnel is one `cloudflared tunnel --url http://127.0.0.1:<port>` process, with an empty configuration (so neither `~/.cloudflared` nor `/etc/cloudflared` applies), a home of its own in the connector's state, and nothing of the connector's environment but its `PATH` and certificate settings. The port is the connector's, on the host's loopback: it forwards each connection to the Unix socket the session's service listens on, taken by a hard link into a directory of the connector's own so that nothing the session puts in its place is followed, and so to the declared port in the sandbox and nothing else. The host needs to reach `api.trycloudflare.com` on 443 and Cloudflare's edge on 7844; cloudflared's errors go to the connector's log, and a session's agent is told only that it got no address. A connector that stopped without ending its cloudflareds ends them as it starts again.

Each start is decided like a host command, by you or a member you granted host commands: it publishes from your machine's network. The server keeps running for the host's **Service lifetime** at most (see [Host configuration](#host-configuration)).

A session whose workspace has the browser on, on a host that has no Chromium for it, says so as it starts: a warning above its chat box, for whoever can write in it, and a row in the panel's **Extensions** section. Its agent is told too, so it says so rather than trying. Viewers of a session only learn why (no Chromium, downloading, download failed, turned off, no Linux sandbox), never the host's paths or errors.

## Network access

A sandbox's only way out is its session's **egress proxy**, which the connector runs on the host. Shell commands find it through `HTTPS_PROXY` (`http://127.0.0.1:41080` in the Linux sandbox; in the [experimental macOS and Windows sandboxes](#experimental-sandboxes-on-macos-and-windows), the session's own loopback port and credentials); file tools, commits and every other sandboxed step have no network at all.

- **Git reads of the workspace's repositories always work.** Git in the sandbox sends `https://` remotes, and SSH remotes of github.com, gitlab.com and bitbucket.org, to the proxy, so `git clone https://github.com/acme/app` or `git fetch` work as usual. For each request the proxy asks Pikibun, which checks the session and the **session owner's own access** to the repository; the sandbox never holds a credential. On a host with a [repository cache](#repository-cache-preview), clones borrow the host's copy, so only what it lacks is fetched.
- **In a session that clones on demand, pushes of the session's own branch work too:** `git push origin HEAD:$PIKIBUN_SESSION_BRANCH` (the branch, such as `pikibun/add-dark-mode-1a2b3c4d5e6f`, is in `$PIKIBUN_SESSION_BRANCH`). They are pushed with the workspace's [push identity](pushes.md#push-access). A push of any other branch is rejected, as a Git host rejects one, and goes through `git_push` instead (see [Commits, pushes and pull requests](pushes.md)). Pinned sessions push only with `git_push`.
- **Where Git's data goes.** So that clones, fetches and pushes don't all go through the server, the host's proxy fetches from the Git host itself when Pikibun gives it a credential for that repository; otherwise Pikibun relays the request with a credential that never leaves the server:

  | Request | Any host | The session owner's own host |
  |---|---|---|
  | Read a public repository, or download its Git LFS files | Direct, without a credential | Direct, without a credential |
  | Read a private repository, or download its LFS files | Direct, with a token that can only read that repository, where a GitHub App serves it (the workspace's under **Push access**, or the server's for github.com); relayed otherwise | Direct, with that token or else the owner's own account (also on the server's own runner) |
  | Push the session branch | Relayed: a push token can't be limited to one branch | Direct, with the workspace's push identity, except the owner's GitHub sign-in account and the host's Git credentials, which stay relayed |

  Pikibun checks the session's authority for each grant, as for a relayed request, and a host reuses a read grant for a minute at most. A host that can't reach the Git host itself falls back to the relay. The server's operator chooses with `GIT_DIRECT` (see [Configuration](self-hosting.md#configuration)): `own-hosts` gives tokens only to session owners' own hosts, and `off` relays everything.
- **In a session that clones on demand, `gh` and other GitHub API clients read the workspace's github.com repositories**, whatever the workspace's network access: `gh run view --log-failed`, `gh pr view`, `gh api repos/acme/app/actions/runs`. The sandbox holds no GitHub credential: `GH_TOKEN` and `GITHUB_TOKEN` hold a placeholder, and the session's proxy answers HTTPS to `api.github.com` itself and adds the credential there. That is a token of a GitHub App (the workspace's under **Push access**, or the server's on github.com), which needs to be installed on the repositories. It can only read the workspace's github.com repositories that the session owner can read, and only what `gh` reads: code, issues, pull requests, Actions runs and logs, checks, statuses, deployments, discussions and Pages. It is never the owner's own sign-in token. Pikibun checks the session for each token, as for Git, and the proxy reuses one for a minute at most. `glab` on gitlab.com and `az devops` on dev.azure.com work the same way, with `GITLAB_TOKEN` and `AZURE_DEVOPS_EXT_PAT`, but only on the session owner's own hosts: there the proxy adds the owner's own access token for that forge, which can't be limited to the workspace's repositories.
  - **Only reads.** The proxy refuses every other method and GraphQL mutations; comments, issues, merges and pushes go through `github_comment`, `github_issue`, `github_merge` and `git_push`, with their approvals. The token couldn't make them anyway. The one exception is a call of a [command-line tool extension](extensions.md#pikibuns-built-in-extensions-gh-glab-and-az) (`piki:gh`, …) that a person approved, on the session owner's own host: while it runs, its requests go with the owner's own sign-in, so they can write.
  - **Other repositories** are read without a credential, and only where the workspace's network access allows `api.github.com`. So is a request that carries a token of its own instead of the placeholder.
  - **Downloads** that GitHub redirects to its storage (Actions logs and artifacts, release assets, archives) are fetched by the proxy, without the credential.
  - **How the proxy can see these requests:** the connector makes a certificate authority in memory when it starts, and adds it to each session's certificates. It can vouch only for `api.github.com`, `gitlab.com` and `dev.azure.com`, by a name constraint that OpenSSL, Go, Node.js and Python check; HTTPS to every other host stays a tunnel the proxy never looks inside. In the [experimental macOS and Windows sandboxes](#experimental-sandboxes-on-macos-and-windows), Go programs such as `gh` check certificates only against the system's own store, so they can't verify it there yet; curl, Node.js and Python can.

  The server's operator chooses with `SANDBOX_GITHUB_API`: `own-hosts` gives these tokens only to session owners' own hosts, and `off` gives none, so sessions reach `api.github.com` (and `gitlab.com`, `dev.azure.com`) only as the network access allows, without a credential. Pinned sessions get none.
- **Everything else follows the workspace's network access**, under **Settings → Workspaces →** the workspace **→ Network access** (owners and admins):

  | Access | HTTPS reaches |
  |---|---|
  | **Off** (default) | Nothing besides the workspace's repositories |
  | **Allowlist** | The listed domains (`*.example.com` for subdomains), and, with **Allow package registries**, npm, PyPI, crates.io, Go modules, RubyGems, Maven, NuGet and Packagist |
  | **Open** | Any public host |

  Other repositories on an allowed host are fetched without credentials. Only HTTPS on port 443 is tunnelled, the proxy never looks inside it, and addresses in the host's own networks (loopback, private, link-local, such as cloud metadata services) are never reachable. Running sessions pick up a change within a minute.

  Shell commands verify these hosts against the certificates the **host** trusts (its system store, or Node.js's bundled one where it has none, plus the connector's `NODE_EXTRA_CA_CERTS`): the connector copies them into the session when it opens, and the sandbox sees them read-only at `/etc/ssl/certs/ca-certificates.crt`, which `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` name. Nothing else of the host's `/etc` is visible. A certificate added on the host reaches a session the next time it opens.

- **Web search and page reading** come from the workspace's extensions (see [the design](design/host-extensions.md)): Pi extensions that run on the host, outside the sandbox, so this network access doesn't confine them. Pikibun's own `web_fetch` and `web_search` tools are retired; a host whose connector still carries them gets neither, and the server's `WEB_SEARCH` setting is no longer read.

`curl -s "$PIKIBUN_EGRESS_STATUS"` in a session shows its current access, the workspace's repositories, the APIs its proxy answers itself and its recent decisions, with `(direct …)` on the Git requests the host made itself and each GitHub API request with the credential it was made with. A session on a connector that predates the proxy keeps having no network; update the connector to use it.

## Experimental sandboxes on macOS and Windows

macOS and native Windows can run sessions in their own operating system's sandbox instead of bubblewrap. Both are **experimental and not yet verified on real machines**: report what breaks. The design and what still has to be checked are in [docs/design/windows-sandbox.md](design/windows-sandbox.md).

```sh
npx pikibun@latest connect --experimental-sandbox
```

In the Mac app, choose **macOS sandbox** under **This Mac**, while the host is stopped.

- **macOS** (Seatbelt, macOS 15 or later, with the developer tools: `xcode-select --install`): every step runs under `sandbox-exec` with a profile that denies everything by default. A session sees its own files, the system's read-only runtime, the developer tools and Homebrew, and nothing of your home folder or other sessions. Its only network is its egress proxy, on a loopback port that wants the session's credentials, so tests that start a local server can't reach it, and Go and Swift programs can't verify HTTPS (they check certificates only through a macOS service that would fetch on the host's own network, outside the proxy; curl, Git, Node and Python work). macOS has no hard memory or process limits for a group of processes, so, as on a Linux host without `--resources`, shell commands run only in the host owner's own sessions, once they allow it.
- **Windows** (Windows 11 24H2 or later with the October 2026 update, which the connector checks by running one container, [Git for Windows](https://git-scm.com/download/win), and Microsoft's [MXC SDK](https://github.com/microsoft/mxc), which the connector tells you how to install: `npm install --prefix <state dir>\mxc @microsoft/mxc-sdk@1.0.1`): every step runs in an OS process container that may write only the session's files and reach only its egress proxy, inside a job object that limits its memory, processes and CPU (`--memory-limit`, `--process-limit`, `--cpu-limit`). Each step runs on the connector's own Node.js. Commands run in [busybox-w32](https://frippery.org/busybox/)'s shell, because Git for Windows' bash can't start in the container: save `busybox64.exe` as `%LOCALAPPDATA%\Programs\busybox\busybox.exe`, or name it in `PIKIBUN_SANDBOX_SHELL`. Pikibun refuses to run where MXC would fall back to its AppContainer modes, which change the permissions of your folders. Backups and moves of clone sessions don't work here yet.

Neither keeps a [repository cache](#repository-cache-preview) or lends the GPU yet.

## Running without the sandbox

On macOS, native Windows, or Linux without bubblewrap, you can opt out of isolation. This needs only Git (on macOS, `xcode-select --install` or `brew install git`; on Windows, [Git for Windows](https://git-scm.com/download/win), whose bash runs the commands):

```sh
npx pikibun@latest connect --unsafe-no-sandbox
```

The connector prints the risks and asks you to type `unsandboxed` before it starts:

- Approved commands and commits run directly as your user, with access to your files, credentials (`~/.ssh`, cloud and Git configuration, Pi's auth) and network, and no CPU, memory or disk limits.
- File tools are confined to each session's folder by path checks only.
- Commands use this machine's network directly: the workspace's [network access](#network-access) doesn't apply.
- Anyone you share the host with, and anyone with approve permission on a session that runs on it, can cause approved commands to run on your machine.

Pikibun labels such a host **Unsandboxed** to everyone who can see it. Its sessions get no [browser tool](extensions.md#the-browser-pikibrowser), which runs only in the sandbox.

## Repository cache (preview)

By default each session downloads its clones itself. With **Repository cache** set to **Shared** (one cache for every session on the host) or **Per owner** (a separate cache for each session owner) in the host's [configuration](#host-configuration), the connector keeps a full clone of each repository on the host and lets sessions' clones borrow from it. Only the host's owner changes it, and it applies when the connector next connects. (Connectors 0.9.0 and older take `--repo-cache` and `--repo-cache-scope owner` instead.)

- The host fills its copies itself, straight from GitHub (or the repository's Git host), with the credentials Git on the host would use: its credential helpers, such as `gh auth setup-git`. Without one for the Git host it reads anonymously, which only public repositories allow. Nothing is downloaded through Pikibun for the cache, so it is as fast as the host's own network.
- A session borrows from a copy only once Pikibun confirms, with the session owner's own account, that they can read the repository, again every 10 minutes and each time the session is reopened. The host downloads only the branches and tags that account lists, and only after that. A session's copies are there from its first command on, empty until a clone fills them.
- `git clone` of a workspace repository asks for the host's copy and borrows its objects (`--reference-if-able`) instead of downloading and storing them again; only what the copy lacks comes through Pikibun. The first clone of a repository waits while the host downloads it, however long that takes, and says so; the download goes on if the command stops, so a clone stopped by the command time limit can just be run again. A copy filled before is brought up to date first, but a clone waits at most 10 seconds for that, then borrows it as it is. If the host can't fill a copy at all (no credential that can read the repository, say, or a listing of it that fails the same way every time), the clone says why and goes ahead without it. A copy that isn't available just now (Pikibun can't confirm access, or the host's download keeps breaking off) is asked for again, and then the clone stops, to be run again, rather than downloading the repository without it. Clones with `--reference`, `--shared` or `--dissociate` are left alone.
- Fetches into the cache that break off are tried again; what a broken-off fetch left behind is removed.
- Inside the sandbox the cache is read-only.
- `npx pikibun@latest cache list` shows each cached repository, its size and how many sessions keep objects in it. `npx pikibun@latest cache prune --older-than 30` forgets sessions idle for longer than that many days and collects what nothing reaches any more; a clone in such a session loses the objects it borrowed. Both take `--state-dir`.

## Connector options

| Option | Effect |
|---|---|
| `--server ORIGIN` | The Pikibun server's origin; needed for the first pairing |
| `--pairing-id ID` | The pairing ID from **Pair a host**; the code is asked for at a hidden prompt |
| `--force` | With `--pairing-id`, replace this machine's saved pairing |
| `--state-dir PATH` | Connector state (default `~/.local/share/pikibun/connector`) |
| `--pi-agent-dir PATH` | Pi's configuration and auth directory (default: Pi's own) |
| `--model PROVIDER/MODEL` | Offer this model (repeatable) instead of `enabledModels` |
| `--resources PATH` | Operator-provisioned resource limits that let commands run in every session |
| `--unsafe-no-sandbox` | Run agent work directly on this machine, without isolation; asks for confirmation |
| `--allow-insecure-loopback` | Allow an `http://` server on localhost (development) |
| `--help` | Show all options |

Everything else is the host's [configuration](#host-configuration), set in Pikibun: its command time limit, GPU, Git credentials and repository cache. `--git-credentials`, `--repo-cache` and `--repo-cache-scope` are still accepted, so existing service units keep starting, but ignored.

The desktop apps' **This Mac** (This Computer elsewhere) runs the same connector; see [iPhone, iPad, Mac and Windows apps](apps.md). [`packages/cli/README.md`](../packages/cli/README.md) is the connector's own guide.
