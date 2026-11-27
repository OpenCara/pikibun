# Design: forge access with the session owner's account on the host

Status: implemented (see Plan below). Tracking issue: #554.

## Problem

A sandboxed session reaches forges only through its egress proxy ([egress.md](egress.md)), which reads the workspace's
repositories with the session owner's access, pushes the session branch with the workspace's push identity and gives the
CLI tools the owner's API access behind a placeholder token. A session that runs on the host
([hosts.md](../hosts.md#sessions-on-the-host)) had none of that: its Git used the host's credential helpers, `git_push`
wasn't offered (it needs the proxy), and `gh`, `glab` and `az` ran with the host's own sign-in (`hostSignIn: onHost`).
So such a session acted as whoever was signed in on the machine, with long-lived credentials that usually reach far more
than the workspace's repositories. A member's session there had no credentials at all, since it gets an isolated
environment.

## Decisions

- **The account follows the environment.** A session on the host runs in the host owner's environment only when it is the
  owner's own (`hostOwnersSession`); a member's runs in an isolated one, without the owner's `HOME`, credential helpers or
  `GH_TOKEN`. So a member's clone session always gets their own Pikibun account: that adds the workspace's repositories,
  as the member, and takes nothing away. The host owner's own sessions keep the host's credentials unless the owner turns
  on `HostConfig.ownerForgeAccess` (**Pikibun account on the host**, owner-only, off by default), so existing setups
  don't change under anyone. The session's creator doesn't choose.
- **Layer, don't replace.** Pikibun's account serves the workspace's repositories; the host's credentials still serve
  everything else. Git gets `url.<proxy>/git/<host>/<path>.insteadOf` only for each workspace repository's
  `https://<host>/<path>` (and, on the forges that take SSH, `git@<host>:<path>` and `ssh://git@<host>/<path>`), through
  `GIT_CONFIG_COUNT` in the environment of the session's commands, never in a file. Other remotes reach their server
  directly and ask the host's credential helpers, as before. `insteadOf` matches prefixes, so `https://github.com/o/app`
  also catches `https://github.com/o/app-other`; the unconfined proxy answers a reference listing of a repository that
  isn't the workspace's, for a fetch or a push, with a redirect to its real URL, where Git then asks the host's credential
  helpers, so such a repository still reads and pushes as before. The remote's URL in `.git/config` stays the forge's: only Git's runtime view is rewritten.
- **One proxy, unconfined.** The proxy is the sandbox's `EgressProxy`, listening on the host's loopback with a token
  (`tcp`), as the macOS and Windows sandboxes use it, plus `unconfined`: a host session's network isn't confined, so the
  workspace's network policy doesn't apply to it. Tunnels to hosts other than the credentialed APIs go out on the host's own
  network and DNS (`#passThrough`), and a repository outside the workspace is never read by the proxy itself (no
  `publicGitRemote`), only redirected. That keeps, for example, `gh run view --log` (redirected to blob storage) working as
  it did with the host's sign-in.
- **Writes as in the sandbox.** A `git push` through the proxy goes only to the session branch, with the workspace's push
  identity, through the control plane's session-branch relay. Other branches and tags are refused there (the proxy is
  `sessionBranch`-scoped). API writes from the CLI tools need an approved call's write lease (`apiLease`), as in the sandbox.
- **The CLI tools.** Where the proxy applies, `hostSignIn` is false, decided per call (it depends on the host's
  configuration, which can change), and the tools run through `SessionPiki`'s `#runCommand` on the host workspace with
  `hostForgeApiEnvironment`: `HTTPS_PROXY` with the token, the placeholder tokens, and the CA bundle variables naming
  `forge-ca.pem` in the session's directory, the host's trusted certificates plus the proxy's interception authority
  (`sandboxCertificates`). Since step 3, every command gets the same environment. A read-only run can't use the host workspace's read-only mode, which refuses commands; the
  proxy still refuses its writes, since a read-only run never gets a lease, and the tool's own rules refuse writing
  commands.
- **Failure.** If the proxy or the grant can't be had for a command, the command runs without the rewrites (the host's
  Git, as before) rather than not at all; a CLI tool's run refuses instead, since it would otherwise go out with the host's
  sign-in in a session that shouldn't use it: only a definite "doesn't apply" (the setting off, the session closing)
  means the host's sign-in, and a failure to set the proxy up is an error the tool reports.
- **Who can reach the proxy.** Its token is in the session's commands' environment and in the rewritten URLs Git may print
  (`git remote get-url`, errors), as in the sandbox. Another process of the same OS user could use it while the session is
  open; that user can already read the session's files and the host's credentials, so this grants nothing beyond what
  the session's own commands have. It never carries a credential itself.

## Plan

All implemented (#556, #558) but the last step, which was decided against for now.

1. **Git and the CLI tools through a per-session proxy**: the proxy (`#forge` in `session.ts`) for clone sessions on the
   host; `HostWorkspaceOptions.forgeEnvironment` adds `hostForgeEnvironment` to each command; `gh`, `glab` and `az`
   through it; `HostConfig.ownerForgeAccess`.
2. **`git_push` on the host.** `HostWorkspace` implements `cloneHead`, `clonePushPrepare` and `clonePushPack` (the
   node helper's steps, with the host's Git, hardened as the helper's: no hooks, fsmonitor, credential helper or SSH, no
   global or system configuration, `--git-dir` of a clone the worktree holds, not a link), and `pushWorkspace` takes any
   workspace that has them. The runner fetches the credential per push and speaks to the forge itself
   (`performClonePush`), so it never enters a command's environment or the clone's configuration. Every clone session on the
   host offers it, whichever credentials its Git uses: it pushes with the workspace's push access, as in the sandbox, and the
   session instructions describe it for both kinds of session (`gitPushInstructions`).
3. **Every command.** `forgeEnvironment` adds `hostForgeApiEnvironment` to every command: `HTTPS_PROXY` (no
   `HTTP_PROXY`: plain HTTP stays the host's), the placeholder tokens, and the CA variables naming `forge-ca.pem`, now the
   host's store, the proxy's authority and any certificates in the bundles those variables already named
   (`hostSessionCertificates`), so a corporate bundle stays trusted. `NO_PROXY` keeps the host's own entries. An
   unconfined proxy tunnels any host and any port, except the credentialed APIs on 443, straight through (`#passThrough`),
   and its `ApiAccess` sees an open policy, so a request carrying its own credential (Git to gitlab.com with the host's
   helper) goes on. Where the host's environment already names a proxy (`proxyConfigured`), commands keep it: chaining
   through the host's proxy isn't done, so only Git's rewrites and the CLI tools use Pikibun's there.
4. **Repository cache.** `SessionMirrors`' `ownerFill` fills the mirror through the relay (the owner's access, or the
   workspace's connection, through direct grants where the server gives them) instead of the host's credential helpers,
   for host sessions the proxy applies to. The owner check before borrowing is unchanged.
5. **Visibility.** `identity` returns `forgeAccess` (`owner` or `host`) with a note; the session view carries
   `forgeAccess` for clone sessions on the host, as the setting stands when it is read, and the session panel shows it.
6. **Not done, by decision:**
   - *GitHub Packages and ghcr.io.* They accept only a classic personal access token (or Actions' `GITHUB_TOKEN`); GitHub
     App installation tokens and fine-grained tokens are refused. Pikibun holds neither kind, and a classic token reaches
     every repository its owner can, which Pikibun's push and read rules can't limit. Those registries' hosts pass through the
     proxy untouched, so the host's own sign-ins (`~/.npmrc`, `docker login`) keep working. Doing better needs a new kind of
     account credential, a product decision of its own.
   - *Default for the owner's own sessions.* Stays off. Turning it on by default would change, without asking, which
     account every existing host owner's sessions act as; it is worth doing once the setting has been used for a while.
