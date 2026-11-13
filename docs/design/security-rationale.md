# Security rationale

The source code has no comments (see [Comments](../development.md#comments)), so the reasons behind security decisions are written here, beside the design notes that cover their own areas: the session proxy in [egress.md](egress.md), the Windows sandbox in [windows-sandbox.md](windows-sandbox.md), who may do what in [authority.md](authority.md), and workarounds for dependencies in [upstream-workarounds.md](upstream-workarounds.md). Change this file in the same pull request as the code it explains.

## Content Security Policy

`apps/server/src/static.ts` (`pageContentSecurityPolicy`) sets the policy of the client's page; `apps/server/src/index.ts` sets a stricter one (`script-src 'self'`) on everything else the server answers. `tests/static.test.ts` pins the page's.

- **`script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'`.** Native Shell's web runtime (0.4 and 0.5) compiles WebAssembly, which needs `'wasm-unsafe-eval'` (not `'unsafe-eval'`, so JavaScript `eval` stays off). It builds the app's `nsh` modules as `blob:` URLs and maps them with an inline `<script type="importmap">` it inserts, whose content changes on every load, so no hash can allow it. `'unsafe-inline'` does. A hash or nonce in the list would switch `'unsafe-inline'` off again, and the runtime sets no nonce on the map, so the policy can't name one. Scripts still come only from this server and the runtime's own blobs.
- **What stands in for it.** With inline scripts allowed, the policy doesn't stop injected markup from running, so no text may reach the page as HTML. The client renders transcript text, tool output and Markdown through Native Shell's components, which put text in the page as text. `tests/transcript-html.test.ts` fails if anything the client ships, or the code the build adds to the runtime, uses an HTML sink (`innerHTML`, `insertAdjacentHTML`, `DOMParser`, `document.write` and the like) or runs text as code (`eval`, `new Function`, `javascript:` URLs).
- **`connect-src 'self' blob: data:`.** Requests go only to this server; the runtime reads its own blobs (a pasted image, a picked photo) with `fetch`.
- **`frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`.** No framing, no `<base>` pointing elsewhere, no form posts or plugins to other origins.
- **Removing `'unsafe-inline'`** needs the runtime to take a nonce for the import map it inserts; it is on the [list of upstream workarounds](upstream-workarounds.md).

## Linux sandbox

`apps/runner/src/sandbox.ts` runs every step of a sandboxed session (file tools, Git, shell commands) in bubblewrap, as `python3 -I -c HELPER` (`apps/runner/src/sandbox-python/helper.py`): all untrusted file system access happens in the helper, after it has entered the namespaces. There is no fallback to the host's shell, Git or file system.

- **Namespaces and privileges.** `--unshare-all --unshare-user --disable-userns`: new user, mount, PID, IPC, UTS, cgroup and network namespaces, and no further user namespaces inside (which would let a command build its own mounts). `--cap-drop ALL`, `--new-session` (no `TIOCSTI` into the connector's terminal) and `--die-with-parent`.
- **What is mounted.** `/usr`, `/lib` and `/lib64` read-only; the session's home, worktree, its `.git` and its Git configuration by file descriptors the connector opened (`--bind-fd`, `--ro-bind-fd`), so a symlink or rename between checking a path and mounting it can't redirect the mount. The `.git` directory is writable only in the workspace's own Git steps, and the session's Git configuration (`.gitconfig`, made once by the connector and checked unchanged at every open) is always read-only, so no command can change how Git runs for the session's later steps. Finally `/`, `/proc` and `/dev` are remounted read-only.
- **Its own `/etc`.** None of the host's `/etc` is mounted. Programs that look their user up (`initdb`, `ssh`, Node.js's `os.userInfo()`, Python's `getpass`) need a user, and tests and servers that name `localhost` need it to resolve, so the connector writes the session's own `passwd`, `group`, `hosts` and `nsswitch.conf` (`sandboxEtc`) beside its mounts at every open and mounts them read-only at `/etc`. They name a `pikibun` user with the connector's uid and gid and the session's home, `root` and `nobody`, and `localhost` as the loopback addresses: nothing of the host's users or names.
- **Environment.** `--clearenv`, then only what the connector sets: nothing of the connector's environment (tokens, `SSH_AUTH_SOCK`, the host user's paths) is inherited.
- **Network.** Only shell commands, and clone restores, get the network: the session proxy's Unix socket, read-only at `EGRESS_SOCKET`, which the helper relays to a loopback port inside the namespace, and the host's CA bundle at `CA_BUNDLE`. The network namespace has no other way out, so a command that ignores the proxy settings only fails. What the proxy lets through is in [egress.md](egress.md).
- **Helpers out of the session's reach.** The `git` shim, the browser tool's driver and the session service's driver are written afresh at every open, beside the session's mounts and read-only inside, so nothing the session runs can replace them for a later command.
- **Resources.** Shell commands run under a resource supervisor that alone holds the root descriptor and a liveness pipe, which it closes before starting bubblewrap. It is never sent `SIGKILL`: it keeps its lock until the command's whole cgroup is killed and empty, and watches its parent and its own deadline. A command stopped while it waited for the sandbox never starts, and a permission revoked while it waited is checked again just before it runs.
- **What it leaves to the host.** The host's GPU render device only where its owner lends it, and the connector's Node.js and the host's Chromium read-only where `/usr` doesn't already hold them.

## macOS sandbox (Seatbelt)

`apps/runner/src/seatbelt.ts` runs the same helper under `sandbox-exec` with a profile made for each step. Unlike bubblewrap there are no mounts: the session's files are used where they are, and the profile decides what a step may reach.

- **Reads are denied by default.** A step sees its own home and worktree, its Git directory, the CA bundle and the system's read-only runtime (system binaries and libraries, the selected developer tools, Homebrew and the toolchains below `/usr/local` that `SEATBELT_LOCAL_ROOTS` lists), and nothing of the host user's home, other sessions or the connector's state. Path resolution may read the metadata of every ancestor, never their contents.
- **Writes** go only to the session's home and worktree, and to its Git directory only in the workspace's own Git steps. Last in the profile, so they win (Seatbelt applies the last matching rule), the denies cover the worktree's pointer to the Git directory, and the Git directory itself outside Git steps.
- **Paths are parameters.** Every path goes into the profile as a parameter (`-D NAME=path`), never spliced into its text, so no path can change what the profile means.
- **The network is the session proxy only:** outbound connections to its loopback port. Seatbelt's `localhost` rule also covers the host's other addresses on that port, so the proxy requires the session's token on every request (sent as proxy credentials, `pikibun:<token>`), and neither another session nor another program on the host can use it. No other loopback port is reachable, so tests that start a local server fail on this backend.
- **No trustd.** `com.apple.trustd.agent` fetches the AIA, OCSP and CRL addresses a certificate names on the host's own network, outside the proxy, so a step could send data the network policy refuses. It is denied; Go and Swift, which verify TLS only through it on macOS, can't make HTTPS connections here (curl, Git, Node and Python use the session's CA bundle).
- **Processes** inherit the profile and may signal and inspect only each other. The machine's own sysctls are allowed, never `kern.procargs`, which shows other processes' environments.
- **Only the system's `sandbox-exec`**, never one found on `PATH`. It is deprecated in Apple's headers but still ships, and Chromium and others depend on it.
- **No hard memory or process limits** (macOS has no cgroups), so shell commands run there only where the host's owner allows commands without them.

## Sessions on the host

In the private workspace, **Where it runs** starts on the host for the host's owner (#259): the session's commands run as the owner, with their files, credentials and network, and since approvals were removed (#271) nothing asks before they run. That is a product decision, not a gap in the code, and it rests on these:

- **Only the host's owner, and members they grant host commands.** Everyone else's calls to anything that runs on the host's own machine are refused, on the host (`HOST_COMMANDS_RULE` in `apps/runner/src/session.ts`) and by the server.
- **It is chosen visibly and recorded.** The new-session screen shows a red **On host** chip and a warning while it is chosen, and the choice is audited with the session (`hostEnvironment`).
- **Read only** changes nothing on the host either.

What it doesn't protect against: text the agent reads (a repository's files, a web page, a cloned repository's `AGENTS.md` through `extensions/context-files`) can steer what it runs, and on the host that runs as the owner. Use **Where it runs → Sandbox** for work on code or pages you don't trust. Extensions run in the connector process, on the host, for every session (`apps/runner/src/extensions/`), so a workspace's extensions are trusted code whichever environment a session uses.

## Whose tools a message runs

A session's tools run as its owner (their Git accounts, their GitHub token), for anyone who may send it messages: collaborators on every workspace-visible session, members with a session role of Collaborator, and the workspace's owner and admins on every session. Checked against the owner's tool group alone, that let anyone use the owner's tools by writing in their session: a collaborator, whose role leaves out `github_merge`, could have an admin's session merge a pull request as the admin, and a member could push to other branches and comment on GitHub through a session whose owner may. So a call is checked against both groups, the owner's and the message's sender's (`requireSessionTool` in `apps/server/src/authority/tool-groups.ts` for what Pikibun brokers; `sessionToolsOff` and `requireSenderTool` in `apps/runner/src/session/availability.ts` on the host):

- **The sender is the message's.** Brokered calls name the admission's actor, which the broker already checks is the message's sender; on the host it is the run's `initiatedBy`. Scheduled prompts are sent as the owner, so they run with the owner's group alone; a message the sessions tool delivers is sent as the person whose message made the call.
- **Hidden, then refused.** A message isn't offered the tools its sender's group leaves out, so the agent doesn't plan around them, and a call made anyway (say, the group changed while the message ran) is refused before it runs. Side asks run only read tools and aren't checked against groups, as before.
- **Stopping isn't gated.** Taking a tunnel offline needs no `tunnel`: anyone who may write to a session may stop its work.

What it doesn't protect against: the conversation is shared. A sender can leave instructions in it, or in the files, that the agent follows on the owner's next message, with the owner's tools. That is the same as any text the agent reads (see [Sessions on the host](#sessions-on-the-host)); where it matters, keep sessions that hold tools others lack private, or give people a session role of Member (side asks only).

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
  (`PikiExtension.managed`: `pr-flow`, `context-files`) or names one it doesn't know. The extensions that run a forge's
  command with the host's sign-in, switch the session's own tools, or call a model with the host's keys (the prompt
  audit) are connector code, and a pin for one is ignored.
- **The host's owner decides.** It is off unless the connector starts with `--managed-extensions`, and
  `--no-remote-installs` refuses it as it refuses every install asked for in Pikibun. A connector run from source never
  uses pins.
- **Versions only go up.** A host runs the newest of the pinned package, the newest managed version it has run before
  and its bundled copy (whose version is the committed one, which the extension release must publish), and installs a
  pin only when it would run. So neither a mistaken pin nor a compromised control plane takes a host back to an older
  version, with whatever that version got wrong.
- **A failed pin runs nothing.** A package that fails a check is deleted; the host runs what it ran before, so a
  registry that is down or a bad pin can't stop a host that requires one of them.

What it doesn't protect against: like every extension today, a managed package runs in the connector's process, as the
host's user, outside the sandbox ([extension isolation](extension-isolation.md)), and a version reaches every host that
opted in within a sync. That is why it is opt-in until extensions run in a process of their own.

## Password authentication

`apps/server/src/authority/password-auth.ts`, for servers with `PASSWORD_AUTH=true`.

- **Hashing.** scrypt with N=2^15, r=8, p=1 (32 MiB per hash, about 50 to 100 ms of one CPU), a 16-byte salt and a 32-byte key: costly to try offline at scale. Passwords compare as Unicode NFKC, so the same password typed on another keyboard matches; length is bounded before normalizing, which can lengthen text, and judged after it, so a fullwidth copy of the username doesn't pass as a new password.
- **Bounded work.** At most 4 hashes run at once and 64 wait; a flood of sign-ins gets `429 sign_in_busy` rather than starving the server's thread pool. A stored hash's parameters are checked against bounds before use (N a power of two up to 2^17, r up to 16, p up to 4, key 16 to 64 bytes), so a corrupted or planted row can't exhaust memory.
- **No account oracle.** A sign-in for a username nobody has spends a hash's time on a decoy, a malformed username gets the same answer as a wrong password, and only a correct password reveals that an account is suspended.
- **Lockout.** From the sixth failed sign-in in a row the password pauses, for 30 seconds at first, doubling up to 15 minutes. It locks only the password: a GitHub account's recent GitHub sign-in still replaces or removes it, so knowing the username doesn't let anyone keep its owner from getting rid of a password.
- **What stands for the owner.** Setting, changing or removing a GitHub account's password takes the current password or a GitHub sign-in from the last 15 minutes. An older stolen browser session can't add a password to keep its way in, and a wrong current password counts as a failed sign-in.
- **Races.** A sign-in or change completes only while the password it checked is still the account's (a reset that lands while it hashes wins), and replacing a password signs out every other browser and app.

## Signing in an app with a code

`apps/server/src/authority/app-codes.ts`: a signed-in browser or app makes a one-use code another app exchanges for a session of its own ([Signing in an app with a code](../accounts.md#signing-in-an-app-with-a-code)).

- **What it takes to make one.** The current password, or a GitHub sign-in from the last 15 minutes, as setting a password does. A browser session lasts 7 days and an app's 30, so without it a stolen browser session could turn itself into a longer one that outlives the browser's sign-out.
- **Never recent itself.** A session made from a code is marked `via = 'code'` and never counts as a recent GitHub sign-in, so one code can't make the next, nor set a password, without the owner.
- **Bounded.** 256 random bits, kept only as their SHA-256 hash, used once, for 10 minutes, at most 5 waiting per person (a bound against codes piling up, checked in the insert itself; two made at the same instant on Postgres may make it 6). Guessing one is out of reach, so the exchange needs no lockout.
- **Used only with its session.** The exchange checks the account first, then claims the code (a conditional `UPDATE`) and creates the app's session (`WHERE changes() = 1`) in one batch: a refused or failed exchange leaves the code unused and names no app, and two exchanges of one code at once sign in one app.
- **Tied to its maker.** The code references the session that made it (`ON DELETE CASCADE`), and the exchange checks that session is still live: signing it out, a password change or reset, or a suspension ends it. The app session keeps the maker's method (`'password'` if made from a password sign-in or with the password typed), so turning `PASSWORD_AUTH` off ends it with the others.
- **Asked, not followed.** A `pikibun://auth/code` link names its server, and anyone can send one. The app never signs in from a link it is handed: it fills in the code and asks, naming the server, so a link can't quietly sign it in to someone else's account or server.
- **Audited.** `account.app_code.created` and `account.app_code.used` (with the app's name) go to the audit log.

## Single instance

The server holds a database lock while it runs ([One server per database](../self-hosting.md#one-server-per-database)): live state (connected hosts, requests in flight, live updates, the password hashing queue) is in memory, and a second server would split it. On Postgres the lock lives on a connection of its own, which the server keeps watching (`apps/server/src/db/instance-lock.ts`): if that connection drops it takes the lock again, and if another server got it first, or the database stays unreachable for a minute, it stops rather than run beside it.
