# Workspace memory: what a workspace knows across its sessions

Status: implemented. User docs: [Extensions → Workspace memory](../extensions.md#workspace-memory-pikimemory), [Working across
sessions](../sessions.md#working-across-sessions) (`search`).

## Question

Should a workspace have one **main session** that remembers the whole project and hands every request to sub-agents,
as people picture Claude Projects doing? And what should Pikibun take from Claude Projects?

## What Claude Projects are

Written from what Anthropic describes for claude.ai (late 2025); check it against their current documentation before
relying on a detail.

| Part | What it does | The idea in it |
|---|---|---|
| Project knowledge | Uploaded files, synced repositories and documents; retrieval once they outgrow the context | Knowledge lives outside any chat |
| Custom instructions | Added to every chat of the project | Rules shared by every chat |
| Many separate chats | Each chat starts fresh | No conversation carries the project |
| Memory | A summary of past chats, per project, that people can read and edit, updated in the background | Memory is a short, kept document, not a transcript |
| Search of past chats | A tool the model calls when it needs an earlier chat | History on demand, not always in context |

Claude Projects dispatch nothing. Delegation is Claude Code's: the session one works in hands sub-tasks to sub-agents,
each in a context of its own, which report a summary back. Nowhere is there a session that never ends.

## Why not a main session

Pikibun already delegates (`sessions`, `piki:sub-agents`). A main session would add one session everyone writes to,
and that fits Pikibun badly:

1. **One queue.** A session runs one shared message at a time, refuses a `send` while it works, and takes `notify` only
   while idle ([cross-session.md](cross-session.md)). Every member's request would wait behind everyone else's.
2. **Its limits.** A session starts at most 20 sessions in its life, and a message sends at most 10 messages. A
   coordinator that never ends reaches them.
3. **Memory as a transcript.** A conversation that never ends is compacted again and again; what each summary drops is
   gone, and nobody can read or correct it. A document can be read, corrected and its changes recorded.
4. **Whose session.** Tools run as the session's owner, within the owner's and the sender's tool groups. One session for
   everyone mixes their authority, and its context, shaped by one person's messages, steers another's: the trust problem
   [build-caches.md](build-caches.md) describes for shared caches.
5. **One host.** Sessions live on their host; that host offline, the workspace has no entry point.
6. **Cost.** Every message pays for the whole context, a small request too.

So the workspace keeps what a main session would remember, and every session, each with its own context, reads it.
Any session is then the coordinator for its own request, with sub-agents where the work splits.

## Decisions

1. **Two texts per workspace, on the control plane.** `workspace_memory` holds `instructions` (how to work here, at most
   16,000 characters) and `memory` (what sessions learned, at most 32,000), Markdown, with a `revision`. They are the
   workspace's, not a session's or a repository's: a workspace may have no repository, several, or documents only, and
   the control plane is what every host and the settings page already ask. Bounded, because both go into every
   message's prompt: a memory that outgrows them should be shortened, which is the curating that keeps it useful.

2. **Agents propose; owners and admins keep.** An agent's `memory {action: "note"}` adds a row to
   `workspace_memory_notes`, as the message's sender, and nothing else. Only owners and admins change the texts or
   decide a note's fate, on the page or with `update` and `resolve`. What reaches every session's prompt is then what an
   owner or admin chose, never what one prompt-injected agent wrote: the same reasoning as the workspace tool's gates
   ([workspace-tool.md](workspace-tool.md), decision 11). Notes wait at most 200 at a time, so an agent in a loop can't
   bury them.

3. **Saves name the revision they read.** `update` and the page's save carry the `revision` they started from, and the
   statement changes the row only `WHERE revision = ?` (or inserts the first one, for revision 0), adding one. A save
   against an older revision is refused with `409 memory_changed` and the current one, so the agent reads again and
   merges, and two people editing at once don't silently undo each other. Accepting notes in the same save
   (`accept`) marks them once the texts are saved.

4. **Into each message through the workspace extensions answer.** Connectors already ask the control plane for a
   workspace's extensions before each message (cached for 30 seconds). A connector of this release asks with
   `memory: true`, and while `piki:memory` is on the answer carries `{ instructions, memory, revision, pendingNotes }`;
   the session adds them to the message's instructions (`workspaceMemoryPrompt`), side asks included. Read per message,
   not per session, so a session sees a change from its next message, as Claude Projects' chats do from their next turn.
   No new request, no new endpoint for hosts, and the answer's size limit (1 MB) holds them easily.

5. **The tool is defined as data.** `memory` is a [brokered tool definition](tool-definitions.md) with route `memory`,
   switched by `piki:memory`. Connectors that read definitions offer it without an update; one that predates the memory
   in the answer still tells its agent, through the definition's instructions, to read the memory with `memory
   {action: "read"}` before a task. It is named outside `toolNames`, as `workspace` is, so older connectors pass over it.

6. **Opt-in, and every role that starts sessions has the tool.** `piki:memory` is `optIn`: text in every prompt is a
   workspace's choice. Unlike `workspace`, the tool is in the owner, admin, collaborator and member role groups: what a
   member's agent can do with it is read and propose, which an owner or admin then decides on. Viewers start no sessions.

7. **Gates as the workspace tool's.** The control plane checks, in order: the sender still writes to the session; the
   call comes from its host; the admission is the sender's, a write message, live; both tool groups have `memory`;
   `piki:memory` is on; and a Read-only message only reads. `update` and `resolve` then need the sender to be an owner
   or admin of the workspace, checked again in the SQL that writes (`workspaceAdminSQL`), so a demotion between the
   check and the write changes nothing.

8. **Recorded without the text.** `workspace.memory.updated` (revision, which texts, how many notes accepted),
   `workspace.memory.noted` and `workspace.memory.notes_resolved`, with the session and call where an agent made them.
   The texts can hold anything people typed, so the audit names the change, not the words, as the workspace tool leaves
   out extensions' settings.

9. **Reports back are notes.** Item 4 of the question, a finished sub-task's findings reaching the memory, is a note:
   the definition's instructions tell the agent to note what a task it finished found, above all one another session
   gave it. A sub-agent's report reaches its coordinator by `notify`, and what lasts reaches the memory through a note
   someone keeps. An admin's scheduled prompt can do the keeping ("go through the memory's notes every morning").

10. **Search instead of a long memory.** The memory holds what matters; the rest stays in the sessions, which an agent
    finds with `sessions {action: "search"}` ([cross-session.md](cross-session.md#search)) and reads. The prompt points
    at it when the `sessions` tool is offered.

## Left out, for now

- **Earlier revisions.** Only the current texts are kept; the audit says who changed them when. A history to compare and
  go back to would be the next step if memories get large or contested.
- **Summaries written by Pikibun.** Claude Projects' memory is a summary the service writes. Here an agent or a person
  writes it, so its words are someone's, recorded, and nothing a model distils lands in every prompt unreviewed.
- **Per-member memory and retrieval by meaning.** One memory per workspace; search by words, over the views hosts serve.
  An index (and embeddings) would need the transcripts on the control plane, which Pikibun keeps on hosts.

## Where things are

| Part | Where |
|---|---|
| Limits, types, the tool's definition, the prompt | `packages/shared/src/workspace-memory.ts` |
| Switch, group tool | `packages/shared/src/piki-extensions.ts` (`piki:memory`), `packages/shared/src/tool-groups.ts` |
| Control plane | `apps/server/src/workspace-memory.ts`; `memory` in the connectors' workspace extensions answer (`extensions.ts`) |
| Tables | `workspace_memory`, `workspace_memory_notes` (`apps/server/migrations/*/…_workspace_memory.sql`) |
| Session | `apps/runner/src/session/instructions.ts`, `availability.ts` (`workspaceMemory`) |
| Page | `apps/nsh/src/settings/workspace-memory.tsx` (**Agents → Workspace memory**) |
| Tests | `tests/workspace-memory.test.ts`, `tests/cross-session.test.ts` (search) |
