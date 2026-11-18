# Workspace schedules

Status: implemented. What people see is in [Schedules](../workspaces.md#schedules) and a session's
[Scheduled prompts](../sessions.md#scheduled-prompts); this note says why it works as it does.

## One table, two kinds

Every schedule is a row of `schedules` (`apps/server/src/scheduled-prompts.ts`), in a workspace, run as its
`owner_id`. One with a `session_id` wakes that session, as every schedule did before; one without starts a new session
for each run. Keeping both in one table keeps one sweep, one claim (`next_run_at` moved on before anything is sent, so
two servers or sweeps never send one run twice) and one set of validators, rather than two that drift apart.

- **Session schedules stay on their session.** Waking a session needs that session: it dies with it (`ON DELETE
  CASCADE`), pauses while it is archived, shows the session as **Scheduled** (`sessions.next_scheduled_at`, which only
  these feed) and travels with it when it moves to another server.
- **Workspace schedules outlive sessions.** A schedule that only starts sessions had to live in one before, so people
  kept a session open to hold their schedules, and archiving it silently stopped them. Now nothing about a session stops
  one.
- **Where it came from.** `origin_session_id` is the session a workspace schedule was made from: by its agent's
  `schedule` tool (`run_in: child`), in its panel by an older app, or by migration. Its runs start under that session
  (`parent_session_id`), so lists keep showing them there; a schedule without a model starts on that session's current
  model, and one whose model is gone falls back on it, as runs in a child session always did. It travels with a
  portable session, as its schedules did, and isn't restored twice. It is used only while that session's owner is the
  schedule's owner: a schedule someone else took over no longer acts through another person's session, and has to name
  a model of its own (`model_required`).

## Whom a run acts as

Every run is a message, so it is someone's: the schedule's `owner_id`, never the server's. A workspace schedule starts
its session through `createSession` as that person, which checks everything starting a session by hand checks: a role
that may start sessions, the model, its host, the person's Git accounts.

- **Admins edit any schedule, and an edit takes it over.** Workspace owners and admins manage every schedule in the
  workspace (and a session's, as they manage its session). If an edit left the owner in place, an admin could write a
  prompt that runs with someone else's tool group, Git accounts and hosts without that person ever seeing it. So any
  change but pausing or resuming makes the changer its owner (`takenOverFrom` in the audit), and the form says so before
  saving. Pausing, resuming, running now and deleting leave it as it is: they decide when it runs, not what it does or
  as whom. The session owner takes a session's schedule back the same way.
- **Trust in a host is given when the schedule is saved.** A model on another member's host runs the new sessions on
  that member's computer. Starting a session there asks its owner to say they trust it (`trustedConnectorId`), and a
  schedule asks the same when it is made, when its model changes and when someone takes it over; each run then starts
  its session with that trust. The agent's `schedule` tool can't give it: an agent may only choose models on its owner's
  own hosts or its session's (`agentMayStartOn`), as for the sessions it starts with its `sessions` tool.
- **The workspace's sub-task setting applies to agents.** **Sub-task sessions** decides whether agents choose the
  models of the sessions they start. It still bounds what the `schedule` tool and a session's panel may choose, and a
  schedule made from a session falls back on that session's model when it is turned off, as before. A schedule made
  in the workspace's **Schedules** is chosen by a person, who chooses models for their own sessions anyway, so it
  applies to none.
- **An owner who can no longer run it pauses it.** Each run first checks that its owner is still a member who may start
  sessions, and not suspended. If not, nothing starts, and the schedule is paused with `owner_unavailable` rather than
  failing on every run for ever; an owner or admin takes it over to run it again.

## Limits

A session keeps at most 20 schedules, as before. A person keeps at most 50 workspace schedules in a workspace, and their
schedules there keep at most 20 sessions open (`MAX_SCHEDULED_SESSIONS`). The open-sessions limit used to count one
parent session's children; counting the owner's instead keeps it meaningful now that runs need no parent, and still
can't be got round by making more schedules.

## Moving the existing schedules

`0076_workspace_schedules.sql` (Postgres `0069`) copies `session_schedules` into `schedules`: one that ran in its session
keeps its `session_id`; one that ran in a new child session gets `origin_session_id` instead, with its model and level,
and its session's owner as its owner. A schedule of the second kind whose session was archived had been running nothing,
and as a workspace schedule would start again; it is moved paused, so nobody's forgotten schedule wakes up after the
upgrade. Sessions' **Scheduled** state is recomputed from the schedules that still wake them.

## Older apps and connectors

Connectors call `/api/connectors/self/schedules` (and old runners `/api/internal/schedules`) with a session, as before;
the server reads `run_in: child` as a workspace schedule made from it. The session routes keep their shape too, and
list the schedules made from the session beside those that wake it, so an older app's **Schedules** tab still shows and
changes them.
