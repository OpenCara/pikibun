# Design: forge access with the session owner's account on the host

Status: phase 1 implemented (Git and `gh`/`glab`/`az` through a per-session proxy). Tracking issue: #554.

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
  also catches `https://github.com/o/app-other`; the proxy answers a reference listing of a repository that isn't the
  workspace's with a redirect to its real URL, where Git then asks the host's credential helpers, so such a repository
  still reads as before. The remote's URL in `.git/config` stays the forge's: only Git's runtime view is rewritten.
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
  (`sandboxCertificates`). Only these runs get `HTTPS_PROXY` and the bundle; other commands keep the host's network and
  certificates (see phase 3). A read-only run can't use the host workspace's read-only mode, which refuses commands; the
  proxy still refuses its writes, since a read-only run never gets a lease, and the tool's own rules refuse writing
  commands.
- **Failure.** If the proxy or the grant can't be had for a command, the command runs without the rewrites (the host's
  Git, as before) rather than not at all; a CLI tool's run refuses instead, since it would otherwise go out with the host's
  sign-in in a session that shouldn't use it.
- **Who can reach the proxy.** Its token is in the session's commands' environment and in the rewritten URLs Git may print
  (`git remote get-url`, errors), as in the sandbox. Another process of the same OS user could use it while the session is
  open; that user can already read the session's files and the host's credentials, so this grants nothing beyond what
  the session's own commands have. It never carries a credential itself.

## Plan

1. **Git and the CLI tools through a per-session proxy** (this change): the proxy (`#forge` in `session.ts`) for clone
   sessions on the host; `HostWorkspaceOptions.forgeEnvironment` adds `hostForgeEnvironment` to each command; `gh`,
   `glab` and `az` through it; `HostConfig.ownerForgeAccess`.
2. **`git_push` on the host**, run by the runner so the token never enters the session's processes; then one set of session
   instructions for both kinds of session.
3. **Every command**: `HTTPS_PROXY` and the CA bundle for all of a session's commands, so package managers and scripts reach
   the workspace's repositories through the API and Git as the owner too.
4. **Repository cache** filled with the owner's account in this mode, so the host needs no forge credentials at all.
5. **Visibility**: `identity` and the session panel say which account a session uses.
6. Later: GitHub Packages and ghcr.io, which take different tokens; flipping the default for the owner's own sessions.
