# Security rationale

The source code has no comments (see [Comments](../development.md#comments)), so the reasons behind security decisions are written here, beside the design notes that cover their own areas: the session proxy in [egress.md](egress.md), the Windows sandbox in [windows-sandbox.md](windows-sandbox.md), who may do what in [authority.md](authority.md), and workarounds for dependencies in [upstream-workarounds.md](upstream-workarounds.md). Change this file in the same pull request as the code it explains.

## Content Security Policy

`apps/server/src/static.ts` (`pageContentSecurityPolicy`) sets the policy of the client's page; `apps/server/src/index.ts` sets a stricter one (`script-src 'self'`) on everything else the server answers. `tests/static.test.ts` pins the page's.

- **`script-src 'self' 'wasm-unsafe-eval'`.** Scripts come only from this server's files: no inline script, no `blob:` module. Native Shell's web runtime compiles WebAssembly, which needs `'wasm-unsafe-eval'` (not `'unsafe-eval'`, so JavaScript `eval` stays off). Up to 0.5 it also built the app's `nsh` modules as `blob:` URLs and mapped them with an inline `<script type="importmap">` whose content changed on every load, so the page had to allow `blob:` and `'unsafe-inline'` scripts. Since 0.6 `nsh package` links the app's modules to their published files when every native import is by name (`"linked"` in the page's app JSON) and the page starts from files of its own (longbridge/nsh#2155), so neither is needed. An app that imports a native module whole would get the import map back: `scripts/nsh-web-fixes.mjs` (`checkStrictPage`) fails the build on that, or on any inline script in the page, and `pnpm test:client-web` fails on a policy violation in a browser.
- **No text as HTML all the same.** The client renders transcript text, tool output and Markdown through Native Shell's components, which put text in the page as text. `tests/transcript-html.test.ts` fails if anything the client ships, or the code the build adds to the runtime, uses an HTML sink (`innerHTML`, `insertAdjacentHTML`, `DOMParser`, `document.write` and the like) or runs text as code (`eval`, `new Function`, `javascript:` URLs).
- **`connect-src 'self' blob: data:`.** Requests go only to this server; the runtime reads its own blobs (a pasted image, a picked photo) with `fetch`.
- **`frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`.** No framing, no `<base>` pointing elsewhere, no form posts or plugins to other origins.
- **`frame-src 'self' https://*.trycloudflare.com`.** The page frames its runtime's own documents and, in the session panel's **App** tab, a session's app through its [tunnel](tunnel.md), which only ever has a Cloudflare quick tunnel's address. Before, frames fell back to `default-src 'self'`. The frame is Native Shell's sandboxed `<iframe>`, which keeps the tunnel's own origin, so the app never reaches the client's origin, cookies or storage, and the page posts nothing to it. Why the tunnel's link works inside it is in [A session's app in its panel](session-apps.md) (decision 5). This is the one wildcard the policy has: `tests/static.test.ts` fails on any other.
- **`style-src 'self' 'unsafe-inline'`.** Kept as it was: NSH 0.6 says its packaged page also starts under `style-src 'self'`, but the app hasn't been checked under it in every browser, and styles run no code.

## Linux sandbox

`apps/runner/src/sandbox.ts` runs every step of a sandboxed session (file tools, Git, shell commands) in bubblewrap, as `python3 -I -c HELPER` (`apps/runner/src/sandbox-python/helper.py`): all untrusted file system access happens in the helper, after it has entered the namespaces. There is no fallback to the host's shell, Git or file system.

- **Namespaces and privileges.** `--unshare-all --unshare-user --disable-userns`: new user, mount, PID, IPC, UTS, cgroup and network namespaces, and no further user namespaces inside (which would let a command build its own mounts). `--cap-drop ALL`, `--new-session` (no `TIOCSTI` into the connector's terminal) and `--die-with-parent`.
- **What is mounted.** `/usr`, `/lib` and `/lib64` read-only; the session's home, worktree, its `.git` and its Git configuration by file descriptors the connector opened (`--bind-fd`, `--ro-bind-fd`), so a symlink or rename between checking a path and mounting it can't redirect the mount. The `.git` directory is writable only in the workspace's own Git steps, and the session's Git configuration (`.gitconfig`, made once by the connector and checked unchanged at every open) is always read-only, so no command can change how Git runs for the session's later steps. Finally `/`, `/proc` and `/dev` are remounted read-only.
- **Its own `/etc`.** None of the host's `/etc` is mounted. Programs that look their user up (`initdb`, `ssh`, Node.js's `os.userInfo()`, Python's `getpass`) need a user, and tests and servers that name `localhost` need it to resolve, so the connector writes the session's own `passwd`, `group`, `hosts` and `nsswitch.conf` (`sandboxEtc`) beside its mounts at every open and mounts them read-only at `/etc`. They name a `pikibun` user with the connector's uid and gid and the session's home, `root` and `nobody`, and `localhost` as the loopback addresses: nothing of the host's users or names.
- **Environment.** `--clearenv`, then only what the connector sets: nothing of the connector's environment (tokens, `SSH_AUTH_SOCK`, the host user's paths) is inherited.
- **Network.** Only shell commands, and clone restores, get the network: the session proxy's Unix socket, read-only at `EGRESS_SOCKET`, which the helper relays to a loopback port inside the namespace, and the host's CA bundle at `CA_BUNDLE`. The network namespace has no other way out, so a command that ignores the proxy settings only fails. What the proxy lets through is in [egress.md](egress.md).
- **Helpers out of the session's reach.** The `git` shim, the browser tool's driver and the session service's driver are written afresh at every open, beside the session's mounts and read-only inside, so nothing the session runs can replace them for a later command.
- **Resources.** Shell commands run under a resource supervisor that alone holds the root descriptor and a liveness pipe, which it closes before starting bubblewrap. It is never sent `SIGKILL`: it keeps its lock until the command's whole cgroup is killed and empty, and watches its parent and its own deadline. A command stopped while it waited for the sandbox never starts, and a permission revoked while it waited is checked again just before it runs.
- **Without cgroups, the connector outlives a runaway command.** Where the host's owner lets commands run without the cgroup limits, nothing bounds their memory. A command that took all of it (a script named `bisect.py` that shadowed Python's own `bisect`, so the program it ran imported it and started itself again, thousands of times over) made the kernel's OOM killer take the largest process, the connector, and every session on the host lost its connection, twice in a row as the session ran it again. Two things now stop that:
  - *The sandbox goes first.* Every step starts as `/bin/sh -c '{ echo 1000 >/proc/self/oom_score_adj; } 2>/dev/null; exec "$@"' sh /usr/bin/bwrap …` (`EXPENDABLE`), so the highest OOM score is set before bubblewrap starts and everything in the sandbox inherits it. It is set outside because the sandbox's `/proc` is read-only, raising a score needs no privilege, and `exec` keeps the process the connector started, its process group and its descriptors. Under the resource supervisor, the supervisor's own child sets it just before it execs bubblewrap, so the supervisor keeps an ordinary score and stays to empty the command's cgroup. Commands on the host get the same score from a `{ echo 1000 >/proc/self/oom_score_adj; } 2>/dev/null; ` prefix on the command's first line (`hostBashArgs`, Linux only): bash's builtin forks nothing, so no process of the command can start before it, and `$LINENO` and error lines stay the command's own.
  - *A runaway chain of processes stops.* The helper sets `RLIMIT_NPROC` to 4096 tasks (`PROCESS_LIMIT`, processes and threads, ample for parallel builds). Since Linux 5.14 the kernel counts it per user namespace, and every Linux step has its own (bubblewrap's `--unshare-user` is the only way the helper runs there), so it counts only that step's tasks. Before 5.14, or outside a namespace of its own (`/proc/self/uid_map` is the identity map), it would count every process the host user runs, the connector's too, so it is set only on 5.14 and later, inside one.
- **What it leaves to the host.** The host's GPU render device only where its owner lends it (with NVIDIA's character devices, which CUDA opens: more of the driver's kernel interface than a render node, which is why lending the GPU stays the owner's choice; see [A session's app in its panel](session-apps.md), decision 9), and the connector's Node.js and the host's Chromium read-only where `/usr` doesn't already hold them.
- **Checked before the connector starts.** `bubblewrapPrerequisite` (`apps/runner/src/connect-setup.ts`) runs the helper's Python under the same namespace flags and read-only mounts once, before a sandboxed connector pairs or connects. bubblewrap can be installed and still unable to make a user namespace (AppArmor's `apparmor_restrict_unprivileged_userns` on Ubuntu 23.10 and later, `unprivileged_userns_clone=0`, `max_user_namespaces=0`, or a container that forbids them). Without the check such a host started, took sandboxed sessions and failed every one of them later, so the connector now refuses to start there, as it does when bubblewrap is missing.
- **Verified before the host says it is sandboxed.** Every host used to advertise `sandbox: false`, so every one showed "Sandbox unverified" and the label told nobody anything. Before a Linux host on bubblewrap sends its manifest (`pikibun connect`, the desktop app's host and `pikibun serve`'s host), `verifySandboxIsolation` (`apps/runner/src/connect-setup.ts`) runs one step under the session's namespace flags and read-only mounts, plus `--clearenv`, and the step checks itself from inside: its user, mount, PID, network, IPC and UTS namespaces all differ from the connector's (compared by `/proc/self/ns` links), it has no network interface but loopback, no effective capabilities, can't see a sentinel file the connector made in its temporary directory nor the host user's home, can't write its root, can't make a user namespace, and didn't inherit a canary variable from the connector's environment. Only when it prints `ok` and exits 0 does the host advertise `sandbox: true`; anything else (bubblewrap refused, a leak, a timeout) leaves it `false` with the reason in the connector's log, and the host still runs, sandboxed, as before. Experimental sandboxes (Seatbelt, Windows) aren't checked and stay unverified. It is a self-report by the host, not an attestation: the server can't check it, and a modified connector could claim anything, so it only steers the label and Auto's preference for sandboxed hosts, never what a session may do. Sessions keep their own checks.

## Updates of the desktop app

`apps/nsh/src/lib/app-update.ts` downloads a newer `app-v` release's package and swaps it in. Its SHA-256 comes from the same release that serves the package, so on its own it tells the app only that the download arrived whole, not who made it: anyone able to replace a release's files, or GitHub's answer, could replace both.

- **A signature by a key outside the release.** The release job (`.github/workflows/release-app.yml`, `github-release`, in the `release` environment) signs each desktop package with `APP_UPDATE_SIGNING_KEY`, an Ed25519 key, and publishes `<package>.sig`. The app carries the public half (`UPDATE_SIGNING_KEY`, `packages/shared/src/update-signature.ts`) and checks it with WebCrypto before it installs anything. A package whose signature doesn't verify is deleted, and a release without a `.sig` for this computer is offered as its page only.
- **What is signed.** Not the package's bytes but `pikibun app update v1`, its file name and its SHA-256 (`updateSignatureMessage`). The app hashes the download anyway, and the name carries the version, so an older signed package can't be passed off as a newer one, and the check costs nothing however large the package.
- **One check on every desktop.** The same signature covers macOS, Windows and Linux. The platforms' own code signatures (Developer ID and notarization, SignPath's Authenticode) stay as they are; the Linux archive has no other.
- **A release that would fail every app fails instead.** `scripts/sign-update.mjs` verifies each signature against the public key in the source before anything is published, so a missing or mismatched secret stops the release.
- **What it doesn't cover.** Whoever can run the release job with the `release` environment can sign: the key guards against a release's files or GitHub's answer being changed after the fact, not against a release made by someone who may make one. The environment's rules are what limit that: the `release` environment admits only the release tags (`app-v*.*.*`, `cli-v*.*.*`, `server-v*.*.*`, `ext-*-v*.*.*`), so a workflow on a branch gets none of its secrets. That holds for the key only while it is a secret of that environment and not of the repository, and it doesn't limit who may push such a tag: a tag ruleset and required reviewers on the environment do. Releases from before this change carry no `.sig`, and an app from before it checks nothing; the first update to a version with the key is trusted the old way.

## The app's command line

The desktop app starts `pikibun` through the owner's login shell (`$SHELL -ilc '…'`), so that it finds the command where a terminal would. Every argument goes into that line as one shell word (`shellArg` in `apps/nsh/src/lib/pikibun-command.ts`, single-quoted unless it is plain), and a server saved in the app's storage is used only with the state directory `serverStateDir` makes for its origin. A value in storage, or a directory with a quote or a `;` in it, can therefore never become a second command. `~/` stays unexpanded inside the quotes on purpose: `pikibun host` expands it itself.

## macOS sandbox (Seatbelt)

`apps/runner/src/seatbelt.ts` runs the same helper under `sandbox-exec` with a profile made for each step. Unlike bubblewrap there are no mounts: the session's files are used where they are, and the profile decides what a step may reach.

- **Reads are denied by default.** A step sees its own home and worktree, its Git directory, the CA bundle and the system's read-only runtime (system binaries and libraries, the selected developer tools, Homebrew and the toolchains below `/usr/local` that `SEATBELT_LOCAL_ROOTS` lists), and nothing of the host user's home, other sessions or the connector's state. Path resolution may read the metadata of every ancestor, never their contents.
- **Writes** go only to the session's home and worktree, and to its Git directory only in the workspace's own Git steps. Last in the profile, so they win (Seatbelt applies the last matching rule), the denies cover the worktree's pointer to the Git directory, and the Git directory itself outside Git steps.
- **Paths are parameters.** Every path goes into the profile as a parameter (`-D NAME=path`), never spliced into its text, so no path can change what the profile means.
- **The network is the session proxy only:** outbound connections to its loopback port. Seatbelt's `localhost` rule also covers the host's other addresses on that port, so the proxy requires the session's token on every request (sent as proxy credentials, `pikibun:<token>`), and neither another session nor another program on the host can use it. No other loopback port is reachable, so tests that start a local server fail on this backend.
- **No trustd.** `com.apple.trustd.agent` fetches the AIA, OCSP and CRL addresses a certificate names on the host's own network, outside the proxy, so a step could send data the network policy refuses. It is denied; Go and Swift, which verify TLS only through it on macOS, can't make HTTPS connections here (curl, Git, Node and Python use the session's CA bundle).
- **Processes** inherit the profile and may signal and inspect only each other. The machine's own sysctls are allowed, never `kern.procargs`, which shows other processes' environments.
- **Only the system's `sandbox-exec`**, never one found on `PATH`. It is deprecated in Apple's headers but still ships, and Chromium and others depend on it.
- **No hard memory or process limits** (macOS has no cgroups), so commands run there only where the host's owner allows them without limits: in their own sessions and those of
  members they grant host commands.

## Sessions on the host

In the private workspace, **Where it runs** starts on the host for the host's owner (#259): the session's commands run as the owner, with their files, credentials and network, and since approvals were removed (#271) nothing asks before they run. That is a product decision, not a gap in the code, and it rests on these:

- **Only the host's owner, and members they grant host commands.** Everyone else's calls to anything that runs on the host's own machine are refused, on the host (`HOST_COMMANDS_RULE` in `apps/runner/src/session/host-commands.ts`) and by the server.
- **It is chosen visibly and recorded.** The new-session screen shows a red **On host** chip and a warning while it is chosen, and the choice is audited with the session (`hostEnvironment`).
- **Read only** changes nothing on the host either.
- **The owner's own environment, only in the owner's own sessions.** A session on its host whose owner is the host's owner (`hostOwnersSession` in `apps/runner/src/host-workspace.ts`) runs commands with the connector's environment (`ownerHostEnvironment`): the owner's `HOME`, `SSH_AUTH_SOCK`, global and system Git configuration. A rebuilt environment protected nothing there: the commands already run as that user and can read `~/.ssh`, and the agent socket is reachable by the same uid. It only broke ssh with agent keys, `gh` sign-ins and the macOS keychain helper. What is left out, and why:
  - **Always: Pikibun's own variables and Git's repository-local ones** (`CONNECTOR_ENVIRONMENT`). `GIT_DIR` and its kin, inherited from a hook that started the connector, would point every command's Git at another repository.
  - **In a server's process, everything that server reads** (`serverEnvironment` in `apps/server/src/config.ts`, passed as the connector's `privateEnvironment` by `apps/server/src/local/host.ts`). `pikibun serve` and the desktop app run the connector there, so the environment holds the server's secrets and its storage credentials, which may be the standard `AWS_*` names. Those are the server's, not the session owner's, even on the same person's machine. A test reads every `process.env`/`processEnv` name in the server's sources and fails if `serverEnvironment` misses one, so the lists can't drift apart.
  - **Not in a connector of its own.** Matching names there (`*_CLIENT_SECRET`, `AWS_*`, `LOCAL_*`) would take the owner's own variables, such as `AZURE_CLIENT_SECRET` or `AWS_SECRET_ACCESS_KEY`, from them, which is what this change is for.
  - **Pikibun's own Git steps keep the isolated environment.** `HostWorkspace` runs its internal Git steps (`#capture`, which makes the worktree) with the session environment, so an owner's Git configuration, broken or unusual, never stops a session from opening.

  It also covers the host owner's own on-host sessions in shared workspaces, not just the private one. There, only the owner and members granted host commands run commands at all, and those members already run anything as the owner's OS user, so the owner's agent and sign-ins add little. The owner picks **Sandbox** for a session that others' messages shouldn't reach their sign-ins from. A member's session, even one granted sessions on the host, keeps the session's own `HOME` and Git configuration: it runs on someone else's account, and their agent and sign-ins aren't the member's to use. The host decides from the binding alone, with no field from the server, because bindings are immutable and a new field would refuse restarting a session made before it.

In the private workspace's sessions of the host's owner, `sudo -A` asks the owner for their password in Pikibun, per use, in a box of its own, and nothing keeps it; see [sudo's password](sudo-prompts.md) for why per use and not once, and what that does and doesn't protect.

What it doesn't protect against: text the agent reads (a repository's files, a web page, a cloned repository's `AGENTS.md` through `extensions/context-files`) can steer what it runs, and on the host that runs as the owner. Use **Where it runs → Sandbox** for work on code or pages you don't trust. A session on the host runs its extensions on the host too, in a process of their own as the owner's user (`apps/runner/src/extensions/`), so there a workspace's extensions are trusted code; in a sandboxed session on Linux or macOS they run in its sandbox ([extension isolation](extension-isolation.md)).

## Whose tools a message runs

A session's tools run as its owner (their Git accounts, their GitHub token), for anyone who may send it messages: collaborators on every session of the workspace, members with a session role of Collaborator, and the workspace's owner and admins on every session. Checked against the owner's tool group alone, that let anyone use the owner's tools by writing in their session: a collaborator, whose role leaves out `github_merge`, could have an admin's session merge a pull request as the admin, and a member could push to other branches and comment on GitHub through a session whose owner may. So a call is checked against both groups, the owner's and the message's sender's (`requireSessionTool` in `apps/server/src/authority/tool-groups.ts` for what Pikibun brokers; `sessionToolsOff` and `requireSenderTool` in `apps/runner/src/session/availability.ts` on the host):

- **The sender is the message's.** Brokered calls name the admission's actor, which the broker already checks is the message's sender; on the host it is the run's `initiatedBy`. Scheduled prompts are sent as the schedule's owner, so they run with that owner's group alone, and changing someone else's schedule makes it the changer's ([workspace-schedules.md](workspace-schedules.md)); a message the sessions tool delivers is sent as the person whose message made the call.
- **Hidden, then refused.** A message isn't offered the tools its sender's group leaves out, so the agent doesn't plan around them, and a call made anyway (say, the group changed while the message ran) is refused before it runs. Every tool call passes `ToolCalls.check` (`apps/runner/src/session/tools/calls.ts`), which checks the owner's group (`requireOwnerTool`) and, for a message that may act, the sender's, so a change to either applies at the next call, the file tools and the owner's own messages included. Side asks run only read tools and are checked against the owner's group alone.
- **Command-line tools write with one credential.** `piki:gh`, `piki:glab` and `piki:azure-cli` write to the forge as the session owner, with a token (or the host's own sign-in) that can comment, open issues, merge and push alike, and nothing maps a command to the one tool it stands for (`gh api` and GraphQL can do any of them). So they write only in a message whose sender and owner both have every one of `forgeWriteTools` (`git_push`, `github_comment`, `github_issue`, `github_merge`, in `packages/shared/src/tool-groups.ts`): otherwise the host gives the call no write lease (`forgeWrites` in `availability.ts`, used by `session/piki.ts`) and the extension runs only the commands its read-only setting allows. The Pikibun server refuses the write credential itself when the owner's group lacks one of them (`apiCredential`); it doesn't know the sender, which the host checks.
- **Stopping isn't gated.** Taking a tunnel offline needs no `tunnel`: anyone who may write to a session may stop its work.
- **A message acts while its run goes on, not forever.** Brokered calls (GitHub writes and reads, pushes, source reads, the sessions and schedule tools) name the message's write admission, which lasts an hour from the message. Past the hour it lives on only while the session's host reports it working or waiting on an approval, has not reported it stopped (idle, done or failed: `sessions.activity_ended_at`) since the message, and no later message came in (ties broken by id), so the run is still that message's: a side ask, which takes no admission, after the run ended doesn't bring it back. Comparing the stop with the message's time is enough for a message sent while another run goes on: the host stores it as `queued` before its submit answers, and `queued` counts as working (`sessionActivity` in `apps/runner/src/activity.ts`), so the host reports no stop between the two runs; only a stop reported in the moment between the server admitting a message and its host queueing it would end the renewal early, leaving that message its hour, as before. A side ask already running when the write run ends keeps the session working, so its admission renews until the ask ends: closing that needs the host to report activity by run. Never past 8 hours from the message (`admissionExpired` and `ADMISSION_RENEWAL_MAX_SECONDS` in `apps/server/src/authority/run-admissions.ts`). A long run (a CI or review wait, then a merge) so finishes what it was asked to, while a session left alone, or a host that keeps claiming work, still can't act on a message's behalf without a person sending one: the cap bounds what that host could do with the latest sender's account, and a later message, from anyone, ends the earlier one's extension. The pending-admission quotas still count only the first hour.

What it doesn't protect against: the conversation is shared. A sender can leave instructions in it, or in the files, that the agent follows on the owner's next message, with the owner's tools. That is the same as any text the agent reads (see [Sessions on the host](#sessions-on-the-host)); where it matters, keep work with tools others lack in your private workspace, or make people members rather than collaborators, so they only follow it.

## GitHub repositories outside the workspace

The workspace's repositories bound what a session does on GitHub as its owner: `github_read`, `github_comment`, `github_issue` and `github_merge` refuse another (`repository_not_pinned`), and `gh`'s credentials cover only them, except in a call that may write (below). That bound is Pikibun's, not GitHub's: the owner's sign-in token reaches every repository their account does, and can't be limited to some. It is there because the one acting isn't the owner: it is an agent that follows what it reads, prompted by whoever may message the session. A member who wants their sessions to file issues upstream, or merge in a repository the workspace doesn't bind, can lift it for themselves (`member_github_reach`, `apps/server/src/authority/github-reach.ts`, [GitHub](../github.md#repositories-outside-the-workspace)):

- **Their own choice, for their own identity.** Each member sets it for themselves, per workspace, off by default; a workspace admin can't turn it on for someone else, since it spends that person's account. Turning it off applies to the next call.
- **Only their own messages.** The brokered tools check the message's sender is the session's owner (`senderReachesAnyGitHubRepository`, called by `githubTarget` in `apps/server/src/authority/github-broker.ts`). A collaborator, an admin or another member writing in the owner's session keeps to the workspace's repositories, so nobody borrows the owner's reach, as nobody borrows their tools ([Whose tools a message runs](#whose-tools-a-message-runs)). The tool groups still apply on top.
- **For `gh`, the host vouches for the sender.** The Pikibun server doesn't know who sent the message a credential request serves. The host asks for a write credential that reaches beyond the workspace (`reach: "any"`) only for a lease of a call whose sender is the owner (`SessionPiki#runCommand`); the Pikibun server marks the owner's write credential `anyRepository` only if the owner turned their reach on. Write credentials go only to the owner's own hosts, so the host vouching is the owner's own connector, which could already use their token as it liked. The proxy keeps a credential per reach, so a lease of another sender's call never gets the wider one (`ApiAccess`).
- **GitHub's canonical identity, read with the owner's sign-in.** Outside the workspace there is no pinned repository identity to compare against, so each call asks GitHub for the repository as the owner (`githubRepositoryMetadata`) and acts on the name GitHub answers with: a repository the owner can't see is refused before anything is written, and a renamed one is acted on under its new name. Audits record `outsideWorkspace`.
- **Reads and writes, not pushes.** Pushes go through the push broker, which pins a workspace binding and the session's branch; this doesn't change that.
- **Comments too.** `github_comment` goes through the same `githubTarget` as issues and merges, before its tool call is spent: it used to post wherever its call said, for any sender, which let a collaborator's message, or text the agent read, comment as the owner in any repository their account reaches. Its audit entries (`github.comment.completed`, `.failed`, `.ambiguous`) now record `repository`, `issue` and `outsideWorkspace`. Connectors need no change: an older one gets `repository_not_pinned` for a repository outside the workspace, and reports the comment as refused.

What it doesn't protect against: with it on, a prompt injection in something the owner's agent reads, during a message the owner sent, can act as the owner on any repository they can access. That is the trade the member makes, and the settings page says so.

**Where `gh` doesn't keep to the bound, by design.** A `gh` call that may write (a lease, [egress](egress.md#credentialed-apis-gh-without-a-token-in-the-sandbox)) holds the owner's sign-in token while it runs. Requests that name no repository in their path go with that token whatever the reach setting: GraphQL, whose one endpoint serves every repository named inside the query, and REST paths such as `/user/repos`, `/search/...` and `/repositories/{id}/...`. Only REST paths of the form `/repos/{owner}/{name}` are held to the workspace's repositories (`credentialFor`), and so is Git. So such a call can read any repository the owner can, private ones included (#398). It stays this way, rather than the proxy parsing GraphQL, for these reasons:

- **Mutations already reach that far.** A lease's GraphQL mutations name what they change by node id, which the proxy can't tie to a repository, so they act wherever the token reaches. Holding queries alone to the workspace would close the read and leave the writes open, while making gh's own queries fail (below).
- **gh needs the owner's view.** gh asks GraphQL for `viewer`, and for `viewerPermission` to decide whether it can push (`RepoNetwork`, `CanPushToRepo`). The App's token can't answer those as the owner, so the proxy keeps GraphQL on the owner's token under a lease (#287).
- **A lease is narrow.** Only the owner's own hosts get the token, only for a call that someone with host commands sent in a message that may act, outside **Read only**, with every GitHub writing tool in the sender's and the owner's tool groups. Such a call could already write anywhere through mutations. Every other call reads with the App's token, which GitHub limits to the workspace's repositories; that is the bound most sessions run under.

To keep a session's `gh` within the workspace, leave a GitHub writing tool out of a tool group, or set `piki:gh` **read-only**.

## Sessions without visibility

Every session is visible to every member of its workspace, and a workspace role decides what each member does in it: viewers and members read, collaborators also message, owners and admins also manage. A session role only adds to that. Private sessions, which only their owner, the workspace's owner and admins and people with a session role could open, were removed: two kinds of session made every list, grant and cross-session check depend on a setting people rarely changed, and the private workspace already keeps work to one person, as nobody else can join it.

- **Access reads no visibility.** `workspaceSessionPermissions` (`packages/shared/src/policy.ts`) takes the role alone, `sessionAccess` and the session lists (`apps/server/src/authority/access.ts`) admit every member, and a run's admission (`run-admissions.ts`) lets every role that messages sessions write. The `visibility` column stays, always `'workspace'` (a migration made every session so): SQLite can't drop a column with a `CHECK` without rebuilding the table, and backups, workspace databases and session records still carry the field, which apps from before read.
- **Old clients keep working.** `POST /api/sessions` accepts a `visibility` of `private` or `workspace` and ignores it, as apps from before send one (their install chats asked for `private`), and so does the sessions tool's `create` for runners from before; any other value is refused, as before. Refusing `private` would break those apps' install chats and those runners' sub-task sessions over a setting that no longer exists, and every session is visible to the members anyway. `PATCH /api/sessions/:id` refuses `visibility` with `visibility_removed`, so an old app's **Make private** says why rather than pretend.
- **What the migration did.** Sessions made private before became visible to their workspace's members: their prompts, output and side asks, from the start. That can't be undone by making them private again, as nothing can recall what was read.
- **Content between sessions.** Two sessions of a workspace have the same readers, unless one is shared by link, so the sessions tool's audience check (`audienceCovered`, [cross-session](cross-session.md#who-can-see-what)) now only stops content flowing into a session shared by link.

## The worktree's Git changes

The session panel's **Changes** tab shows a clone's uncommitted changes, its commits and one commit's changes (`GET /api/sessions/:id/changes`; `RunnerSession.changes` and `apps/runner/src/local-changes.ts` on the host). Unlike the Files tab, which reads files with the connector's own code, this runs a program, Git, where the session's commands run. That is the part that needed deciding:

- **One fixed command; the reader supplies two checked values.** The host builds the whole shell command (`localChangesCommand`). The reader chooses only a repository's directory, a relative path with no `..`, `.git`, backslash or control character, passed as one quoted word, and a commit, which must be a full hash. Nothing else of the request reaches the shell, and the Pikibun server refuses anything else before asking the host. The directory must still be inside the worktree once its links are followed (`pwd -P`), and a linked directory isn't listed as a repository, so a link in the worktree doesn't make the tab read a repository elsewhere on the host.
- **Git doesn't run the repository's programs.** A repository's configuration can name programs Git runs while it reads: an external diff driver, a text-conversion filter, a file-system monitor, hooks. The command turns each off (`--no-ext-diff`, `--no-textconv`, `core.fsmonitor=false`, `core.hooksPath=/dev/null`) and takes no optional locks, so reading writes nothing. `tests/local-changes.test.ts` configures all three in a real repository and checks none ran. What can't be turned off in general is a `clean` filter, which Git runs to compare a changed file with the index; so the next two points don't rely on the flags alone.
- **In the sandbox, with the worktree read-only.** A sandboxed session runs it as it runs the agent's own Git, inside the sandbox, with the worktree mounted read-only for the call. Whoever may send the session a message can already have the agent run Git there, so the tab takes the same `write` permission and adds no reach.
- **On the host itself, only for those who may run commands there.** In a session that runs directly on its host, the command runs on the owner's machine. The host applies the rule it applies to the agent's commands (`HostCommandPolicy`, which also covers a member's session on a host whose sandbox has no resource limits): the host's owner and members granted host commands, checked again as the command starts. A collaborator without that grant is refused, because a file tool is enough to write a `clean` filter into a clone's configuration, and opening the tab would then run it as the host's owner.
- **Bounded, and checked twice.** The command's output is cut at 3.5 MB by the shell and its time at 30 seconds, and it ends with the call's marker, so an answer without that last line is known to be cut whatever its bytes decode to; the host parses it into files and hunks within the reviewer's limits, and the Pikibun server checks the host's answer again (`checkLocalChanges`: shapes, sizes, that a patch is hunks, that the answer is for the directory and commit asked) before redacting it line by line as the reviewer's diffs are. The sections of the output are divided by a marker the host draws at random for each call, so a file's contents can't pass for a section; within the diff, a file's lines always follow a `+`, `-` or space, so they can't pass for a file header either. A file's name could (review 380, finding 46): Git quotes a name with control characters in the diff it writes, but the host prints the header of a new file that is too large or not a regular file itself, so a name holding a line break could add entries of its own. New files whose names hold control characters are left out and counted with the files not shown, and so is a new file whose header the host prints if its name holds `"` or `\`, which could otherwise make the parser read another path from it. Git writes the header of a small regular file itself, quoted, so such a name shows there.
- **Old hosts are refused before anything is asked.** A host says it can answer with the `localChanges` capability; the server asks no host without it.

What it doesn't protect against: it queues behind the session's other commands, so it doesn't interrupt a running one and can wait for it; and it shows what Git shows, so a secret in a diff that the redaction's patterns don't know is seen by collaborators, as it is in the Files tab.

## Artifacts

[Artifacts](artifacts.md) are pages the agent wrote, shown to everyone who may read the session, share links included, so an artifact is treated as hostile to the app that shows it:

- **Its own origin, no way out.** HTML and SVG are given to Native Shell's `WebView` as a page (`html`), never as a URL of the Pikibun server. On the web that is an `<iframe>` with `srcdoc` and a `sandbox` without `allow-same-origin`, so the page has an opaque origin: it reads neither the app's cookies nor its storage nor its DOM. In the apps it is the platform's web view, apart from the app's views, with `incognito` so it keeps no website data beside the app's, and with no `onMessage`, so what it posts to `window.nsh` goes nowhere.
- **No network.** The page starts with its own policy, `<meta http-equiv="Content-Security-Policy">` placed before anything of the artifact's (`artifactFramePolicy`): `default-src 'none'`, inline scripts and styles, `data:` and `blob:` images, fonts and media, `connect-src`, `frame-src`, `worker-src` and `form-action` `'none'`, `base-uri 'none'`. A later policy can only narrow it, and removing the element doesn't lift it. So it fetches nothing, loads no outside image or font, submits no form and opens no frame: what it holds can't be sent anywhere by a request. On the web the frame also inherits the page's own policy, which only narrows it further. `tests/artifacts.test.ts` pins the policy's place and contents; it was checked in Chromium with a page that tries the parent, storage, `fetch` and an outside image, all refused.
- **SVG as an image.** An SVG is an `<img>` of a `data:` URL inside that page, where its scripts don't run and it loads nothing.
- **Markdown is the transcript's.** It goes through `TextView` with HTML read as text, and images other than `data:` show as their alt text, so a Markdown artifact loads no tracking pixel.
- **What is left.** A script can still navigate its own frame (a link, `location`, a `<meta>` refresh) to a page elsewhere, carrying in the URL only what the artifact itself holds, which its readers can already see; the frame shows a misleading page at worst, inside its box. Content is redacted as the transcript is, but a secret the patterns don't know is shown to the session's readers as it would be in the transcript; the tool's description tells the agent never to publish secrets.
- **Reading is reading.** Listing and reading versions takes the session's `read` permission, as its view does, through the host's `artifacts` action, which only reads the session's store and changes nothing, so it is allowed where `view` is (archived, packed or frozen sessions, a move in progress). A share link reads as the owner, as its view does, and the link is checked again after the host answers.

## The pull request reviewer

The session panel's **Review** tab shows the session's pull request: its description, commits, checks, reviews and each changed file's diff (`GET /api/sessions/:id/pull-request`, `sessionPullRequestReview` in `apps/server/src/authority/pull-request-review.ts`). The Pikibun server reads it from GitHub with the session owner's stored sign-in, for whoever opened the tab, so the route is held to what the agent's `github_read` already gives the same people:

- **Collaborators only.** It takes the session's `write` permission, as the Files tab does. Whoever may send the session a message can already have the agent read the pull request, or any file of the repository, with the owner's access; a viewer or a share link can't, and gets nothing here either. Unlike a message it runs no tool, so neither person's tool group is asked: it reads, and changes nothing on GitHub.
- **The session's own pull request, never one the reader names.** The route takes no repository, number or address. It reads the pull request the server recorded for the session: the one a push through Pikibun opened, or the one found on a branch the session's host reported. So it can't be turned into a reader of the owner's other repositories.
- **Only in a repository of the workspace.** The pull request's repository must be one the workspace binds, and GitHub must still answer with the bound repository's numeric identity under that name before anything is read (`pinnedGitHubRepository`, `verifyPin`), as for `github_read`: a repository renamed or replaced under the same name is refused.
- **Checked again before it answers.** After the reads, the server checks that the owner's GitHub sign-in is still the one it read with and that the reader still has the session's `write` permission under the same policy version, so a grant withdrawn while GitHub answered returns nothing.
- **Bounded, and with secrets hidden.** At most 300 files and 250 commits, a file's diff up to 256 KB and 2 MB of diffs in all; the rest is left to GitHub and counted. The description, comments, reviews and commit messages pass through the transcript's redaction, as a file in the Files tab does, before they are cut to length (`readIssue`'s `prepare`), so a token across a cut isn't left as a first half the patterns no longer match. The diff hunk GitHub attaches to each review comment is left out (`diffHunks: false`): the tab doesn't draw it, and it is a second copy of lines the files' diffs already carry. A diff is redacted line by line, under its `+`, `-` or space (`redactPatch` in `packages/shared/src/pull-request-review.ts`): run over the whole patch, the redaction took a deleted line's `-` for the end of a private key and left the key in, and joined the lines of an added one, so the hunk no longer had the lines its header counts. A private key is followed down its own side of the hunk, each of its lines replaced by one redacted line, so a key a commit removes is hidden like one it adds and every line keeps its number. Names (branches, logins, checks, paths) are shown as GitHub gives them: they identify what is reviewed.
- **Azure DevOps the same way.** A pull request on Azure DevOps (`readAzurePullRequestReview` in `apps/server/src/authority/azure-pull-requests.ts`) is held to the same rules: the session's own pull request, in an Azure DevOps repository the workspace binds, whose identity Azure DevOps confirms (`verifyRepository`) before anything else is read; the pull request must belong to that repository's id; it is read with the session owner's own Azure DevOps account for the repository's organization, which is checked again afterwards (`recheckAccess`), as is the reader's `write` permission. Azure DevOps gives no diff text, so the server reads each changed file's two blobs, by the object ids the pull request's latest iteration names, and diffs them itself (`apps/server/src/authority/line-diff.ts`): at most 256 KB a blob and 8 MB in all, a file that holds a NUL byte counted as binary and shown without a diff, and the same redaction and limits on the result as a GitHub patch.
- **Not in the audit log.** `github_read` is recorded because the agent makes it, unseen, on someone's behalf. A person opening a tab is not, as browsing the Files tab isn't; recording each refresh would fill the session's 200 newest entries.

It stays available on archived sessions, and on a session being restored or moved, which the Files tab refuses: nothing runs, and the host isn't asked. So the route asks for the session's `read` permission, which those sessions keep, and then checks `write` itself. What it doesn't protect against: a collaborator sees the owner's view of the pull request, which may be of a private repository the collaborator can't open on GitHub themselves. That is the workspace's sharing model (a session's tools run as its owner), not something this route adds.

## Pikibun's extensions from npm (managed packages)

`apps/runner/src/extensions/host.ts` (`applyManaged`), `store.ts` (`addManaged`), `packages/shared/src/managed-extensions.ts`; the plan is
[Loading Pikibun's extensions without a connector release](extension-loading.md). A host ran Pikibun's extension code
because its owner started that connector release. With `pikibun connect --managed-extensions` it runs code its
connector fetched since, at the version Pikibun's control plane pins. What bounds that:

- **Two parties must agree.** npm serves the tarball and the control plane names its digest (`integrity`, npm's own
  `dist.integrity`), which the connector compares with the one npm wrote to the lock file. A compromised publish alone
  changes nothing a pin names, and a compromised control plane alone can only name versions already published under
  `@pikibun/`, each with provenance from this repository's release workflow.
- **The scope is the connector's.** `MANAGED_EXTENSION_SCOPE` is a constant: a pin naming another package is refused
  before npm runs, so a control plane can't make a host install anything else.
- **Nothing runs at install, and nothing else is installed.** npm runs with `--ignore-scripts` and installs no peer
  dependencies; a lock file that names any package besides the pinned one, another version, or no digest is refused,
  and the install is deleted. Published extensions import only Node's modules and their peer dependencies
  (`scripts/check-extension-packages.mjs`), so a dependency is never needed.
- **Only what has no authority of its own.** A pin replaces only a hook package the connector bundles as one
  (`managedSource`: `pr-flow`, `context-files`) or names one it doesn't know. The extensions that run a forge's
  command with the host's sign-in, switch the session's own tools, or call a model with the host's keys (the prompt
  audit) are connector code, and a pin for one is ignored.
- **The host's owner decides.** It is on by default only where installed extensions run in the session's sandbox
  (Linux, and macOS with Seatbelt; #438 phase 2), off elsewhere unless the connector starts with `--managed-extensions`,
  off with `--no-managed-extensions`, and `--no-remote-installs` refuses it as it refuses every install asked for in Pikibun. A connector run from source never
  uses pins.
- **Versions only go up.** A host runs the newest of the pinned package, the newest managed version it has run before
  and its bundled copy (whose version is the extension's latest release tag at the connector release's commit), and installs a
  pin only when it would run. So neither a mistaken pin nor a compromised control plane takes a host back to an older
  version, with whatever that version got wrong.
- **A failed pin runs nothing.** A package that fails a check is deleted; the host runs what it ran before, so a
  registry that is down or a bad pin can't stop a host that requires one of them.

What it doesn't protect against: outside a sandboxed session on Linux or macOS, a managed package runs in a process of its own but as the
host's user, outside the sandbox ([extension isolation](extension-isolation.md)), and a version reaches every host that
opted in within a sync. That is why it stays opt-in on hosts without the sandbox until extensions run in it on every platform.

## gh, glab and az rules from the Pikibun server

`packages/shared/src/cli-definitions.ts`, `apps/runner/src/extensions/piki/cli-engine.ts`, `command.ts`
(`servedRules`); the plan is [Decoupling extensions from connectors](extension-planes.md#phase-4-as-built). These tools
run with the host owner's sign-in or a leased forge token, so their refusals keep tokens hidden and their read rules
keep Read-only messages and members without the forge's writing tools from writing.

- **The connector's rules are the floor.** It builds them from the definitions bundled in its release; a definition
  the Pikibun server serves is applied on top: refused if either refuses, a write if either says so. A served
  definition can't drop a refusal or count a write as a read.
- **Bounded data.** Served definitions are parsed with fixed keys, sizes and patterns (option names, variable names,
  plain values, absolute roots, compiling regular expressions); one that fails, or would refuse every call, is passed
  over. Only the rules are taken from them: the command, its environment and its sandbox roots stay the connector's.

## Workspace remote MCP servers

`apps/server/src/authority/remote-mcp/` (`index.ts`, `client.ts`, `transport.ts`), `packages/shared/src/remote-mcp.ts`,
`packages/shared/src/input-schema.ts`; the plan is [Decoupling extensions from connectors](extension-planes.md) (#438,
phase 3). The Pikibun server calls a workspace's remote MCP servers itself and offers their tools to sessions as brokered
tools. What bounds that:

- **Credentials stay on the Pikibun server.** Headers are encrypted with `VAULT_KEY` under a per-server context, never
  returned (only their names), never audited, and never sent to a connector or a session: hosts get only tool
  definitions.
- **No private networks.** Only `https://` addresses without credentials; the transport's `lookup` refuses every
  resolved address in `NON_PUBLIC_IPV4` / `NON_PUBLIC_IPV6` at connect time (no rebinding window), literal private
  addresses are refused, and redirects aren't followed. So a workspace admin can't use the Pikibun server to reach its own
  network, a cloud metadata address or a tailnet.
- **A call needs what a write message gives.** The connector route checks the requester's live write permission, the
  session's host, an unexpired run admission of the requester's message, that the workspace hasn't turned `piki:remote-mcp` off, and that the server and tool are still there
  and enabled in the session's workspace, before and again after the call. Tool groups name Pikibun's own tools, so they
  don't list remote MCP tools one by one; a workspace turns all of them off with `piki:remote-mcp`, or a server with its
  **Enabled** switch. The `piki:remote-mcp` switch is checked on the Pikibun server (`mcp_tools_off`, with the host's own
  `extensionSwitchOn`: on unless a row turns it off), not only where the host builds a session's tools, so a connector
  that calls the route anyway reaches no server for a workspace that turned it off.
- **Headers belong to the address they were given for.** A change of a server's `url` must come with `headers` (an empty
  set, or `null`, sends none and deletes the stored ones); without them it is refused (`mcp_headers_required`) before
  anything is sent. Otherwise an admin, or whoever holds an admin's session, could point a server at an address of their
  own and have Pikibun send it the stored key, which nobody can read back any other way. A `url` equal to the stored
  one is no change. The rule holds for servers without stored headers too, so it is one rule.
- **Read-only is decided by the workspace, not the server.** `readOnlyHint` is ignored; a tool is read-only only if an
  owner or admin listed it, and any other tool is refused for a Read-only message's admission.
- **Untrusted schemas and answers are bounded.** Input schemas are sanitized to a small keyword set with size, depth and
  property limits and no references; arguments are validated in the session and on the Pikibun server; answers are capped
  at 1 MB and results at 64 KB of text; non-text content is left out.

What it doesn't protect against: a server the workspace chose can return misleading text (the model is told to treat it
as information), and it sees the arguments the model sends it.

## Sandboxed auto-cached workspace extensions

`apps/runner/src/extensions/cache.ts` (`ExtensionCache`, `sandboxExtensionInstaller`, `helperExtensionInstaller`,
`verifyCachedNpmTree`), `host.ts` (`ensureCached`, `peekCached`), `apps/server/src/npm-registry.ts`; the plan is
[Decoupling extensions from connectors](extension-planes.md) (#438). On a Linux or macOS sandboxed host (by default since
phase 2; its owner turns it off with `pikibun connect --no-auto-cache-extensions`, which wins, or `PATCH
/api/connectors/:id/extensions` with `{ autoCache: false }`), a sandboxed session fetches and caches an enabled `npm:<package>@<version>` workspace extension on demand without a
per-connector install request. What bounds that:

- **Two parties lock the package.** When a workspace adds an `npm:` extension, the Pikibun server fetches its manifest
  from `https://registry.npmjs.org` (`redirect: "error"`, bounded size and time) and locks `dist.integrity` (`sha512-...`)
  on `workspace_extensions.integrity` (dropping any unverified client-supplied digest when the registry can't be
  reached); once set for `(workspace_id, source)`, SQL keeps that digest until `source` changes, and a conflicting
  digest is refused (`409 integrity_mismatch`).
- **Registry metadata isn't taken from hosts.** Shared rows in `extension_descriptions` hold only `{ name, version, description }`
  fetched and verified against `dist.integrity` by the Pikibun server itself from `https://registry.npmjs.org`; dynamic
  `modules` summaries reported by connectors stay scoped to each workspace's own shared hosts (`connector_extensions`).
- **Provisioning runs inside an OS sandbox behind a `registry.npmjs.org`-only proxy.** `npm install` runs in a dedicated
  `Sandbox` (Linux) or `SeatbeltBackend` (macOS) with its own empty home, `npm_config_userconfig=/dev/null`,
  `npm_config_globalconfig=/dev/null` (and their uppercase counterparts), `npm_config_allow_git=none`, `--ignore-scripts`
  and `--registry=https://registry.npmjs.org`, behind a local `EgressProxy` whose fixed allowlist admits HTTPS `CONNECT`
  to `registry.npmjs.org` alone (`packageRegistries: false`, checked against `non-public-addresses.ts`). So neither
  `~/.npmrc` nor `$PREFIX/etc/npmrc` sends a host token, and a direct tarball URL, Git URL or redirect to another host
  or private IP is refused before connecting.
- **Tree and lockfile checks, and a sandbox-only describer.** Before staging renames into the 32-hex cache entry,
  `verifyCachedNpmTree` checks that every entry in `package-lock.json` resolved from `https://registry.npmjs.org/`, that
  the root package's version and `integrity` match the workspace's lock, and that the tree holds no hard links, special
  files or symbolic links escaping it. Describing passes `refusingDescribe` as the fallback so it never runs outside the
  sandbox.
- **Plane 3 sessions never read `ExtensionCache`.** `RunnerSession` consults `ExtensionCache` only when the session's own
  extension process runs inside the sandbox (`sandboxedExtensionChannel()`), and `--no-remote-installs` refuses
  auto-caching altogether. Unsandboxed hosts, Windows hosts and on-host sessions run only what the host's owner
  installed in `ExtensionStore`.

What it doesn't protect against: a third-party `npm:` extension's transitive npm dependencies, if specified as version
ranges, resolve from `registry.npmjs.org` when the cache entry is populated and run inside the session's sandboxed
`ProcessChannel` (`MODEL_CALLS_REFUSED`, behind the workspace's egress proxy), with the same confinement as `pnpm
install` inside the session's worktree.

## Installed extensions and the host's models

`apps/runner/src/extensions/worker.ts` (`describedRegistry`, `modelDescription`), `adapter.ts` (`SessionExtensions.channel`);
the plan is [extension isolation](extension-isolation.md). Pi gives an extension the agent's model registry, which
calls models and hands out keys with the host owner's provider accounts. On a shared host that let any installed
extension, chosen by a workspace, spend the owner's accounts or read their keys for any member's session.

- **Installed extensions get descriptions.** Every source that isn't built into the connector (the store's, and
  managed packages) gets a registry that finds and lists the host's models, without their `headers`, and refuses every
  other method, `streamSimple` and `getApiKeyForProvider` among them, with `MODEL_CALLS_REFUSED`. Its `ctx.model` is a
  description too.
- **The connector's own extensions keep the registry.** The prompt audit's bundled copy calls a model on purpose, with
  the owner's account, reviewed and released with the connector.
- **A pinned prompt audit asks the connector, and never holds a key** (#438 phase 4; `apps/runner/src/extensions/complete.ts`,
  `process.ts` `#answerAsk`, `worker.ts` `streamOver`). A managed `@pikibun/pi-prompt-audit` runs in a process of its own,
  started by the connector outside the session's sandbox, so the agent it audits can't reach it. Its registry's
  `streamSimple` sends a `complete` request (user messages, a system prompt, a model by provider and id) over the
  process's channel; the connector checks that the source is in `modelCallSources` and was opened with `modelCalls` in
  that very process, calls the model with its own registry (at most 4,096 tokens, 60 seconds, 4 calls at once), and
  answers text only. Keys, `models.json` headers and the model's thinking never cross. Any other source, or a request it
  can't parse, is refused and logged. The pin itself is checked as every managed package is (digest, scope, versions only
  go up).
- **A required extension calls models only where the host's owner said so.** `allowModelCalls` is owner-only host
  configuration, confirmed in the UI with what it costs; the connector re-reads it on every call, and such an extension
  still runs where installed extensions run (the session's sandbox where there is one), so it gets model answers, never
  keys or the host's files.
- **The boundary is the child process's.** Requests to those sources cross as JSON already, so what they can reach
  through Pi's API now is what they will reach from their own process.

What it doesn't protect against: in a sandboxed session on Linux or macOS the extension process runs in the session's sandbox,
with only the connector's code and its extensions' installs mounted, read-only, and the workspace's network access.
On Windows, in sessions on the host and on unsandboxed hosts, it still runs as the host's user and can read
Pi's `auth.json` and `models.json` itself; there this closes the door Pi's API opened, not the file system's.

The mounts are the host's own paths, so a mount names nothing the sandbox lacks: `serviceBindAllowed` refuses system
directories, the home directory and its parents, `/tmp` and the other trees the sandbox makes itself, and the session's
own files, and the connector reaches the process only through a socket it has checked and pinned.

The connector never imports an installed extension itself: to list its tools it asks an extension process, sandboxed
where the host has the Linux or the macOS sandbox, and checks the answer ([extension isolation](extension-isolation.md), "Describing
an extension"). A plain extension process starts without the connector's own environment variables.

Because the process is confined like the session's commands, a tool of such an extension runs for any message that may
act, without a host command grant: it reaches nothing a shell command of that message couldn't. Where shell commands
themselves count as host commands (no resource limits, someone else's session), so do these calls.

## Slash commands the host runs

`apps/runner/src/session/commands.ts`, `RunQueue.screen`, `SessionPiki.requireCommand`; the design is
[slash commands](slash-commands.md#commands-the-host-runs). A message whose first word names a command is handled by
the host instead of going to the model.

- **A command is a message.** It arrives through the route, the permission and the audit of any message, so nothing
  new can ask a host to act. What the host does with it is decided on the host, from the session's own state: the
  client's list is only a menu.
- **An extension's command runs under the rule of its tools.** A handler is the extension's code, acting for whoever
  typed the command, with their arguments. It runs for any sender where the extension's process is in the session's
  sandbox, and otherwise only for the host's owner and members they granted host commands, or where the host's owner
  lets extension tools run for every session; the refusal says which (`requireCommand` and `#runTool` share one rule, `#extensionMayRun`, and take "in the sandbox" from the channel that runs the source). Unlike a tool
  call it isn't a card: no model chose it, the person typed it.
- **Acting commands need a message that may act.** `/compact` and extension commands are refused in a side ask and in a
  Read-only message, as an extension's tools are. Templates and skills only replace the message's text, so they pass:
  the message still runs with the tools it had.
- **Templates and skills are read as the session reads files.** The host finds and reads them with the session's file
  access (in the sandbox, its helper), never by opening worktree paths in the connector, so a link out of the worktree
  is refused as it is for `read`. They are any file of the worktree in those places, committed or not: written by
  whoever can push to a clone, but also by the session's own commands, and at the worktree's root, which no repository
  owns. They reach the model only when someone types their name, and an expanded one passes the `input` handlers again
  (review 380, finding 48). The one exception is the workspace's choice: with `piki:skills` on, each listed skill's name,
  description and path reach the system prompt with no name typed, from any clone, a public one cloned to read included,
  and the agent is told to follow a skill it loads; so it is off until an owner or admin adds it, as
  `piki:context-files` is for `AGENTS.md`. Each message and side ask reads the switch itself, so turning it off holds from the next one's prompt (what earlier prompts listed stays in the conversation's history, which a side ask shares, as all earlier context does). The list is bounded (100 skills, 200 files read, 1,024 characters a description,
  20,000 for the section), its text is XML-escaped, and it tells the agent a skill widens nothing the session may do
  ([skills](skills.md)). A name that files in two places claim (two clones, or a clone and the worktree's root) is
  offered by neither alone: each is listed as `<clone>:<name>` (`worktree:<name>` at the root), so which file a name
  means never depends on where a directory sorts (review 380, finding 50). A skill's `location` is a worktree path, so the agent opens its other
  files with its own tools and rules. Looking for them asks the Pikibun server nothing: the list is part of a view,
  whose reader was already let in (and which the app reads from its own host without the server), and a command's
  message was authorized when it was sent and is again before it runs.
- **An extension's skills are its own text, copied into the worktree.** An extension's process reads its skills (its
  package's, and the paths its `resources_discover` returns, which may be anywhere that process can read, as its own
  code can read them anyway) and sends their folders' text files, bounded, without links, dot files or binaries. The
  session writes them under `.pikibun/skills` through its own file access, so nothing leaves the worktree, and lists
  them whatever `piki:skills` says: the workspace's owners chose the extension and the host's owner installed it, as
  for its tools and prompt. Anyone who can read the session's files can read the copies, as they can read the
  extension's prompt in the transcript's system message, so an extension mustn't put secrets in a skill.
- **The list is the host's word.** The server passes it through with the view; the client keeps only names of the
  expected shape and bounded text (`parseSessionCommands`), and a name the client has itself always wins, so a
  repository can't take over `/model` or `/new`.

## Password authentication

`apps/server/src/authority/password-auth.ts`, for servers with `PASSWORD_AUTH=true`.

- **Hashing.** scrypt with N=2^15, r=8, p=1 (32 MiB per hash, about 50 to 100 ms of one CPU), a 16-byte salt and a 32-byte key: costly to try offline at scale. Passwords compare as Unicode NFKC, so the same password typed on another keyboard matches; length is bounded before normalizing, which can lengthen text, and judged after it, so a fullwidth copy of the username doesn't pass as a new password.
- **Bounded work.** At most 4 hashes run at once and 64 wait; a flood of sign-ins gets `429 sign_in_busy` rather than starving the server's thread pool. A stored hash's parameters are checked against bounds before use (N a power of two up to 2^17, r up to 16, p up to 4, key 16 to 64 bytes), so a corrupted or planted row can't exhaust memory.
- **No account oracle.** A sign-in for a username nobody has spends a hash's time on a decoy, a malformed username gets the same answer as a wrong password, and only a correct password reveals that an account is suspended.
- **Lockout.** From the sixth failed sign-in in a row the password pauses, for 30 seconds at first, doubling up to 15 minutes. It locks only the password: a GitHub account's recent GitHub sign-in still replaces or removes it, so knowing the username doesn't let anyone keep its owner from getting rid of a password.
- **What stands for the owner.** Setting, changing or removing a GitHub account's password takes the current password or a GitHub sign-in from the last 15 minutes. An older stolen browser session can't add a password to keep its way in, and a wrong current password counts as a failed sign-in.
- **Races.** A sign-in or change completes only while the password it checked is still the account's (a reset that lands while it hashes wins), and replacing a password signs out every other browser and app.

## The self-host sign-in link

`apps/server/src/local/launch.ts`: a Pikibun that runs for its owner alone (`pikibun serve`, the app's self host) signs its owner in with a link, `/api/auth/local?token=…`, that works for whoever opens it (`requireLocalToken` in `authority/auth.ts`).

- **A new token at each start.** The token is 256 random bits made when the server starts, handed to the server as `LOCAL_CLAIM_SECRET`, printed by `pikibun serve` and sent to the app over its stdio pipe, and never written down. A link travels where secrets shouldn't (browser history and its sync, terminal scrollback, screen shares), and before this it was the state file's `claimSecret`, the same at every start with no way to replace it. Now a restart retires every earlier link.
- **What a restart doesn't end.** Sessions already signed in are kept: they are rows of their own, which signing out or a suspension ends as for any account. Retiring a leaked link is a restart; ending what someone already did with it is signing out the other browsers and apps.
- **`claimSecret` stays in the state file, unused,** so an older `pikibun` that opens the same state directory still reads it. It signs nobody in.
- **What stays as it was.** The server listens on loopback only, the comparison is constant-time, a cross-site request is refused (`requireOrigin`), and the token reaches the app only in its status, never in the server's output (`tests/serve-stdio.test.ts`).
- **Sign-in codes there.** The owner has no password and no GitHub sign-in to prove themselves with again, so a code is made by a session that signed in with the link or the app's token itself (`via IS NULL`), and never by one made from a code: one leaked code can't make the next. The session a code makes is the owner's, as the link's are (`method` null), so it goes on when the same data is later shared with `PASSWORD_AUTH` off. The server is on loopback, so a code reaches only apps on the same computer.
- **github.com with a pasted token.** With no OAuth app there is no GitHub sign-in, so the owner connects github.com with a personal access token (`PUT /api/git/accounts/github`, refused outside `LOCAL_MODE`): checked with GitHub's `/user`, kept in `github_tokens` like a sign-in's, and the account takes that GitHub id and login (a GitHub account that owned the server before takes only a token of its own GitHub account). The reads, pull requests and pushes that needed `auth_kind = 'github'` now take a `password` account that has a GitHub id too, which only this route gives. A push with the owner's account can't reset such a token afterwards (that is the OAuth app's call), and here it needn't: the only host is the owner's own computer, where the vault and its key already are. Elsewhere that push is still refused without the app.
- **github.com with the device flow.** `POST /api/git/accounts/github/device` (local mode only) asks GitHub for a device and user code with Pikibun's own OAuth app (`LOCAL_GITHUB_CLIENT_ID`, a public identifier: the device flow takes no client secret, so none ships), and the page shows the user code to enter at github.com/login/device. The device code never leaves the server: it is kept in memory under an id, one waiting per account, until GitHub's expiry, and the page polls that id while the server keeps GitHub's interval (and its `slow_down`). The token GitHub grants is stored exactly as a pasted one, with the same checks. Without the secret the server can neither reset nor revoke it, so it lasts until the owner revokes Pikibun on GitHub, as the page and the docs say. A restart drops a sign-in that was waiting; the owner starts it again.

## Signing in an app with a code

`apps/server/src/authority/app-codes.ts`: a signed-in browser or app makes a one-use code another app exchanges for a session of its own ([Signing in an app with a code](../accounts.md#signing-in-an-app-with-a-code)).

- **What it takes to make one.** The current password, or a GitHub sign-in from the last 15 minutes, as setting a password does. A browser session lasts 7 days and an app's 30, so without it a stolen browser session could turn itself into a longer one that outlives the browser's sign-out.
- **Never recent itself.** A session made from a code is marked `via = 'code'` and never counts as a recent GitHub sign-in, so one code can't make the next, nor set a password, without the owner.
- **Bounded.** 256 random bits, kept only as their SHA-256 hash, used once, for 10 minutes, at most 5 waiting per person (a bound against codes piling up, checked in the insert itself; two made at the same instant on Postgres may make it 6). Guessing one is out of reach, so the exchange needs no lockout.
- **Used only with its session.** The exchange checks the account first, then claims the code (a conditional `UPDATE`) and creates the app's session (`WHERE changes() = 1`) in one batch: a refused or failed exchange leaves the code unused and names no app, and two exchanges of one code at once sign in one app.
- **Tied to its maker.** The code references the session that made it (`ON DELETE CASCADE`), and the exchange checks that session is still live: signing it out, a password change or reset, or a suspension ends it. The app session keeps the maker's method (`'password'` if made from a password sign-in or with the password typed), so turning `PASSWORD_AUTH` off ends it with the others.
- **Asked, not followed.** A `pikibun://auth/code` link names its server, and anyone can send one. The app never signs in from a link it is handed: it fills in the code and asks, naming the server, so a link can't quietly sign it in to someone else's account or server.
- **Audited.** `account.app_code.created` and `account.app_code.used` (with the app's name) go to the audit log.

## Portable sessions

A private session can be attached to whichever server its owner's identity is paired with ([design](portable-sessions.md)). What keeps that safe:

- **The key never leaves the computer.** It is kept `0600` in a `0700` directory, and only its public half and the statements it signs reach a server. An exported copy is encrypted with the owner's passphrase (scrypt, AES-256-GCM).
- **Delegation rides on pairing.** A host signs a delegation only for its own pairing, which its machine's user made with a code from that account. A server accepts one only for its own origin and from the connector it names, authenticated.
- **The host decides.** It attaches only for its pairing's owner, and only sessions marked by its current key; a server can't attach a session to another account, or take one away.
- **One writer at a time.** An open lease per session keeps two connections of the computer out of one session's database, and attaching rewrites its pinned Git identity and stored binding only while it holds the lease and the session is idle.
- **Settings can't be forged.** A server applies the private workspace's settings only signed by the identity, at a newer version than it applied.
- **Not covered:** the server a session is attached to signs its users in, so it can still act as their account there.

## Private sessions forwarded to their computer

New private sessions live on their computer's own Pikibun, and other servers forward requests to it ([design](local-private-sessions.md)). What keeps that safe:

- **Only the owner's own connection carries them.** A forwarded request rides the relay as a `private` ticket, which the authority allows only for the connector's owner, on a connector that says it forwards, from its current connection (`authorizePrivateTicket`); the connector refuses any other actor.
- **A named list, checked twice.** Only the routes `privateRoute` lists, with a plain query, are forwarded: the connector checks the request, and the computer's Pikibun checks it again. Share links, session roles, backups, moves and every account or workspace route are refused before they reach the computer.
- **The computer's Pikibun takes it only with its secret.** The secret is made at each start and written only to `local.json` in its `0700` state directory (`0600`), so only its OS user reads it, as with the identity key. With it, a request acts as the local server's owner, and only on a session of its private workspace (`forwardedOwner`).
- **The other server holds no credential of the session's**, nor any of its conversation: only the records it lists, checked field by field. Revoking the computer there ends its access.
- **Not covered:** the other server signs its users in, so while the computer is connected to it, it can act as the owner on these sessions, as any server can for sessions attached to it.

## Single instance

The server holds a database lock while it runs ([One server per database](../self-hosting.md#one-server-per-database)): live state (connected hosts, requests in flight, live updates, the password hashing queue) is in memory, and a second server would split it. On Postgres the lock lives on a connection of its own, which the server keeps watching (`apps/server/src/db/instance-lock.ts`): if that connection drops it takes the lock again, and if another server got it first, or the database stays unreachable for a minute, it stops rather than run beside it.

## Host build caches

`packages/shared/src/build-caches.ts` (`buildCacheScope`), `apps/server/src/build-caches.ts`, `apps/runner/src/build-caches.ts`, `build-cache-janitor.ts`; the design is [build-caches.md](build-caches.md). A build cache is a directory several sessions write, named by its inputs, so nobody can check what is in it.

- **Only people who can already change each other's sessions write one copy.** The workspace owner, admins and collaborators whose tool group has `write` share the workspace's copy: each of them can already send any session of the workspace a message that writes files there. Everyone else writes and reads only their own copy. Writer groups narrow this and never widen it, and a writer group that was deleted leaves the cache to the workspace owner rather than to everyone. The rule runs on the Pikibun server, which answers the host per session; a host in `owner` mode shares nothing, and the host asks again every 30 seconds, keeping an answer it couldn't renew for 5 minutes at most.
- **Only sandboxed commands see a cache.** Sessions on the host get none, since a link a sandboxed writer left would be followed there. Read-only steps get it read-only. A cache's variable never replaces one the sandbox sets, and names the sandbox or the tools rely on (`PATH`, `HOME`, `LD_*`, `DYLD_*`, `PYTHON*`, `NODE_OPTIONS`, `GIT_*`, the proxy and CA variables, `SANDBOX_*`, ...) are refused when the cache is declared.
- **The host never follows what a session left.** The host-only levels above a cache are checked as directories, not links, before each mount; listing, pruning and eviction open each level with `O_NOFOLLOW` relative to its parent's descriptor and unlink relative to the directory's, so a directory a session swapped for a link mid-walk is skipped, never followed.
- **The disk stays bounded.** A writable cache lies outside the session's own bounded filesystem, so a connector with `--resources` keeps caches only on a dedicated filesystem (`--build-caches PATH`) the resource supervisor checks as it checks session volumes; elsewhere commands run only for the host's owner and the members they granted host commands, and the host evicts above its size limit.
