# Cross-session communication

A session's agent works with the workspace's other sessions through one tool, `sessions`: it lists them, reads them,
asks and messages their agents, starts new sessions for sub-tasks, waits for or is notified of outcomes, and stops or
archives sessions. Everything goes through the control plane (`apps/server/src/cross-session.ts`), which decides each
call as if the person behind it had made it themselves. Shared types, limits and the delivered-message format live in
`packages/shared/src/cross-session.ts`; the tool is in `apps/runner/src/session.ts`.

## Actions

| Action | Does | Needs on the other session | Message mode |
|---|---|---|---|
| `list` | Sessions of this workspace the actor can see, and the models `create` can use | read (only those) | any |
| `read` | Latest shared-conversation entries (cut to 2000 characters each, up to 50; a failed model turn with its provider, model, HTTP status and fixed failure codes, never provider text), pending approvals, busy; with `message_id`, that message's outcome | read | any |
| `ask` | A side ask (read-only thread) | ask | any |
| `send` | A shared message, access `approval`, `read` or `auto` (left out: `auto` where the owner's Auto-approve message sends it to their own sandboxed session, else `approval`) | write; refused while the target is working or waiting on a card | Read only needs the owner's permission |
| `wait` | The runner reads one message's outcome every 3 seconds until it is done (default 300 s, at most 1800 s) | read | any |
| `create` | A new session as the actor, linked to this one (`parent_session_id`), with an optional opening message, on a model and reasoning level of the agent's choice (see below) | creating sessions in the workspace | Read only needs the owner's permission |
| `stop` | Stops the other session's work | write | Read only needs the owner's permission |
| `archive` | Archives a session the actor owns or, as the workspace's owner or an admin, any session of the workspace | owner, or the workspace's owner or an admin | Read only needs the owner's permission |

`ask`, `send` and `create` take `notify`: once the target finishes the message, a sweep (every 15 seconds,
`runCrossSessionNotifications`) sends its outcome back as a new message of the same actor, while the origin is idle.
A notification left undelivered for 24 hours expires.

## Who it acts as

Every call runs as the **actor**: the person whose message the agent is working on (`run.initiatedBy`), never the
session's owner on someone else's behalf. The control plane checks, on each call:

1. The actor still writes to the origin session, and the call comes from the origin's host (`requireCallbackScope`).
2. The call belongs to the actor's write admission for the origin, under an hour old.
3. The origin may use the tool (its agent's, or allowed by the owner: `requireToolCall`).
4. In a Read-only message, a change elsewhere (`send`, `create`, `stop`, `archive`) was allowed by the owner
   (`sessions:write` grant, for the call or the session), unless it is the owner's own Auto-approve message.
5. `access: auto` only from the owner's Auto-approve message, and only to a session the actor owns.
6. A `send` or `create` that names no access inherits Auto-approve (`inheritedAccess`) only where rule 5 would allow it
   and the target session is sandboxed (no unsandboxed host, not run on its host) on a host taking chat options; the
   origin admission's `auto_merge` comes with it. Its notification inherits it from the same admission, delivered into
   the origin under the same conditions. Anything else stays `approval`, so no message runs with more than its sender's.

Work in the other session then runs through `asActor` (a request context of the actor's own), through the same
functions as the apps' routes: `submitMessage`, `createSession`, `stopSession`, `archiveSession`, `sessionView`. Each
applies its usual checks: the actor's permission there, suspension, archive, restores, moves, the host's models and
chat options. Sessions of another workspace are not found.

Approvals never cross sessions: what a message runs in its target waits on the target's own cards, which only people
with approve permission there decide. A read shows pending cards (their kind and requester), nothing more.

New sessions run as the actor, with their Git accounts, on a model's host: the actor's own host, or the origin's host
when the actor owns the origin (they trusted that host when they started it). Any other host they must acknowledge
themselves, in the apps.

## Models and reasoning of new sessions

`create` takes `model` (a workspace model id, one `list` returns) and `thinking` (a reasoning level), so an agent runs
each sub-task on what suits it. `list` returns, with the models, the reasoning levels each one's host offers it at
(`thinkingLevels`) and whether the workspace lets agents choose (`childModels`).

- The reasoning level is the opening message's (`ChatOptions.thinkingLevel`), which the new session's conversation
  keeps until someone picks another; `thinking` without a message is refused. The model's host must take a message's
  reasoning level (`chatOptions`) and offer the model at that level; otherwise nothing starts.
- What the agent leaves out is the origin's **current** model and reasoning level, as its host reports them for the
  shared conversation (`parentModel`), where that model is one of the workspace's the actor may use on the origin's
  host; otherwise the model the origin started on, at the level its host starts it at. An inherited level is passed on
  only where the new session's model runs at it.
- A workspace's owners and admins decide whether agents choose at all: `workspace_child_session_settings.child_models`
  (`GET`/`PUT /api/workspaces/:id/child-sessions`, `{ childModels }`, on by default, audited as
  `workspace.child_sessions.updated`), under **Settings → Workspaces → Sub-task sessions**. Off, a `create` that names
  `model` or `thinking` is refused (`child_models_disabled`), and every new session runs on its parent's current model
  and reasoning level.
- The permission card shows the choice (`create · model <id> · thinking <level> · …`), the result names the model and
  level the new session got, and `session.cross_session.created` records them.

## Who can see what

Transcript content passes between two sessions only when the same people can read both, in the direction it flows:

- `read`, and a `notify`'s reply, bring the target's content **in**: everyone who reads the origin must read the target.
- `ask`, `send` and an opening message take the origin's content **out**: everyone who reads the target must read the
  origin.

Readers are computed with the same policy as `sessionAccess` for every member of the workspace (`sessionReaders`);
a share link counts as everyone. When a direction isn't covered, the control plane answers `{ consent: "audience" }`
and does nothing; the runner raises a second permission card for the same call (`permission-<call>_audience`, need
`audience`), and calls again once the owner allows it. The approval route records the decision as a `sessions:audience`
grant (for the call, or the session), which the control plane checks against the card's own target, requester and
admission (`sessionsNeedGranted`). The owner's own Auto-approve message raises no card, as for any permission.

A session the agent starts is never more visible than its parent: a private session starts only private ones. A new
private session is read by its owner (the actor) and the workspace's owner and admins, who read every session, so a
private parent's outcome comes back from it without a card unless the parent has other readers.

## Provenance, chains and limits

Each delivered message starts with a line the control plane writes:

```
[Pikibun cross-session message xs:<id> · from session "<title>" (<origin id>) · sent by @<login> through its agent · hop <n>]
```

Its request id is `xs:<id>`, so its write admission (`run_admissions.request_id`) ties the target's run, and every
tool call it makes, back to the message (`messageChain`). The text tells the agent where a message comes from; the
`session_messages` table is the record people trust, shown in the panel's **Connected sessions**
(`GET /api/sessions/:id/connections`, naming only sessions the viewer can open).

- **Hops**: a message from a person's message is hop 1; one sent while working on hop *n* is hop *n + 1*. A run at
  3 hops lists and reads but sends, asks and starts nothing. A request id typed to look like `xs:...` counts as the
  last hop.
- **Loops**: each message records the sessions it came through (`chain_json`); none goes to a session in its chain or
  back to itself. A notification keeps its message's chain, so the coordinator can follow up with the worker that
  notified it, one hop further.
- **Fan-out**: one message sends at most 10 messages, asks and opening messages; each takes its place in the same
  statement that counts them, so calls made at once can't exceed it, and a refused one gives it back. A session starts
  at most 20 sessions; the runner makes the tool's calls one at a time.
- **Busy targets**: like scheduled prompts, a shared message to a session that is working or waiting is refused, not
  queued; side asks go.

A message's outcome is read from its target's view: its queue status, and the target agent's last answer after the
message's own entry (found by `xs:<id> `) and before the next message of that conversation (`messageOutcome`).
A runner too old to list its queue gives no status: its message counts as done once an answer is the last entry
after it and no card waits.

## Data

- `session_messages`: one row per delivered message or notification: origin, target, actor, kind, the origin
  admission and call, the target's submission and conversation, hops, chain, access, and the notification's state.
- `sessions.parent_session_id`: the session whose agent started this one. It is control-plane state, not part of
  the runner binding.
- `session_tool_grants` rows `sessions:write` and `sessions:audience`: the owner's permissions above.
- `workspace_child_session_settings`: whether the workspace's agents choose the model and reasoning level of sessions
  they start; no row: they do.

## Audit

The origin records `session.cross_session.sent`, `.created`, `.stopped` and `.archived`, with the call. The target
records what happened there as usual (`session.submit`, `session.created` with `parentSessionId`, `session.stopped`,
`session.archived`), marked with the message or the origin.

## Compatibility

Connectors advertise `crossSessions`; new sessions on them get the tool. Sessions started before it, or on older
connectors' agents, ask the owner for the tool the first time (an older connector doesn't register it at all).
