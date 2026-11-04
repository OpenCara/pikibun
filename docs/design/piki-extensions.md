# Pikibun's built-in extensions: gh, glab, az and the prompt audit

Sessions on a sandboxed host have no network but the workspace's: they clone and push through the egress proxy, and read
and act on GitHub through `github_read`, `github_comment`, `github_issue` and `github_merge`. What those don't cover (CI
runs and their logs, checks, releases, other forges' merge requests and pipelines, the forges' APIs) took `host_bash`,
with nothing to guide the agent or the person approving it. With this design the connector carries Pi extensions of its
own that give sessions a forge's command-line tool, and a workspace gets the one for a forge when it binds its first
repository there. It also carries a guard, the prompt audit (below).

The command runs **as the session owner**: in the session's sandbox, where the session's egress proxy adds the session
owner's access to the forge's API ([credentialed APIs](egress.md#credentialed-apis-gh-without-a-token-in-the-sandbox)).
It first ran on the host with the host owner's own sign-in, so a member's session on a host someone else shared acted as
that host's owner, with whatever their account could reach. Now the host's own sign-in is used only where the session
itself runs on its host (rule 9).

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
   (`loadExtensionFromFactory`), not a file, so they are part of the connector's bundle. A session loads each with a
   factory of its own (`forSession`), which knows where that session runs the command (rules 8 and 9); the connector's
   copy, which only reports what the extension offers, runs nothing.
3. **One tool per command**, named for it (`gh`, `glab`, `az`), whose arguments are the command's, as a list: it runs
   without a shell (in the sandbox, every word quoted), in the session's worktree or a `directory` in it, with stdin
   closed and no prompts, colors, pagers or update checks, until it exits, its call stops or it reaches its
   `timeout_seconds` (300 by default). Its output (stdout and stderr) is cut to its first 32 KB and last 96 KB, where a
   failure's reason is. A non-zero exit is the call's error, with the output.
4. **Never a token in sight.** In the sandbox the command holds only the proxy's placeholder (`GH_TOKEN`,
   `GITHUB_TOKEN`, `GITLAB_TOKEN`, `AZURE_DEVOPS_EXT_PAT`), never a credential. On the host (rule 9) it gets the host's
   `PATH`, `HOME`, `XDG_*` directories, D-Bus session (for keyrings), proxies and CA bundles, and its own variables
   (`GH_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`, …; `GITLAB_TOKEN`, `GITLAB_HOST`, …; `AZURE_*`), never the connector's other
   environment, as `host_bash` doesn't. Either way, arguments that would print its credentials (`gh auth token`,
   `--show-token`, `glab config get token`, `az account get-access-token`, `--expose-token`, `az --debug`) never run,
   even approved. These checks look at every argument, since all three commands take options between their command
   words (`auth --hostname x token`), gh and glab cluster short options (`-at`), and az takes long options abbreviated,
   its words in any case and by unique prefix (`acc get` is `account get-access-token`); they would rather refuse a
   harmless call (a label named `auth` beside a search for `token`) than miss one.
5. **Read-only, a setting.** Each registers the Pi flag `read-only` (off by default). With it, only commands that read
   run: an allowlist of subcommands for gh and glab (`pr view`, `run view`, `ci trace`, …), their `api` with `GET` (or a
   GraphQL query, no mutation, no `@file` fields, no `--input`, no method override, short options taking their values
   apart so none hides in a cluster); for az, verbs `list`, `show`, `query`, `list-*` and `show-*` of command groups that
   don't name keys, secrets, passwords, credentials, tokens, connection strings, SAS or app settings, `az rest` and
   `az devops invoke` with `GET` and no body, and no `@file` arguments. Such a call never gets a write lease (rule 8). In
   the sandbox it runs with the worktree mounted read-only. On the host it runs in an empty temporary directory instead
   of the worktree and refuses `directory`: a session can write the worktree, and a repository's Git configuration there
   could make a command that runs Git (`gh pr status`) run code on the host. A workspace that sets the tools to automatic
   should set read-only too; the workspace page says so.
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
   pages say to update it. A control plane that predates writes refuses the proxy's `access: write` (400), so writes
   are refused with a reason; one that predates GitLab and Azure DevOps names only `api.github.com` in grants, and an
   older connector leaves out the API hosts it doesn't know.
8. **In the sandbox, as the session owner.** A session with a sandbox and an egress proxy runs the command there, as
   one sandbox operation (`RunnerSession.runPikiCommand`, through `bash` with every word quoted): it sees the host's
   `/usr`, so the host's owner installs the command there. Its API requests go through the proxy, which adds the session
   owner's access (see [credentialed APIs](egress.md#credentialed-apis-gh-without-a-token-in-the-sandbox)):
   - **Reads, always**: of api.github.com with the read-only GitHub App token for the workspace's repositories the
     session owner can read, on any host; of gitlab.com and dev.azure.com with the owner's own personal access token,
     which can't be limited to a repository, so only on the owner's own hosts.
   - **Writes, only in a call a person decided**: the call's card was approved (or ran under the session owner's
     Auto-approve), not run because the workspace sets the tools to automatic, and outside the read-only setting. Such a
     call gets a **write lease** from the proxy for as long as it runs, a placeholder naming it in the token variables.
     Its requests then go with the session owner's own credential (their GitHub sign-in, their GitLab or Azure DevOps
     token), which the control plane gives only to the owner's own hosts: a host someone else owns could take it from
     its connector. Elsewhere writes are refused with that reason, and `github_comment`, `github_issue`, `github_merge`
     and `git_push` remain. Sandbox operations run one at a time per session, so no other command runs while a lease
     holds, and only a call `runExtensionTool` admitted runs a command at all.
   The card is still decided like a host command (rule 1): it is the same card as before.
9. **The host's own sign-in, only where the session is the host's.** The command runs on the host, as it first did,
   with the host's own sign-in to it (rule 4), only (a) where the session itself runs on its host (an unsandboxed host,
   or a session on the host's environment), whose commands all run there as the host's OS user anyway; or (b) in the
   host owner's own sessions, where the host's owner set `PIKIBUN_PIKI_HOST_SIGN_IN=1` for the connector: Azure
   resources (`az vm`, …) need an Azure sign-in Pikibun doesn't have, and in the experimental macOS and Windows
   sandboxes Go programs such as `gh` and `glab` can't verify the proxy's certificate yet. Another member's session never
   gets the host's sign-in; a session with neither a sandbox nor (a) or (b) doesn't run the command, and says why.

## Session tools: piki:schedule, piki:host-shell, and the built-in tools after it

The session's own tools (`identity`, the file tools, `github_*`, `schedule`, `sessions`, `bash`, `host_bash`, ...) are
moving to extensions one at a time ([#163](https://github.com/OpenCara/pikibun/issues/163)), so a workspace chooses every
tool the same way. They can't simply become Pi extension tools: those run as `extension.tool` cards decided like host
commands, so a member on a shared host would wait on its owner for every file read, and Pi's loader ignores an
extension's tool named like one of Pikibun's own (`load.ts`). A **session-tool extension** is the switch instead.

15. **A catalogue entry with `sessionTools`.** `piki:schedule` names the session tools it turns on (`schedule`). The
    connector has it like any Pikibun extension and reports it, from a factory that registers nothing in Pi.
16. **The session's tools, switched.** The session keeps defining the tools as before, with its own permissions,
    approvals and Read-only rules. Each shared message offers them less those the workspace turned off (`sessionToolsOff`:
    a session-tool extension it lists disabled), and each such tool refuses a call while it is off, since a code mode
    script calls tools by name.
17. **On unless turned off.** A workspace that never chose, a control plane that predates the extension, and a
    connector that can't read the workspace's choice now all leave the tools on: the tools were always there, and a
    vanishing `schedule` would surprise more than one that a workspace turned off showing for a while. So there is no
    migration. Turning one on removes the workspace's entry; turning it off saves it disabled. A tool whose being off
    protects something (`host_bash`) will need its connector to keep the workspace's last answer and fail closed instead.
18. **No tool mode, settings or host requirement.** The control plane saves a session-tool extension with approval and
    no settings, doesn't count it towards a workspace's 32, and refuses a host's requiring one. Connectors that predate
    one offer its tools whatever the workspace chose; its page says so.

19. **Fail-closed tools.** A catalogue entry with `failClosed` (`piki:host-shell`, for `host_bash`) is off while either
    the workspace's answer now or the last one the connector read (`HostExtensions.lastKnown`, however old) turns it off.
    The connector otherwise falls back to no extensions after 5 minutes without the control plane, which would turn
    such a tool back on. A connector that never read an answer (a control plane that predates extensions) leaves it on.
    The last answer is kept in memory only: a connector restarted while the control plane is out of reach has none, so
    such a tool is on there until it reads one. Messages and scheduled prompts reach a session only through the control
    plane, so that leaves at most a message already running when the connector restarted; persisting the answer (in the
    extension store, say) would close that too.
20. **The order follows use.** A sample of recent sessions (#163) ran `host_bash` twice, both times for `gh`, which
    `piki:gh` covers; `bash` ran read and search (32%), builds and tests (27%), git (23%) and waits for CI (9%), with
    inline Python and Node scripts in most sessions. So `host_bash` became switchable first, while `bash` stays a
    built-in tool, never switchable on its own: without it a session can't clone its repositories (`sessions.ts`).

21. **Search and line ranges, without a shell.** The `search` tool and `read_file`'s `offset`/`limit` replace the grep,
    find, sed -n, cat and head that took a third of sessions' shell commands, each approved. Like `read_file`, they need
    no approval and stay in the worktree: `search` never follows links, skips hard-linked, binary and over-1 MB files,
    and skips `.git` directories as it walks (nor `node_modules` unless `all`); a `path` inside `.git` searches it, as
    `read_file` reads it. Stopping at `max_results` with anything left unsearched is `truncated`, and an answer holds at
    most 256K characters of lines, within the helpers' 4 MB of output. Every backend runs the same search
    (`apps/runner/src/search.ts`): the Python helper in the Linux and macOS sandboxes, and `SEARCH_CORE` in the Windows
    Node helper and, on unsandboxed hosts, in a worker thread, so a pattern that backtracks without end stops the worker
    (after 30 seconds) rather than the connector. Each search stops itself after 10 seconds, 20,000 files or 64 MB and
    answers what it found as `truncated`. Python's and JavaScript's regular expressions agree on the common syntax
    (classes, groups, alternation, anchors, quantifiers); `\d` and `\w` match Unicode digits and letters in the Python
    helper only. The conformance suite holds every backend to the same answers. They are built-in tools like `read_file`;
    they join `piki:files` when the file tools move there.

22. **Git without a shell.** `piki:git` turns on the `git` tool (`apps/runner/src/git-command.ts`): Git's arguments as
    a list, starting with a subcommand of an allowlist of version-control ones (no `config`, `submodule`, `bisect`,
    `filter-branch`, `difftool` and the like), none of Git's own options before it (`-c`, `-C`, `--git-dir`,
    `--exec-path`), and none of the options that name a program or take settings or hooks that run one (`clone
    --upload-pack`/`-u`, `--config`/`-c`, `--template`; `fetch`/`pull`/`ls-remote --upload-pack`; `push --receive-pack`/
    `--exec`; `rebase --exec`/`-x`; `grep -O`), including their abbreviations and short-option clusters. A call becomes
    one sandboxed command, `git --no-pager` and its quoted arguments in the clone's directory, with no editor or password
    prompt, so it is a `bash` operation to the approval rules everywhere (the apps, the control plane, the host's
    limits and grants), and needs `bash` in the session's agent, as every session has. It never skips approval for
    subcommands that only read: the clone's own configuration (`core.fsmonitor`, `core.pager`, `diff.external`,
    filters, hooks), which the agent can write with `write_file`, can make `git status` run a program, so a
    read-only `git` without approval needs each backend to run Git with all of those turned off first. The runtime
    instructions point to it rather than Git in `bash`.
23. **Node.js without a shell.** `piki:node` turns on the `node` tool (`apps/runner/src/node-command.ts`), the first
    of the ecosystem tools that replace project tasks in `bash` (#163): a program of Node.js's (`node`, `npm`, `npx`,
    `pnpm`, `yarn`, `corepack`), its arguments as a list and a directory, run as `program` and its quoted arguments with
    no colours, no corepack or npx prompt, and `/usr/local/bin` after the sandbox's PATH, where Node.js installs. It
    shares `program-command.ts` with `git`. The unit a workspace turns on is the toolchain, not one program: `node`
    alone can't install a project, and `pnpm run` or `node script.js` run arbitrary code anyway, so an allowlist of
    programs narrows nothing. What it refuses is a package manager's command (its first argument that isn't an option,
    an option's value, a wrapper such as `recursive` or yarn's `npm`, or `workspace <name>`) that acts on a registry as
    an account: `publish`, `login`, `token`, `owner`, `dist-tag`, `tag` and the like, with each manager's own options
    (npm's `-w` takes a workspace, pnpm's takes nothing), and through what launches a manager by name (`corepack
    <manager>`, `npx`, and the managers' `exec`, `x` and `dlx`). A program that runs any other way (a script) isn't
    followed: the check keeps the plain forms off the cards, and approval stands for the rest. Its calls are decided as `bash`'s, like
    `git`'s. It runs the host's Node.js; a Node.js version per workspace, provisioned in the sandbox, is the next step.

Next, in order: a Node.js version for `piki:node`, a wait for pull request checks, project tasks and scripts (`piki:tasks`); then `bash`
becomes `piki:shell`, and `host_bash` is removed. The brokered tools
(`source_read`, `sessions`, `github_*`, `git_push`) follow on the same switch.

## The prompt audit: piki:prompt-audit

A shared host runs other members' messages next to its owner's files and credentials. `piki:prompt-audit` has a model
of the host check each message before the agent sees it, and refuses those that reach for what lies on the machine.

10. **A Pi extension on `input`.** It registers no tool: it handles Pi's `input` event, which Pikibun runs on each
   message before accepting it ([host extensions](host-extensions.md), the compatibility table), so it works in Pi as
   it does in Pikibun. It audits messages whose `source` isn't `interactive`: in Pikibun everyone's but the host
   owner's, in Pi those from RPC clients and other extensions; its `audit` flag set to `all` audits every message.
11. **Required by the host's owner.** Hosts guard themselves by requiring it of every session on them (host extensions
   rule 11), with the owner's settings: `model` (`provider/modelId`, from `ctx.modelRegistry`; the session's model,
   `ctx.model`, when empty) and `policy` (the owner's own words, added to the auditor's instructions). A workspace can
   add it too, for its own sessions.
12. **One model call, the message as data.** The auditor gets fixed instructions (credentials, host files, the host's
   environment, exfiltration and getting around safeguards, the owner's policy; ordinary work allowed) and the message
   between markers with a random nonce, so the message can't close them, plus its images; a model that can't see images
   refuses messages with them. It answers with one JSON verdict. The call has 45 seconds and 2048 tokens, within the minute
   Pikibun gives `input` handlers, which run once the message is queued, never while the connector waits on a request.
13. **Fails closed, never throws.** Pi lets a message through when an `input` handler throws, so every failure (no
   model, a provider error, a timeout, no verdict) is a refusal (`handled`). Pikibun refuses one that throws anyway.
14. **Fixed words to the sender, the reason to the host.** A refusal tells the sender (`ctx.ui.notify`) only the kind of
   thing flagged, in fixed text within the charset the control plane's relay passes on; the auditor's own reason is
   model text a crafted message could steer, so it goes to standard error without a UI: the connector's log.

## Where things are

| Part | Where |
|---|---|
| Catalogue (names, tools, providers, install, account and sign-in hints) | `packages/shared/src/piki-extensions.ts` |
| `piki:` sources | `packages/shared/src/host-extensions.ts` |
| The command tool, its environment and output, in the sandbox or on the host | `apps/runner/src/extensions/piki/command.ts` |
| The prompt audit | `apps/runner/src/extensions/piki/prompt-audit.ts`; tests in `tests/prompt-audit.test.ts` |
| Session tools: catalogue, switch, refusal | `packages/shared/src/piki-extensions.ts` (`sessionTools`, `sessionToolsOff`); `session.ts` (`applyOptions`, `requireSessionTool`); tests in `tests/runner-schedule.test.ts` |
| gh, glab, az: refused and read-only arguments, token variables | `apps/runner/src/extensions/piki/{gh,glab,azure-cli}.ts` |
| A session's factories, where it runs the command, write leases | `apps/runner/src/extensions/piki/index.ts`, `adapter.ts`; `session.ts` (`pikiSession`, `runPikiCommand`) |
| The proxy's credentials and leases | `apps/runner/src/api-access.ts`; `apps/server/src/api-access.ts` |
| Loading from factories, reports | `apps/runner/src/extensions/load.ts`, `host.ts`; `connector.ts` (report without them) |
| Added on binding; a connector's list; install requests refused | `apps/server/src/extensions.ts`, `repositories.ts`; migrations `0048`/`0041` |
| Workspace and host pages | `apps/web/src/settings/WorkspaceExtensions.tsx`, `HostExtensions.tsx` |
| Tests | `tests/piki-extensions.test.ts`, `api-access.test.ts`, and in `push-broker`, `host-extensions`, `extensions`, `repositories`, `local-connector` |

## Later

- Decide a sandboxed call's card like a sandboxed command (by whoever may approve in the session), not like a host
  command: it no longer runs on the host. The card would then say where it runs.
- On a host someone else shared, writes as the session owner through the control plane: the proxy forwards an approved
  call's write there, and the control plane adds the owner's credential, so it never reaches the host.
- GitHub Enterprise Server and self-managed GitLab: the proxy's certificate authority vouches only for the fixed API
  hosts, by its name constraint; their hosts would join it from the workspace's repositories.
- Act as the owner with a narrower credential where the provider can mint one: a GitHub App user token, limited to the
  app's installations, instead of the owner's sign-in for writes.
- Report on the host's page whether each command is installed where its sandboxes find it.
- `tea` for Gitea and Forgejo; Bitbucket has no official CLI.
