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
    built-in tool, never switchable on its own: without it a session couldn't clone its repositories (`sessions.ts`), until
    `git` came (note 29).

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
    prompt, so it is decided as a shell command everywhere (the apps, the control plane, the host's
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
    `git`'s.
24. **The connector's own Node.js.** The connector needs Node.js 24 or newer to run, so every host running the CLI
    connector has one, while the sandbox's `/usr` may hold an older one or none (sessions spent 18 calls in 4 working
    around Node 20). `node-toolchain.ts` finds it (`process.execPath`, through links, to its installation: the directory
    above `bin`) and the `node` tool puts its `bin` first on PATH. Only what the tool runs is given, never the
    directory it is in, which may be a home (`~/bin/node`) or `~/.local`: the `node` executable, the packages the bin
    directory links to that are package managers (`npm` with `npx`, `corepack`, and `pnpm` and `yarn` where installed
    globally; a link out of `lib/node_modules`, or to another package, is ignored), and `include/node` for native
    builds. The Linux sandbox mounts each read-only below `/opt/pikibun/node` for shell commands, laid out as on the
    host, with the links, unless they are in `/usr`, which every sandbox sees; the macOS sandbox adds each to the paths
    steps may read and run. Nothing is downloaded, and the session can't change them. PATH falls back to
    `/usr/bin:/bin` where it is empty, so it never holds an empty entry, the command's own directory. Not given: the Windows sandbox and unsandboxed hosts run the Node.js on the commands' PATH, the host owner's
    choice there. A version a project asks for (`.nvmrc`, `.node-version`, `engines.node`) would be provisioned next,
    from the npm registry's `node-<platform>-<arch>` packages through the egress proxy.

25. **Waiting on a pull request without `sleep`.** Sessions waited for CI with `sleep` in `bash` (9% of their shell
    commands), and read the pull request again after 25 of 26. `github_read` takes `wait` (`apps/runner/src/github-wait.ts`):
    `checks` ends once every check of the head commit has completed, the pull request is closed, or its head has had no
    checks for 2 minutes since it was first read (none will come; a push during the wait starts that time again);
    `change` ends once a digest of the view differs from the first read's: the state, title, description and labels,
    the comments, reviews (with their states) and review comments with their contents, so an edit or a dismissal shows,
    how many of each a full list left out, so a new item shows, the head commit and the checks' statuses; never
    GitHub's own mergeable state, which it works out again by itself. The runner reads again every 30 seconds, up to
    `timeout_seconds` (at most 30 minutes, within the hour a message's admission lets it read), its last sleep cut to
    end at the deadline and a read after it, as the same call: the control plane checks and audits each read as it does one.
    A read that fails during the wait (the admission ran out, say) ends it with the last view and the reason, and
    stopping the message stops the wait. It runs in the runner, so codemode scripts, which have no timers, wait with it too.

26. **Moving, copying and deleting without a shell.** `move_file`, `copy_file` and `delete_file`
    (`apps/runner/src/file-operations.ts`) replace `mv`, `cp` and `rm` in `bash`, and need no approval, like
    `write_file`. A path names an entry itself: its directory is resolved like any written path (through links that stay
    in the worktree, never into `.git`), its last component never, so a link is moved, copied or deleted as a link.
    A destination is never replaced and a directory never goes inside itself, and nothing is made before every check
    has passed. A move never replaces what appeared at its destination since its check: a link is made again there, a
    file gets a second name there before losing its first (refused where the file system has no hard links), and a
    directory takes the place of an empty one made for it, which a rename replaces only while it is still empty. A copy
    keeps links as links, refuses hard links and special files, and never copies a `.git` (a clone is cloned again),
    within 10,000 entries and 50 MB; if it fails it removes what it made, last first, a directory only while it is
    empty and a file or link only while it is still the one it made (its device and inode), so nothing another writer
    put there meanwhile goes; a delete of a non-empty directory needs `recursive`, which may delete a clone with
    its `.git`; without `recursive` only the entry itself goes (`rmdir` or `unlink`), whatever it became since it was
    looked at. The Python helper does it with directory descriptors and `O_NOFOLLOW`, as its other steps do;
    `FILE_OPERATIONS_CORE` does it in the Windows Node helper and, on unsandboxed hosts, in a worker thread, by path
    (Node has no calls relative to an open directory), checking that a directory it goes into is still the one it looked
    at; there the boundary is the Windows container, or none at all on an unsandboxed host; the
    conformance suite holds every backend to the same answers.

27. **Python without a shell.** `piki:python` turns on the `python` tool (`apps/runner/src/python-command.ts`), the
    second ecosystem tool, built like `node`: a program (`python3`, `pip`, `pip3`, `uv`, `uvx`, `poetry`, `pytest`), its
    arguments as a list and a directory, run as one quoted command with no colours or prompts and decided as `bash`'s.
    `venv` names a virtual environment in that directory, whose `bin` goes first on PATH with `VIRTUAL_ENV` set, as
    activating it would: the host's Python can't be installed into, and a venv's interpreter isn't one of the programs.
    Refused: what acts on a package index as an account, `uv publish`, `poetry publish`, `poetry config` of
    `http-basic.*`, `pypi-token.*` or `certificates.*`, and twine's `upload` and `register`, followed through what
    launches twine by name (`python3 -m twine`, `uvx`, `uv run`, `uv tool run`, `poetry run`). Python is the host's, in
    `/usr`, which every sandbox sees; uv and poetry where the host installed them.

28. **Code mode is core.** `pi:codemode` is the glue between tools that shell pipelines were: chaining calls, looping
    over results, cutting and filtering output (215 pipe stages in the sample only trimmed output). Its catalogue entry
    (`builtinExtensions`, host-config.ts) is marked `core`, so `SessionBuiltins.select` runs it in every session whatever
    the host's configuration lists; a connector that predates it still goes by that list, so the host's page keeps its
    checkbox for them (**Older connectors too**) rather than a capability flag older servers would refuse. A workspace extension that offers a
    `codemode` tool still replaces it, as it replaced the optional one. Its limits stay as they were (2 scripts per
    session, 8 per host, 256 MiB, 2 minutes of compute), and each call a script makes is decided like the model's own.
    The agent instructions point to it rather than pipes in `bash`.

29. **`bash` switchable.** With `git`, `node`, `python`, the file tools and code mode in place, `piki:shell` turns the
    `bash` tool on or off per workspace, fail-closed like `piki:host-shell` (note 19): off while the workspace's answer
    now or the last one its connector read turns it off. The `git`, `node` and `python` tools keep running without it:
    their calls are `bash` operations to the approval rules, but not the `bash` tool, and the control plane checks the
    session's agent tools, which still list `bash`. It is on by default; turning it off by default, and removing `bash`
    and `host_bash`, wait for the owner's go-ahead (#163).

30. **Every session tool on a switch.** The brokered tools join the session-tool extensions as they are: `piki:github`
    (`github_read`, `github_comment`, `github_issue`, `github_merge`), `piki:sources` (`source_read`, split per kind in note 35), `piki:sessions`
    (`sessions`), and `git_push` with `git` under `piki:git`. Each keeps its broker, its approvals and its checks; the
    switch only decides whether sessions offer it, and each refuses a call by name (from a code mode script) while it is
    off. The tools every session needs, `identity` and the file tools, are `piki:files`, marked `core`: always on, shown
    as such, and a workspace's turning it off is refused by the control plane and ignored by connectors
    (`sessionToolsOff`). With this, every tool a session has is a Pikibun or Pi extension a workspace chooses.

31. **A program tool's call is its own operation.** `git`, `node` and `python` calls were `bash` operations, so the
    control plane checked them against `bash` in the session's agent, and an approval rule written for `bash` covered
    them. They are now `{ kind: "program", tool, command }` (`ProgramOperation`, types.ts): the exact command, as before,
    under its own tool's name. The runner (`validateOperation`) and the control plane (`parseOperation`) check it alike;
    the control plane checks the call against its tool in the session's agent or its grants (a permission or "Allow for
    this session" for `git` covers git's calls, never bash's); and everywhere else it is decided and run as a shell
    command is (`decidedAsHostCommand`, `requesterAutoApproves`, the host's limits and grants, redaction, the
    sandboxes' `execute`). A control plane that predates it refuses the kind, so such a call fails cleanly there.

32. **No shell.** `bash` and `host_bash` are removed (#163): the runner defines neither tool, and the agent's
    instructions recommend no shell. Both names join `retiredToolNames`, so stored agents and approvals that list them
    stay valid while the control plane never gives them to a new session; cloning needs `git` (or, on a connector from
    before, `bash`). `piki:shell` and `piki:host-shell` stay in the catalogue as `retired` entries: connectors still
    report them, so the control plane still sends a workspace's choice to older connectors, which have the tools and
    keep them off where it was turned off; workspace pages no longer list them. The runner refuses a new `host.bash`
    operation (a restart already ended any that waited), and the session page no longer requests `bash` operations by
    hand. A `bash` operation is still the sandbox's own: the program tools run through it, and an older session whose
    agent lists `bash` can still have one requested. Extensions may name a tool `bash`, as any retired name, decided like
    every extension tool, by the host's owner.

33. **Rust, Go and .NET.** `piki:rust`, `piki:go` and `piki:dotnet` turn on the `rust`, `go` and `dotnet` tools
    (`apps/runner/src/ecosystem-command.ts`), one module for the three, built like `node` and `python`: a program
    (`cargo`, `rustc`, `rustup`, `rustfmt`; `go`, `gofmt`; `dotnet`), its arguments as a list and a directory, run as one
    quoted command with no colours, progress bars, telemetry or first-run banners, each a `program` operation decided as
    commands are. The toolchains' usual directories go after the sandbox's PATH (`programShellCommand` takes a list now);
    a rustup install in a home directory isn't seen by the sandbox. A system-wide rustup (`/usr/local/rustup`, as the
    official `rust` image) is: its proxies would look in the session's own `HOME`, so where that directory exists a rust
    call sets `RUSTUP_HOME="${RUSTUP_HOME:-/usr/local/rustup}"`, the session's own value first; `CARGO_HOME` stays the
    session's. The macOS sandbox reads only its tool roots: `/usr/local/go`, `/usr/local/cargo` and `/usr/local/rustup`
    join Homebrew's there (`SEATBELT_LOCAL_ROOTS`, seatbelt.ts), where they exist. Refused: what acts on a package registry as an
    account, `cargo publish`, `login`, `logout`, `owner` and `yank`, followed through `cargo +toolchain` and `rustup run`,
    and `dotnet nuget push`, `delete`, and `add`/`update source` with a password. Go has no such command. Not in the
    Windows sandbox, whose container reaches none of them, as `python` isn't.

34. **make.** `piki:make` turns on the `make` tool (#191), a fourth entry of `ecosystem-command.ts`: `make` with its
    arguments as a list and a directory, a `program` operation decided as commands are. It refuses nothing, since make
    acts on no registry; a Makefile's recipes are shell commands, which its card stands for, as `npm test` does for
    package scripts. #191 first brought rust, go and dotnet too; #194 landed those, with the `rustup run` refusal and the
    instructions' example from a tool the session has, which #191's review asked for.

35. **One extension per kind of document source.** `piki:sources` switched `source_read` for every kind of document
    source at once. It is split into `piki:notion`, `piki:google-drive`, `piki:dropbox`, `piki:onedrive`, `piki:feishu`
    and `piki:tencent-docs`, each switching `source_read` for its own kind (`documentKinds`), so a workspace reads its
    Notion pages and not its Drive folders, say. The tool stays one: its broker, approvals and checks don't change, and
    a new kind still needs no connector update to be read (it has no switch until one adds its extension). Several
    extensions now share a tool, so `sessionToolsOff` turns a tool off only once every extension that offers it is off:
    `source_read` is offered while any kind is on. `documentKindsOff` gives the kinds that are off: their sources are
    left out of the agent's instructions, and a call naming one is refused by the runner, naming its extension.
    `piki:sources` is `retired`, and each new entry `replaces` it: while the workspace hasn't chosen a kind, that kind
    follows the workspace's `piki:sources` choice (`pikiExtensionOn`), so a workspace that turned document sources off
    keeps them off without a migration, and a control plane from before the split, which sends only `piki:sources`,
    still turns them off. The workspace page turns a kind back on with an enabled entry, rather than by removing the
    disabled one, where `piki:sources` is off. A connector from before the split reports `piki:sources` but none of the
    kinds, and gets `piki:sources` as the workspace has the kinds now: on (left out) while any is on, off once all are
    (`connectorWorkspaceExtensions`). Such a connector can't tell kinds apart, so the control plane holds the switch
    itself: it refuses to read a source whose kind is off, whichever connector asks ([tool definitions](tool-definitions.md),
    rule 10). That brings a connector's Pikibun extensions to 25 of the 32 a report holds.

36. **Tools defined as data.** `node`, `rust`, `go`, `dotnet`, `make` and `source_read` are no longer code in the
    connector: the control plane defines them as data and the connector runs them with its own engine, so new tools of
    those kinds need no connector release. Their extensions switch them as before, and a definition names its own, so a
    connector switches a tool by an extension it doesn't know yet. See [tool definitions](tool-definitions.md).

Next: other ecosystems as usage asks for them (`jvm`).

## A browser: piki:browser

Agents that build web apps had no way to see them: a page is what its scripts make of its HTML, and a browser needs a
download the sandbox can't make, a display, and a way to drive it. `piki:browser` turns on the
`browser` tool, the session's own (rule 16), and the session panel gets a **Browser** tab that shows what it saw.

26. **One sandboxed command per call.** A sandboxed command has its own network namespace, and its processes end with
    it (`--die-with-parent`, the session's cgroup), so a browser can't outlive a call without a second kind of sandbox
    that lives across commands, with its own lifetime, limits and cleanup. A call is instead one sandboxed command: the
    driver starts Chromium, opens the page, runs the actions, screenshots the page and exits. Everything a call needs
    happens in it, `localhost` included, which is also why `serve` exists (rule 29). What carries over between calls
    is the profile in the session's home (cookies, storage: a sign-in), and the last page, which a call without a `url`
    opens again. It is a program operation of its own (`{kind: "program", tool: "browser"}`), decided as the `git`, `node`
    and `python` tools' are: pages run their scripts, `evaluate` runs the agent's, `serve` starts the app. The card shows
    the driver, the Chromium it starts, the command's time limit and the call as JSON, within a command's 8192
    characters.
27. **The driver.** `sandbox-python/browser.py`, standard-library Python like the helper, embedded through
    `sandbox-python.generated.ts`, runs Chromium headless on a DevTools pipe (`--remote-debugging-pipe`: no port, no
    WebSocket client, nothing another process in the sandbox could connect to). Chromium's own sandbox can't start in
    ours (no user namespaces), so it runs with `--no-sandbox`: the session's sandbox is the boundary, as for every other
    program there. `/dev/shm` is read-only, so it doesn't use it; the sandbox has no `/etc/fonts`, so the driver writes
    a fontconfig file naming `/usr/share/fonts` and the host's generic-family rules. Chrome and Chromium (not the
    headless shell) bind their profile's singleton socket in `TMPDIR`, and the session's (`/sessions/<64 hex
    digits>/home/.tmp`) leaves too little of a Unix socket path's 107 bytes, so they crash at start there: Chromium runs
    in a directory of its own under it, which its `TMPDIR` names as `/proc/self/cwd`. The HTTP cache is off: a dev server
    changes between calls. Actions find elements by CSS or `text=` (interactive elements first, then the innermost),
    click with real mouse events at the element's centre after scrolling it into view (and say what covered it), type
    with `Input.insertText` (what frameworks listen for), and wait for a navigation an action starts. The answer is a
    bounded report: URL, title, status, the visible text (6000 characters), up to 80 interactive elements each with a
    unique CSS selector, the last 40 console messages, page errors, failed requests, and the screenshot. The driver
    takes the command's time limit, stops actions 5 seconds before it and reports by 1 second before, so a slow page
    still answers with what it got to.
28. **The screenshot, to the model and the panel.** The report and screenshots go to the worktree's `browser-output/`
    (the newest 30 calls), and the call's output is the report. The tool reads the screenshot back with `read_file`'s
    reader and preparation (scaled for the model), and answers with the report in place of the raw output, and the
    image. The **Browser** tab reads the same files through the file browser's API, so it needs nothing new of hosts or
    the control plane, takes the Files tab's collaborator role, and shows what is on the host now. A report is files
    the agent can change, so the tab and the tool take only what has a report's shape (`parseBrowserReport`), and a
    screenshot only at a `browser-output/` path.
29. **`serve`, without a shell.** A web app under test must listen in the same command as the browser, so a call can
    name one of the `node` and `python` tools' programs, its arguments, directory (and for Python's, a virtual
    environment) and port. It is checked by those tools' own requests (`nodeRequest`, `pythonRequest`), so what they
    refuse it refuses too, and the driver starts it without a shell, in its own process group, with their environment
    (`NODE_ENVIRONMENT` and the connector's own Node.js first, given as `--node-bin`; `PYTHON_ENVIRONMENT` and the
    virtual environment's `bin`): sessions have no shell (#163), and `serve` doesn't bring one back. The driver waits
    for the port (or the program's exit, with its output), browses, stops the group, and returns the end of its output.
    A call that is stopped, or reaches its time limit, ends everything it started with it: the sandbox's PID namespace
    goes with the command, and on a host with resource limits so does its cgroup.
30. **The host's Chromium, given read-only.** Sessions download nothing, so the browser is the host's, as its owner
    chooses (rule 33; `browser-toolchain.ts`): found there (`PIKIBUN_BROWSER`, else a system install: the
    distributions' `chromium` packages' real executable, not their wrapper scripts, Chrome and Edge in `/opt`; else the
    newest Playwright or Puppeteer download; else one the connector downloaded), at a path they give, or downloaded by
    the connector (rule 34). Only an installation is taken: a real executable (ELF on Linux) beside one of Chromium's
    own files, in a directory that is neither `/` nor the host user's home or above it, so mounting its directory never
    gives a session anything else. The Linux sandbox binds it read-only at `/opt/pikibun/chromium` for shell commands,
    unless it is under `/usr`, and the driver at `/opt/pikibun/browser/pikibun-browser`, written at every open like the
    git shim. It is looked up for each command, and only on Linux.
31. **Only in the session's sandbox, never on the host.** Chromium on the host, with its own sandbox, would keep the
    renderer sandbox ours takes away (Chromium refuses to start with it, or with its seccomp layer alone, where there
    are no user namespaces), and could outlive a call. But Chromium's sandbox confines the processes that run pages, not
    the browser process, which would run as the host's user; and the DevTools protocol the agent drives it with is
    privileged: it opens `file://` pages, sets an upload's files from any path, and saves downloads anywhere. So the
    agent would reach the host owner's files unless the connector filtered every such feature, and the host's network
    (its LAN, loopback services, cloud metadata) unless every connection were forced through the session's proxy; the
    app under test, in the session's sandbox, would be out of its reach; and on a shared host each call would be decided
    like a host command, by the host's owner. In the session's sandbox all of that is the session's already: a page
    that exploits Chromium gets what the session has, its files, its branch and the workspace's network, not the host.
    So sessions that run on the host (unsandboxed hosts, sessions on the host's environment) don't get the tool, and
    neither do the experimental macOS and Windows sandboxes until they give Chromium a policy of their own.
32. **Offered only where it runs, and said why where it doesn't.** A session with no Chromium for its sandboxed
    commands isn't offered the tool, rather than offered a tool that only fails; one the workspace turned off is refused
    by name, as rule 16 says. Where the workspace has it on, the session's view says why it has none
    (`SessionView.extensions.unavailable`), as a fixed reason (`browserUnavailableReasons`: on the host, another
    sandbox, off, missing, downloading, failed) so nothing of the host's paths or errors reaches its viewers, and its
    agent is told in a sentence, so it says so rather than guessing. The reasons its host's owner can do something about
    (missing, downloading, failed) show as a warning above the chat box as the session starts, on the web and mobile;
    each shows in the panel's Extensions section. Its network is the session's: Chromium goes through the egress proxy
    (loopback stays direct), so the workspace's network policy holds, and verifies certificates with its own roots, as
    the proxy only tunnels them.
33. **The host owner's choice, applied without a restart.** `HostConfig.browser` is the host owner's alone, as
    required extensions are, since it decides which of the host's files every sandboxed session gets: `auto` (found,
    as rule 30 lists), `path` (that executable or none, never another browser; one that isn't an installation says
    why: nothing there, a wrapper script, a home directory, no Chromium files beside it), `download` (rule 34) or `off`.
    The connector (`HostBrowserSource`, `browser-host.ts`) applies it as it connects, before its sessions open, and
    before each extensions report, every half minute, and reports how it stands with them (`HostBrowserStatus`: ready,
    missing, downloading, failed, off, unsupported where its sessions have no Linux sandbox), each text within what
    the control plane takes, so a long path in an error never gets the report refused. The executable and the error
    (which may name a path the owner gave) are the owner's to see: the host's admins and the workspaces' listing get the
    rest. Sessions look the browser up for each
    command and each message's tools, so an install, a change of choice or a finished download reaches open sessions at
    their next message. A control plane that predates the status refuses a report naming it, and the connector reports
    without it until the status changes, then tries again, so a status refused for itself doesn't hide the next; it
    reports without Pikibun extensions for a control plane older still.
34. **Downloading Chrome for Testing.** `download` fetches Chrome for Testing's Stable `chrome-headless-shell` for
    linux64, the build Google publishes for automation (Puppeteer's default): its version from Chrome for Testing's JSON
    API on `googlechromelabs.github.io`, its zip from `storage.googleapis.com/chrome-for-testing-public/` only, at
    exactly the path the API names for that version (`browser-download.ts`). The connector reads the zip itself, so the
    host needs no `unzip`: regular files and directories only, every name inside the target, every size and CRC-32 as
    the central directory says, within 512 MB downloaded and 2 GB extracted. It extracts beside the target and renames
    it into place only once it holds an installation, so a download that stops part way leaves nothing a session could
    run. It goes to the connector's state (`<state>/browser/<version>`), the host's one copy, which the sandbox gives
    sessions read-only as it would a system install. A failed first download is tried again after ten minutes, or at
    once when the owner chooses again; once a day the connector checks for a newer Stable, downloads it beside the one
    in use and switches sessions to it once it is in place, and a failed update keeps the one in use. The one replaced
    stays until the next check, a day later, since a command that started with it (an hour at most) may still run it,
    and the sandbox skips a mount whose source is gone. Chrome for Testing builds Linux
    for x86-64 only, so ARM hosts install their distribution's `chromium`; and Chromium links system libraries (NSS,
    GBM, ALSA) that a minimal server may lack, which the hosts guide names rather than the connector installing
    packages.

Later: a browser that lives across calls, for long flows and watching a page as it changes, in a sandbox of the
session's that outlives one command, beside the app it tests; the user driving it from the Browser tab; the macOS and
Windows sandboxes, with proxy credentials for their proxies; a check that a Chromium found or downloaded starts, in the
sandbox, before sessions are offered it, so missing system libraries show on the host's page rather than in a call.

## A tunnel: piki:tunnel

`piki:tunnel` turns on the `tunnel` tool, which runs a session's web server in its sandbox as a **session service**, a
process that outlives the call that started it, and puts it online through a Cloudflare quick tunnel that the connector
runs on the host. It is the first opt-in session-tool extension: off unless the workspace turns it on. Each start is an
`extension.tool` card decided like a host command and never run automatically. See [its design](tunnel.md).

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
| The prompt audit, a Pi package of its own | `extensions/prompt-audit/` (`prompt-audit.ts`, `index.ts`, `package.json`); tests in `tests/prompt-audit.test.ts` |
| The browser: the tool's request, card and report | `apps/runner/src/browser-command.ts`, `packages/shared/src/browser.ts`; `session.ts` (the `browser` tool, `browserOutcome`); tests in `tests/browser-command.test.ts`, `tests/runner-program-tools.test.ts` |
| The browser's driver | `apps/runner/src/sandbox-python/browser.py` (embedded as `BROWSER_DRIVER`) |
| The host's Chromium and its mounts | `apps/runner/src/browser-toolchain.ts`; `sandbox.ts` (`browser`) |
| The Browser tab | `apps/nsh/src/session-panel/Browser.tsx` |
| Session tools: catalogue, switch, refusal | `packages/shared/src/piki-extensions.ts` (`sessionTools`, `sessionToolsOff`, `pikiExtensionOn`, `extensionSwitchOn`, `documentKindsOff`); `session.ts` (`applyOptions`, `requireSessionTool`, `documentKindsOff`); tests in `tests/runner-schedule.test.ts` |
| Tools defined as data (node, rust, go, dotnet, make, source_read) | [tool-definitions.md](tool-definitions.md) |
| gh, glab, az: refused and read-only arguments, token variables | `apps/runner/src/extensions/piki/{gh,glab,azure-cli}.ts` |
| A session's factories, where it runs the command, write leases | `apps/runner/src/extensions/piki/index.ts`, `adapter.ts`; `session.ts` (`pikiSession`, `runPikiCommand`) |
| The proxy's credentials and leases | `apps/runner/src/api-access.ts`; `apps/server/src/authority/api-access.ts` |
| Loading from factories, reports | `apps/runner/src/extensions/load.ts`, `host.ts`; `connector.ts` (report without them) |
| Added on binding; a connector's list; install requests refused | `apps/server/src/authority/extension-policy.ts` (`addPikiExtensions`), called from `authority/repositories.ts`; `apps/server/src/extensions.ts`; migrations `0048`/`0041` |
| Workspace and host pages | `apps/nsh/src/settings/workspace-extensions.tsx`, `host-extensions.tsx` |
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
