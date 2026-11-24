# Workspaces and members

Every account also has a [private workspace](#your-private-workspace) of its own, pinned at the top of the sidebar. Create a workspace with **New workspace** in the sidebar or on the home screen; you become its owner. Its page under **Settings → Workspaces** shows the workspace's name with **New session** beside it, and four tabs that stay in place while their sections scroll:

- **Overview**: **General**, **Setup** (until a source is added, a host paired and a session started), **Members**, **Invite link**, **Pending members** and, for owners and admins, **Data export**.
- **Sources**: the **Git repositories**, document sources and workspace connections sessions work on, and **Push access**.
- **Agents**: what agents can use and reach. **Network access**, **Your GitHub reach** (each member's own choice of whether their own messages may act on [any GitHub repository they can access](github.md#repositories-outside-the-workspace)), **Sub-task sessions**, **Extensions**, **Remote MCP servers**, **Tool groups** and **Members' tools**.
- **Sessions**: how sessions run and are kept. **Schedules**, **Transcripts**, **Attachments**, **Prompt cache** (whether hosts [keep sessions' prompt caches warm](models-and-tools.md#prompt-cache-warming)), **Build caches** (directories hosts keep for [builds](#build-caches)), **Archived sessions** (whether their files are [packed automatically](backups.md#packing-archived-sessions)) and **Session database**.

A link from elsewhere in the app opens the tab it is about: **Add a source** opens **Sources**, a session's **Schedules** tab opens **Sessions**.

## What a new workspace starts with

A workspace starts ready to work in, and its owners and admins narrow it where they want to:

- **Network access** is **Open**: sandboxed commands reach any public host, besides the workspace's repositories. Choose **Allowlist** or **Off** under **Agents → Network access** (see [Network access](hosts.md#network-access)).
- **Your GitHub reach** is on for each member: messages you send yourself, in sessions you own, may act on [any GitHub repository you can access](github.md#repositories-outside-the-workspace). Each member turns their own off.
- **Extensions**: Pikibun's starter set is on: [context files](extensions.md#context-files-pikicontext-files) (`piki:context-files`), `piki:git`, `piki:node`, `piki:python`, scheduled prompts (`piki:schedule`), other sessions (`piki:sessions`), [workspace management](extensions.md#workspace-management-pikiworkspace) (`piki:workspace`), artifacts (`piki:artifacts`) and skills (`piki:skills`). The popular third-party extensions and the prompt audit are listed, turned off, and the rest of [Pikibun's tools](extensions.md#session-tools) are added under **Extensions**.
- **New sessions run on the host** wherever their host takes them, with **Where it runs → Sandbox** one choice away (see [Starting a session](sessions.md)).

These are defaults for what nobody has chosen. Shared workspaces made before them keep **Off** and the workspace's repositories only, for the members they had, until someone changes that; private workspaces follow the new defaults, and nobody's saved choice changed.

Owners and admins rename a workspace with **General → Rename** (`PATCH /api/workspaces/:id` with `{"name": "…"}`); everyone in it sees the new name. The audit log records who renamed it, not the names.

Owners and admins add people with **Members → Add member**, entering the person's **User ID** and a role; saving an existing member changes their role, which takes effect at once. Or they share an invite link instead (see [Invite links and pending members](#invite-links-and-pending-members)). Below the owner there are four tiers:

- **Viewer**: follows the workspace's sessions read-only and can't start sessions, restore a backup into a new one, or move one to another host. A session role can't give a viewer more than session viewer (read).
- **Member**: starts sessions, and follows other people's sessions read-only unless their owner grants more.
- **Collaborator**: starts sessions, and can send messages and side asks to any session in the workspace.
- **Admin**: everything a collaborator can do, plus managing the workspace and every session in it (see [Managing every session](#managing-every-session)).

Every session is visible to every member of its workspace; there are no private sessions (see [Collaborating on a session](collaboration.md#visibility-and-session-roles)).

| | Owner | Admin | Collaborator | Member | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| View every session | ✓ | ✓ | ✓ | ✓ | ✓ |
| Start sessions | ✓ | ✓ | ✓ | ✓ | |
| Send messages to any session and stop its work | ✓ | ✓ | ✓ | | |
| Rename, archive or unarchive any session, change its tool output, give it session roles, turn off its share link | ✓ | ✓ | | | |
| Rename the workspace | ✓ | ✓ | | | |
| Add and remove sources (repositories, documents), set repositories' push policy and Git LFS | ✓ | ✓ | | | |
| Manage push identities | ✓ | ✓ | | | |
| Set network access | ✓ | ✓ | | | |
| Add, change or remove collaborators, members and viewers | ✓ | ✓ | | | |
| Share the invite link, accept or decline pending members | ✓ | ✓ | | | |
| Add, change or remove admins | ✓ | | | | |
| Connect the session database, import dumps | ✓ | | | | |
| Export the workspace | ✓ | ✓ | | | |
| Create, change and delete tool groups; choose the group of collaborators, members and viewers | ✓ | ✓ | | | |
| Choose admins' tool group; change or delete a group with an admin in it | ✓ | | | | |

## Tool groups

A message in a session runs only the tools both the session owner's **tool group** and its sender's have, whatever access it uses. The owner's group bounds what anyone runs in their sessions, and nobody borrows the owner's tools by writing in their session: a collaborator's message to an admin's session doesn't merge pull requests, and a member with a session role of Collaborator doesn't push to other branches there. The owner's own messages and scheduled prompts run with the owner's group alone. A tool outside it isn't offered to the agent for that message, and a call to it is refused, on the host and for the actions Pikibun brokers (pushes, GitHub comments, issues and merges, schedules, other sessions, document sources). Changes take effect on a session's next tool call, within half a minute.

Each member's sessions get the tools of their role, unless an owner or admin puts them in a group of the workspace's own:

| Role | Tools of their sessions |
|---|---|
| Owner, admin | Every tool |
| Collaborator | Every tool but merging pull requests (`github_merge`), putting web apps online (`tunnel`) and managing the workspace (`workspace`) |
| Member | Work in the sandbox: the file tools, `git` (commits and pushes to the session branch), `node`, `python`, `rust`, `go`, `dotnet`, `make`, `browser`, reading GitHub (`github_read`) and document sources (`source_read`). No `git_push` to other branches or pull requests, GitHub comments, issues or merges, `schedule`, `sessions`, `workspace` or `tunnel` |
| Viewer | Reading files (viewers don't start sessions) |

Owners and admins create groups under **Settings → Workspaces →** the workspace **→ Agents → Tool groups → New group**: a name and the tools it has, from Pikibun's own session tools. They then pick each member's group under **Members' tools**, or **(role)** to go back to the role's tools. A group replaces the role's tools: it can give a member more than their role, or less. Admins choose the group of collaborators, members and viewers; only the owner chooses admins', and only the owner changes or deletes a group with an admin in it, as it limits what admins run. The workspace's owner always has every tool. Deleting a group sends its members back to their role's tools, and a member who leaves the workspace leaves their group. A member's group stays when their role changes, as it replaces the role's tools: put them back on **(role)** to follow their new role. `find` has no box of its own: a group with **Search files** (`grep`) finds files too, and one without it doesn't. Pikibun's retired tools, such as `bash`, which sessions pinned to old agent versions may still have, stay only in sessions whose owner has every tool. Each change is recorded in the workspace's activity (`workspace.tool_group.created`, `.updated`, `.deleted`, `workspace.member.tool_group`).

The API is `GET /api/workspaces/:id/tool-groups` (every member), `POST /api/workspaces/:id/tool-groups` with `{"name", "tools"}`, `PATCH` and `DELETE /api/workspaces/:id/tool-groups/:groupId`, and `PUT /api/workspaces/:id/members/:userId/tool-group` with `{"groupId": "…"}` or `{"groupId": null}`.

Tool groups cover Pikibun's own tools. The tools of other extensions are switched for everyone under **Extensions**. A host learns each member's group with the workspace's extensions and keeps the last answer it read, so a failed fetch lifts nothing; until it has read one, its sessions only read their files. A connector from before tool groups doesn't hide the left-out tools from the agent or refuse them in the sandbox (files and commands), and one from before senders' groups counted hides and refuses there only what the owner's group leaves out; Pikibun still refuses the actions it brokers (pushes, GitHub, schedules, other sessions, document sources) for both, so update connectors (`npx pikibun@latest connect`) before relying on groups for sandboxed tools.

For collaborators, members and viewers, managing someone else's session takes a session role from its owner.

## Build caches

A **build cache** is a directory a host keeps for the workspace, whose path commands find in an environment variable, so tools that keep a cache directory (ccache's `CCACHE_DIR`, sccache's `SCCACHE_DIR`, Gradle's build cache, Bazel's `--disk_cache`, Turborepo, Nx) reuse earlier builds instead of starting again in every session. Owners and admins add them under **Settings → Workspaces →** the workspace **→ Sessions → Build caches → Add cache**: a name (1 to 40 lowercase letters, digits and hyphens), the variable (uppercase letters, digits and underscores; never one the sandbox or the tools set themselves, such as `PATH`, `HOME`, `TMPDIR`, `LD_*`, `GIT_*` or `PYTHON*`) and, optionally, writer groups. A workspace has at most 16.

Nobody can check what a cache holds, so whoever writes it can change what every session reading it builds and runs. So the sessions of the workspace's owner, its admins and its collaborators whose tool group can write files share one copy of each cache: they already send messages to every session and change its files. Members, and collaborators who can't write files, get their own copy, which nobody else reads. **Writer groups** narrow who shares the copy, never widen it: with some named, only the workspace's owner and the people of those groups who pass that rule share it, and everyone else gets their own. A group deleted later still narrows it (the page shows it as a deleted group), leaving the workspace's owner, never everyone. A private workspace has one person, who uses the shared copy.

Hosts keep caches only where their owner turns on [Build caches](hosts.md#host-configuration) in the host's configuration (**Per owner** there gives everyone their own copy), and sandboxed Linux and macOS hosts get it in a later connector release. Only commands see a cache, never the file tools, and caches never enter backups, packs or moves; a session moved or restored elsewhere starts with an empty one there. Deleting a cache stops sessions getting it from their next command; hosts keep what it held until `pikibun cache prune` removes it. Each change is recorded in the workspace's activity (`workspace.build_cache.created`, `.updated`, `.deleted`).

The API is `GET /api/workspaces/:id/build-caches` (every member; it answers `{"caches": [{"name", "env", "writerGroups", "createdAt", "updatedAt"}], "admin", "limits"}`), `PUT /api/workspaces/:id/build-caches/:name` with `{"env": "…", "writerGroups": ["…"]}`, which adds the cache or changes it, and `DELETE /api/workspaces/:id/build-caches/:name`.

## Schedules

A workspace schedule starts a new session on a schedule, as its owner, with its message as that session's first: a nightly test run, issue triage every morning, a weekly dependency report. Each run is a fresh session, so runs never wait for one another or for anyone's open session. They are listed under **Settings → Workspaces →** the workspace **→ Sessions → Schedules** (**New schedule**, **Pause**/**Resume**, **Run now**, **Edit**, **Delete**, **Open last session**), with whom each runs as; every member sees them. To wake an existing session on a schedule instead, give it a [scheduled prompt](sessions.md#scheduled-prompts).

- **When** and **Access**: as for a session's [scheduled prompts](sessions.md#scheduled-prompts): a cron expression in a time zone, runs at least 5 minutes apart, and **Act** or **Read only** (which needs the model's host to take chat options).
- **Model** and **Reasoning**: each schedule starts its sessions on a model it names, one its owner may start sessions on, at a reasoning level its host offers it at, or at the level the host starts it at. A model on another member's host needs its owner to trust that host, as starting a session there does: the form asks, and the API takes `trustedConnectorId`. A run whose model is gone (removed or disabled, or its host gone) starts nothing, and the schedule says why (`model_unavailable`) until someone chooses another; one whose model no longer runs at its level starts without that level (`thinking_unsupported`).
- **When its run is done**: **Archive the session** (the default) makes each new session one-shot: once its host reports the run done, the server archives it within about 30 seconds. It stays in the list as archived and opens to read, and **Unarchive** keeps it open from then on. A run that fails stays open for you to look at, and so does a session someone sends a message of their own: taking it over keeps it open. **Keep it open** leaves every new session open until someone archives it. A person's schedules keep at most 20 of these sessions open in a workspace: once there are 20 that aren't archived, a run starts none and says so (`too_many_sessions`), until some are archived. A session its host fails to start, or that takes no message, is archived again.
- **Who makes and changes them**: members who may start sessions (not viewers) make schedules, at most 50 each in a workspace, and manage their own. The workspace's owners and admins manage every schedule. Changing someone else's schedule (anything but pausing or resuming it) makes it the changer's: from then on its runs act as them, with their tool group, Git accounts and hosts, so nobody's runs act on words someone else wrote. The form says so before you save.
- **Owners who can't run them**: a run whose owner has left the workspace, become a viewer or been suspended starts nothing; the schedule pauses and says why (`owner_unavailable`). An owner or admin can take it over and resume it.
- **Made from a session**: a schedule a session's agent made with its `schedule` tool (`run_in: child`), or one made in a session's panel before schedules moved here, remembers that session. Its runs start under it in lists, and while it names no model it starts them on that session's current model and reasoning level. It falls back on those when its own model is gone (`model_unavailable`, with the run going ahead) or where the workspace no longer lets agents choose (`child_models_disabled`). It shows in that session's **Schedules** tab too, and keeps running once the session is archived. Schedules made from a session before this change whose session was already archived were paused, as they had been running nothing.
- Each run is audited as the owner's `session.submit` in the new session, with `workspace.schedule.session_started` (on the session it was made from, if any); making, changing and deleting them as `workspace.schedule.created`, `.updated` (with `takenOverFrom` when someone took it over) and `.deleted`. The server checks for due ones every 30 seconds. See [docs/design/workspace-schedules.md](design/workspace-schedules.md).

## Managing the workspace from a session

With [Workspace management](extensions.md#workspace-management-pikiworkspace) (`piki:workspace`) added under **Extensions**, a session's agent can read the workspace and, when asked, change it: "add acme/api to this workspace", "make Dan a collaborator", "allow pypi.org". It acts as the person whose message it is working on, with exactly their role, through the same routes as this page, so whatever the table above doesn't let their role do, the agent can't either. New workspaces start with it, older ones add it there, and by default only owners' and admins' tool groups have it.

## Your private workspace

Every account has one workspace that is its alone, named **Private** at first (you can rename it under **General → Rename**) and marked with a lock. It is pinned at the top of the sidebar, above the workspaces you create or join, and it is where **New session** starts until you choose another. Pikibun makes it the first time you open the app, for new accounts and existing ones alike.

- Nobody else can join it: it takes no members (**Add member** is refused) and has no invite link, and your hosts can't be shared into it. Its page under **Settings → Workspaces** has no **Members** section.
- Its sessions run only on your own hosts: it offers no model on anyone else's host, nor one with no host, and a session there runs only while its host is yours. So your own computers hold every one of its sessions.
- All of its sessions stay listed when you sign in to Pikibun from somewhere else, whether or not their host is online. A session whose host is offline says so and continues once that host is back. In the desktop app, it offers to start the host of **This Mac** it ran on, or to add a host for this server under **Local hosts**, which keeps every other host This Mac runs (see [Host](desktop/host.md#good-to-know)).
- Its sessions live on your computer's own Pikibun, so every server the computer is paired with lists the same ones, and a message sent from any of them goes into the one session. See [Your private sessions on every server](backups.md#your-private-sessions-on-every-server).
- Your own hosts are connected to it, as to every workspace you belong to, so you can start a session there as soon as a host is paired. New sessions there, as in every workspace, run [directly on the host](hosts.md#sessions-on-the-host), without the sandbox, wherever the host can, with [your own environment](hosts.md#the-owners-own-environment) (your `HOME`, ssh agent and Git configuration), and in the desktop app they go to one of this computer's own hosts (**Local hosts**) for the server while it is online; choose another host, or **Where it runs → Sandbox**, when you start one.
- There, a session on your host can run commands as root with `sudo -A`: sudo asks for your password in Pikibun, in a box of its own beside the chat box, each time it needs it (see [sudo asks you](hosts.md#sessions-on-the-host)).
- Its sessions need no source: an agent starts in an empty worktree and works on what you give it, or on what it clones itself. Add repositories or documents under **Sources** as in any workspace if you want them.
- As nobody else is a member, its sessions show to nobody but you unless you turn on a session's share link. The server's administrators still see that it exists, as they see every workspace (see [Administration](self-hosting.md#administration)).

To work with other people, create a workspace with **New workspace**.

## Managing every session

The workspace's owner and admins manage every session in it without a session role. On a session they don't own they hold `read`, `ask`, `write` and `manage`, so they can:

- open it from their session lists, follow it, send side asks and shared messages, stop its work and browse its **Files**;
- **Rename**, **Archive** and **Unarchive** it, and turn its **Full tool output** on or off;
- give workspace members session roles up to **Collaborator** and remove anyone's, under **Details → People → Session roles**;
- **Turn off** its share link.

Everything that acts as the session's owner, or takes their work out of the session, stays theirs. Its tools run as the owner, with their Git accounts, for whoever may send it messages, but only those both the owner's tool group and the sender's have. Only the owner lets content pass between it and sessions other people read, schedules prompts, restarts, backs up, restores, exports or moves the session, and creates or copies its share link. Every change a manager makes is recorded in the session's activity under their own name. Demoting an admin, or removing them, takes all of this away at once.

## Invite links and pending members

Owners and admins can share one link to the workspace with anyone: **Members → Invite link → Create link**, then copy it. Whoever opens it signs in (if they haven't yet) and chooses **Ask to join**, which makes them a **pending member**. A pending member is not a member: they can't see or do anything in the workspace, and it doesn't appear in their sidebar. They show under **Members → Pending members**, where an owner or admin picks a role and chooses **Accept**, or **Decline**. Admins accept people with the roles below their own; only the owner can accept someone as an admin.

- The link opens only for people signed in to this Pikibun server, and shows them the workspace's name and nothing else. It never admits anyone by itself, so accept only people you recognize.
- The link's token is in the URL's fragment, so opening it sends the token to neither the server's access logs nor a proxy's; the server keeps it only hashed and encrypted.
- **Replace link** issues a new link and stops the old one at once; **Turn off link** stops it. People already waiting stay pending until someone decides.
- A pending member can withdraw their request from the link's page, or under **Settings → Profile → Your requests to join**, which keeps working after the link is turned off or replaced. Adding someone with **Add member** also settles their pending request.
- At most 200 people wait to join one workspace at a time. Requests count until someone accepts, declines or withdraws them, also after the link changes, so decline the ones you won't accept to make room.

Workspace admins manage only their workspace; the server's administrators are configured separately (see [Administration](self-hosting.md#administration)). A workspace has one owner, who can't be removed. Membership alone grants no GitHub access, no tool use and no access to anyone's host; it shows every session of the workspace. Removing a member also removes their grants on the workspace's sessions; sessions they own are not reassigned, and nobody, the workspace's owner and admins included, can open them while their owner isn't a member.
