# Workspaces and members

Every account also has a [private workspace](#your-private-workspace) of its own, pinned at the top of the sidebar. Create a workspace with **New workspace** in the sidebar or on the home screen; you become its owner. Its page under **Settings → Workspaces** has these sections: **General**, **Setup**, **Sources**, **Push access**, **Network access**, **Extensions**, **Tool groups**, **Members' tools**, **Transcripts**, **Sub-task sessions**, **Session database**, **Members** and, for owners and admins, **Data export**.

Owners and admins rename a workspace with **General → Rename** (`PATCH /api/workspaces/:id` with `{"name": "…"}`); everyone in it sees the new name. The audit log records who renamed it, not the names.

Owners and admins add people with **Members → Add member**, entering the person's **User ID** and a role; saving an existing member changes their role, which takes effect at once. Or they share an invite link instead (see [Invite links and pending members](#invite-links-and-pending-members)). Below the owner there are four tiers:

- **Viewer**: follows workspace-visible sessions read-only and can't start sessions, restore a backup into a new one, or move one to another host. A session role can't give a viewer more than session viewer (read).
- **Member**: starts sessions, and follows other people's workspace-visible sessions read-only unless their owner grants more.
- **Collaborator**: starts sessions, and can send messages and side asks to any workspace-visible session.
- **Admin**: everything a collaborator can do, plus managing the workspace and every session in it, private ones included (see [Managing every session](#managing-every-session)).

| | Owner | Admin | Collaborator | Member | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| View workspace-visible sessions | ✓ | ✓ | ✓ | ✓ | ✓ |
| Start sessions | ✓ | ✓ | ✓ | ✓ | |
| Send messages to any workspace-visible session | ✓ | ✓ | ✓ | | |
| View, message and stop any session, private ones included | ✓ | ✓ | | | |
| Rename, archive or unarchive any session, change its visibility and tool output, give it session roles, turn off its share link | ✓ | ✓ | | | |
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
| Choose admins' tool group | ✓ | | | | |

## Tool groups

A session has the tools of its owner's **tool group**, whoever writes in it and whatever access their messages use. A tool outside the group isn't offered to the agent, and a call to it is refused, on the host and for the actions Pikibun brokers (pushes, GitHub comments, issues and merges, schedules, other sessions, document sources). Changes take effect on a session's next tool call, within half a minute.

Each member's sessions get the tools of their role, unless an owner or admin puts them in a group of the workspace's own:

| Role | Tools of their sessions |
|---|---|
| Owner, admin | Every tool |
| Collaborator | Every tool but merging pull requests (`github_merge`) and putting web apps online (`tunnel`) |
| Member | Work in the sandbox: the file tools, `git` (commits and pushes to the session branch), `node`, `python`, `rust`, `go`, `dotnet`, `make`, `browser`, reading GitHub (`github_read`) and document sources (`source_read`). No `git_push` to other branches or pull requests, GitHub comments, issues or merges, `schedule`, `sessions` or `tunnel` |
| Viewer | Reading files (viewers don't start sessions) |

Owners and admins create groups under **Settings → Workspaces →** the workspace **→ Tool groups → New group**: a name and the tools it has, from Pikibun's own session tools. They then pick each member's group under **Members' tools**, or **(role)** to go back to the role's tools. A group replaces the role's tools: it can give a member more than their role, or less. Admins choose the group of collaborators, members and viewers; only the owner chooses admins'. The workspace's owner always has every tool. Deleting a group sends its members back to their role's tools, and a member who leaves the workspace leaves their group. A member's group stays when their role changes, as it replaces the role's tools: put them back on **(role)** to follow their new role. Pikibun's retired tools, such as `bash`, which sessions pinned to old agent versions may still have, stay only in sessions whose owner has every tool. Each change is recorded in the workspace's activity (`workspace.tool_group.created`, `.updated`, `.deleted`, `workspace.member.tool_group`).

The API is `GET /api/workspaces/:id/tool-groups` (every member), `POST /api/workspaces/:id/tool-groups` with `{"name", "tools"}`, `PATCH` and `DELETE /api/workspaces/:id/tool-groups/:groupId`, and `PUT /api/workspaces/:id/members/:userId/tool-group` with `{"groupId": "…"}` or `{"groupId": null}`.

Tool groups cover Pikibun's own tools. The tools of other extensions are switched for everyone under **Extensions**. A host learns each member's group with the workspace's extensions and keeps the last answer it read, so a failed fetch lifts nothing; until it has read one, its sessions only read their files. A connector from before tool groups doesn't hide the left-out tools from the agent or refuse them in the sandbox (files and commands); Pikibun still refuses the actions it brokers (pushes, GitHub, schedules, other sessions, document sources), so update connectors (`npx pikibun@latest connect`) before relying on groups for sandboxed tools.

For collaborators, members and viewers, opening or managing someone else's private session takes an explicit grant from its owner.

## Your private workspace

Every account has one workspace that is its alone, named **Private** at first (you can rename it under **General → Rename**) and marked with a lock. It is pinned at the top of the sidebar, above the workspaces you create or join, and it is where **New session** starts until you choose another. Pikibun makes it the first time you open the app, for new accounts and existing ones alike.

- Nobody else can join it: it takes no members (**Add member** is refused) and has no invite link, and your hosts can't be shared into it. Its page under **Settings → Workspaces** has no **Members** section.
- Your own hosts are connected to it, as to every workspace you belong to, so you can start a session there as soon as a host is paired. New sessions there run [directly on the host](hosts.md#sessions-on-the-host), without the sandbox, wherever the host can, and in the desktop app they go to **This Computer** (**This Mac**) while it is your host and online; choose another host, or **Where it runs → Sandbox**, when you start one.
- Its sessions need no source: an agent starts in an empty worktree and works on what you give it, or on what it clones itself. Add repositories or documents under **Sources** as in any workspace if you want them.
- New sessions there are private, and its sessions show to nobody but you unless you turn on a session's share link. The server's administrators still see that it exists, as they see every workspace (see [Administration](self-hosting.md#administration)).

To work with other people, create a workspace with **New workspace**.

## Managing every session

The workspace's owner and admins manage every session in it, private ones included, without a session role. On a session they don't own they hold `read`, `ask`, `write` and `manage`, so they can:

- open it from their session lists, follow it, send side asks and shared messages, stop its work and browse its **Files**;
- **Rename**, **Archive** and **Unarchive** it, make it private or workspace-visible, and turn its **Full tool output** on or off;
- give workspace members session roles up to **Collaborator** and remove anyone's, under **Details → People → Session roles**;
- **Turn off** its share link.

Everything that acts as the session's owner, or takes their work out of the session, stays theirs. Its tools run as the owner, with their Git accounts, within their tool group, for whoever may send it messages. Only the owner lets content pass between it and sessions other people read, schedules prompts, restarts, backs up, restores, exports or moves the session, and creates or copies its share link. Every change a manager makes is recorded in the session's activity under their own name. Demoting an admin, or removing them, takes all of this away at once.

## Invite links and pending members

Owners and admins can share one link to the workspace with anyone: **Members → Invite link → Create link**, then copy it. Whoever opens it signs in (if they haven't yet) and chooses **Ask to join**, which makes them a **pending member**. A pending member is not a member: they can't see or do anything in the workspace, and it doesn't appear in their sidebar. They show under **Members → Pending members**, where an owner or admin picks a role and chooses **Accept**, or **Decline**. Admins accept people with the roles below their own; only the owner can accept someone as an admin.

- The link opens only for people signed in to this Pikibun server, and shows them the workspace's name and nothing else. It never admits anyone by itself, so accept only people you recognize.
- The link's token is in the URL's fragment, so opening it sends the token to neither the server's access logs nor a proxy's; the server keeps it only hashed and encrypted.
- **Replace link** issues a new link and stops the old one at once; **Turn off link** stops it. People already waiting stay pending until someone decides.
- A pending member can withdraw their request from the link's page, or under **Settings → Profile → Your requests to join**, which keeps working after the link is turned off or replaced. Adding someone with **Add member** also settles their pending request.
- At most 200 people wait to join one workspace at a time. Requests count until someone accepts, declines or withdraws them, also after the link changes, so decline the ones you won't accept to make room.

Workspace admins manage only their workspace; the server's administrators are configured separately (see [Administration](self-hosting.md#administration)). A workspace has one owner, who can't be removed. Membership alone grants no GitHub access, no tool use and no access to anyone's host, and it shows private sessions only to the workspace's owner and admins. Removing a member also removes their grants on the workspace's sessions; sessions they own are not reassigned, and nobody, the workspace's owner and admins included, can open them while their owner isn't a member.
