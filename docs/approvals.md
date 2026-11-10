# What a session may do

Nobody approves a session's tool calls one by one. A call either runs at once, as the session's owner, or is refused with a reason the agent reads, and the conversation shows both. Earlier versions asked people to approve commands, pushes and GitHub effects on cards; those cards, **Auto-approve**, **Always approve** and permission requests are gone. What people decided before then stays in each session's **Activity** as `approval.requested` entries.

## The rules

| What | When it runs |
|---|---|
| A tool of the session | When it is among the tools of the session owner's [tool group](workspaces.md#tool-groups), for anyone who may send the session messages. Anything else is refused, whoever asks. |
| Anything that changes something (writing files, commands, commits, pushes, GitHub comments, issues and merges, schedules, messages to other sessions) | Never in a **Read only** message. Read only is the one access a message chooses: everything else acts. |
| Anything that runs on the host's own machine, outside the sandbox: every command of an [unsandboxed host](hosts.md#running-without-the-sandbox) or of a session run directly on its host, commands without the host's [resource limits](hosts.md#the-sandbox) in someone else's session, and the tunnel | Only in sessions of the host's owner and of members they [granted host commands](hosts.md#host-admins-and-host-command-grants), for messages of theirs. Everyone else is refused. |
| An [extension's](extensions.md) tool | Where the workspace has the extension on, for the host's owner and members they granted host commands; for everyone else only where the host's owner lets every session run extension tools (**Settings → Hosts →** the host **→ Extensions**). |
| Reading from, or sending to, a session whose readers differ from this one's ([sessions tool](sessions.md#working-across-sessions)) | Only where the session's owner allows it, under its **Details → People → Content from sessions other people read**. Off by default. |

A refused call ran nothing; the agent is told why, and can say so. Every call that ran is recorded under the name of the person whose message made it, with its outcome.

## Older connectors

A host's connector that still asks for approvals can't run new messages: Pikibun refuses them with `connector_update_required` until its owner updates it (`npx pikibun@latest connect`). Connectors that never ask advertise `approvalFree`.
