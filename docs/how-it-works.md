# How it works

```text
 web app, iPhone/iPad and Mac apps ──HTTPS──▶ Pikibun server ◀──outbound WebSocket── pikibun connector + Pi
                                              (control plane)                        (a member's host)
```

- The **server** keeps workspaces, members, session records, permissions and approvals. It decides every Git request of a session: the host then makes it at the Git host itself with a credential the server gives it for that repository, or the server relays it (see [Network access](hosts.md#network-access)). It issues short-lived push credentials and acts on GitHub for session owners. It never runs an agent itself.
- A **host** runs the agents. Pi's configuration and model credentials, each session's files and its conversation stay there; the server relays every request to it. While a host is offline, its sessions' conversations can't load and no work runs on them.
- Everyone watching a session shares the server's reads of it, about one a second, and after the first read the host, the server and the apps send each other only what changed in the conversation.
- The web app is the complete client; the Mac and Windows app shows it in its own windows, and the iPhone and iPad app covers sessions (see [iPhone, iPad, Mac and Windows apps](apps.md)). They all call the same API.

| Concept | What it is |
|---|---|
| Workspace | A team's shared home: members, repositories, push access and sessions. Each member is its owner, an admin, a collaborator, a member or a viewer. |
| Host | A machine running the `pikibun` connector (or the Mac app) next to Pi. It belongs to the member who paired it, not to a workspace: they can use it in every workspace they belong to, and it stays private to them until they share it with one. |
| Model | A Pi model a host offers. Its credentials never leave the host. |
| Agent | The Pi agent that works in a session, on the model it started from, with every tool its host supports. Each session has its own. |
| Session | One agent conversation on one host, in its own worktree where the agent clones the workspace's repositories. It always runs as its owner. |
| Shared message, side ask | Shared messages drive the session's work; side asks are read-only questions in separate threads. |
| Approval | A card for one exact operation (command, push, merge, comment or host command), which runs only once someone allowed to decide it approves it. |
| Permission request | A card asking the session owner to let a tool call do more than the session allows. |
