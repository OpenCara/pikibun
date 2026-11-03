# Pikibun's built-in extensions: gh, glab and az

Sessions on a sandboxed host have no network but the workspace's: they clone and push through the egress proxy, and read
and act on GitHub through `github_read`, `github_comment`, `github_issue` and `github_merge`. What those don't cover (CI
runs and their logs, checks, releases, other forges' merge requests and pipelines, the forges' APIs) took `host_bash`,
with nothing to guide the agent or the person approving it. With this design the connector carries Pi extensions of its
own that give sessions a forge's command-line tool, run on the host with its owner's sign-in to it, and a workspace gets
the one for a forge when it binds its first repository there.

Built-in extensions are named for where they come from: Pi's are `pi:<name>` (`pi:codemode`, [host
extensions](host-extensions.md), rule 10), which a host's configuration turns on for every session on it; Pikibun's own
are `piki:<name>`, workspace extensions that a workspace chooses like any other and that ship with the connector.

## Decisions

1. **Extensions like any other** ([host extensions](host-extensions.md)): a workspace's owners and admins enable,
   disable and remove them, set their tools to approval or automatic, and set their settings; a session runs them where
   its workspace enables them; each tool call is an `extension.tool` card decided like a host command. Nothing new in
   sessions, cards or approvals.
2. **Built into the connector.** Their source is `piki:<name>` (`piki:gh`, `piki:glab`, `piki:azure-cli`),
   their package key the source itself, and their version the connector's: every connector that knows one has it, and
   reports it with what is installed, so hosts never install, update or remove them (the store, the CLI, the connector
   and the control plane all refuse to). They load through Pi's loader from their factory
   (`loadExtensionFromFactory`), not a file, so they are part of the connector's bundle.
3. **One tool per command**, named for it (`gh`, `glab`, `az`), whose arguments are the command's, as a list: it runs
   without a shell, in the session's worktree on the host or a `directory` in it (resolved within the worktree, links
   too), with stdin closed and no prompts, colors, pagers or update checks, until it exits, its call stops or it reaches
   its `timeout_seconds` (300 by default). Its output (stdout and stderr) is cut to its first 32 KB and last 96 KB, where
   a failure's reason is. A non-zero exit is the call's error, with the output.
4. **The host owner's sign-in, never shown.** The command gets the host's `PATH`, `HOME`, `XDG_*` directories, D-Bus
   session (for keyrings), proxies and CA bundles, and its own variables (`GH_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`, …;
   `GITLAB_TOKEN`, `GITLAB_HOST`, …; `AZURE_*`), never the connector's other environment, as `host_bash` doesn't.
   Arguments that would print its credentials (`gh auth token`, `--show-token`, `glab config get token`,
   `az account get-access-token`, `--expose-token`, `az --debug`) never run, even approved. These checks look at every
   argument, since all three commands take options between their command words (`auth --hostname x token`), gh and glab
   cluster short options (`-at`), and az takes long options abbreviated, its words in any case and by unique prefix
   (`acc get` is `account get-access-token`); they would rather
   refuse a harmless call (a label named `auth` beside a search for `token`) than miss one.
5. **Read-only, a setting.** Each registers the Pi flag `read-only` (off by default). With it, only commands that read
   run: an allowlist of subcommands for gh and glab (`pr view`, `run view`, `ci trace`, …), their `api` with `GET` (or a
   GraphQL query, no mutation, no `@file` fields, no `--input`, no method override, short options taking their values
   apart so none hides in a cluster); for az, verbs `list`, `show`, `query`, `list-*` and `show-*` of command groups that
   don't name keys, secrets, passwords, credentials, tokens, connection strings, SAS or app settings, `az rest` and
   `az devops invoke` with `GET` and no body, and no `@file` arguments. A read-only call runs in an empty temporary
   directory instead of the worktree and refuses `directory`: a session can write the worktree, and a repository's Git
   configuration there could make a command that runs Git (`gh pr status`) run code. A workspace that sets the tools to
   automatic should set read-only too; the workspace page says so.
6. **Added with the first repository of a forge.** Binding a repository whose provider is `github` or
   `github-enterprise` adds `piki:gh`, `gitlab` `piki:glab`, and `azure-devops` `piki:azure-cli`, when it is
   the workspace's first repository of those providers and the workspace doesn't use that extension yet (nor 32
   extensions): enabled, tools with approval, at the end of its list, audited as `workspace.extension.updated` with
   `reason: repository`. One the workspace turned off stays off; one it removed comes back only with a later first
   repository of its forge. Migrations `0048` (SQLite) and `0041` (Postgres) do the same once for workspaces that already
   have such repositories, as their owner.
7. **Older connectors and control planes.** A connector that predates Pikibun extensions would refuse a workspace's
   whole list for naming one, so the control plane leaves them out of the list it gives a connector whose last report
   names none. A report holds up to 16 Pikibun extensions besides the 64 installed sources a host may have. A control plane
   that predates them refuses a report that names one (400): the connector then reports
   without them, until it reconnects. Sessions on an older connector run without them, and the workspace's and host's
   pages say to update it.

## Where things are

| Part | Where |
|---|---|
| Catalogue (names, tools, providers, install and sign-in hints) | `packages/shared/src/piki-extensions.ts` |
| `piki:` sources | `packages/shared/src/host-extensions.ts` |
| The command tool, its environment and output | `apps/runner/src/extensions/piki/cli.ts` |
| gh, glab, az: refused and read-only arguments | `apps/runner/src/extensions/piki/{gh,glab,azure-cli}.ts` |
| Loading from factories, reports | `apps/runner/src/extensions/load.ts`, `host.ts`; `connector.ts` (report without them) |
| Added on binding; a connector's list; install requests refused | `apps/server/src/extensions.ts`, `repositories.ts`; migrations `0048`/`0041` |
| Workspace and host pages | `apps/web/src/settings/WorkspaceExtensions.tsx`, `HostExtensions.tsx` |
| Tests | `tests/piki-extensions.test.ts`, and in `extensions`, `repositories`, `local-connector` |

## Later

- Report on the host's page whether each command is installed and signed in (`gh auth status`), without its output.
- `tea` for Gitea and Forgejo; Bitbucket has no official CLI.
- Act as the session owner: give the command a short-lived token of the session owner's account, where the provider
  can mint one, instead of the host owner's sign-in.
