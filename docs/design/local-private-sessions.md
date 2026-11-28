# Design: private sessions live on the local server

Status: implemented. It replaces moving sessions between servers ([portable sessions](portable-sessions.md)) for new
private sessions, and removes **Bring here**.

## Why

A session in someone's [private workspace](../workspaces.md#your-private-workspace) runs only on their own computers,
and its conversation and files already live there. [Portable sessions](portable-sessions.md) let such a session move
between the Pikibun servers a computer is paired with, but it is attached to one server at a time: every other server
listed it with **Bring here**, and the one it left showed it as **Moved to another server**. Someone who uses two
servers (their own Pikibun and a team's, or `pikibun.com` on a phone and a laptop) saw each session on one server only,
and moved it by hand.

The servers can't share a session as things are. Each pairing on a computer is its own connection process, and a
session's database and agent belong to the one that has it open (`open.lock`, a lease with a heartbeat:
[open leases](portable-sessions.md#open-leases-between-connections)). Its binding names one server, one owner
ID and one policy version, and every permission check goes back to that server.

So private sessions get one home that never moves: **the computer's local server**, the Pikibun that
`pikibun serve` and the desktop app's Self host already run. Every other server shows the same private sessions by
forwarding to it, and a message sent from any of them is queued in the one session.

## Decisions

1. **A local server always runs.** Every way of making a computer a host (`pikibun connect`, the desktop app's Host
   mode, `pikibun serve`, Self host) makes sure this OS user's local server runs, and starts it headless where none
   does. There is no private session without one.
2. **Private sessions use the local server's own GitHub sign-in.** It already has one: **Settings → Profile →
   Connected accounts** signs github.com in with GitHub's device flow or a token ([Running Pikibun on your own
   computer](../local.md)). No server's GitHub credentials pass to another.
3. **Other servers forward a named, versioned set of session requests** to the local server, through the connection
   they already have to the computer.
4. **While the computer is offline**, other servers show their last list of its private sessions, marked offline, and
   open none of them.
5. **Each computer's local server holds its own private sessions.** A server whose user has paired several computers
   lists all of theirs, each under its computer. Moving a session between computers stays **Move to another host**.
6. **No migration.** **Bring here** is removed. Private sessions that exist already stay where they are and work as
   they do now; new ones are made on the local server. No new session is made portable any more, on any server: what
   is left of portable sessions serves the ones made before, and
   [its removal is planned](portable-sessions.md#removing-the-rest).

## The local server

- **One per OS user.** Its state stays in `~/.local/share/pikibun/server` with its lease
  (`apps/server/src/local/state.ts`), so one runs at a time.
- **Started or found by every host.** `pikibun connect` and the app's host process (`pikibun host --stdio`) make a
  private home (`apps/server/src/local/home.ts`, behind `apps/runner/src/private-home.ts` so the connector doesn't load
  the server unless it is used) that tries to take the state's lease every five seconds. Whichever process gets it runs
  the local server **headless**: on the interfaces its state chooses (every one by default, as `pikibun serve`'s `--listen`), no sign-in link printed, no web app needed, its owner's account
  (`password:<user>`) and private workspace made at start rather than at the first sign-in. Every other process finds
  the running one.
- **Found through its discovery file.** A local server writes `local.json` in its state directory once it listens
  (`apps/server/src/local/discovery.ts`): its process, port, whether it is headless, and a secret made afresh at each
  start (`LOCAL_FORWARD_SECRET`). The file is `0600` in the `0700` state directory, so only this OS user reads it, and
  it is removed when the server stops; one whose process is gone is ignored.
- **Taken over by the one you ask for.** `pikibun serve` and Self host open the state with
  `openLocalStateTakingOver`: a lease held by a headless server is handed over (`POST /api/local/handover` with its
  secret), behind a short `handover.json` marker that keeps the other processes' homes from taking the lease back first.
  A home reads the marker before it waits for the lease and again once it holds it: waiting takes up to five seconds,
  so a home that was already waiting when the marker was written would otherwise take the lease the headless server
  lets go of, and the one you started would find it taken. A home that finds the marker the second time lets go of the
  lease at once.
  The headless server stops; its process's home waits and takes over again once the one you started stops.
- **Its host runs the private sessions.** Its own connector (`<state>/connector`, `apps/server/src/local/host.ts`)
  is the only process that opens them, with the options of the process that started it (models, sandbox, resources),
  so nothing changes hands. Connectors paired with other servers keep running those servers' workspace sessions, as
  now.
- **A session keeps a record of its sandbox.** Whichever process holds the lease decides how the private sessions
  run, and two of a computer's host processes can differ: one started with a sandbox, another without. So a host
  keeps, beside each session's binding, how it last ran (`ran.json`: sandboxed or not, since when;
  `apps/runner/src/sandbox-record.ts`), written when the session opens and only when that changed. A host without a
  sandbox refuses to open a session whose record says it last ran in one, unless it was started to allow that
  ([below](#a-session-that-would-leave-its-sandbox)). This holds for every session on every host, not only private
  ones: the same folder can be opened by a connector started differently.
- **Shared** (`pikibun serve --share`), it is also a team's server and writes no discovery file: its owner's private
  sessions are its own, but other servers can't reach them until it runs for its owner alone again.

## Forwarding

A request about a private session, made on another server, goes **server → that server's connector on the computer
→ the local server**:

1. The other server receives it from its client as for any session (`forwardedSessionRoutes` in
   `apps/server/src/forwarded-sessions.ts`, ahead of the session routes): a session it has no row for, that one of its
   user's connectors reported, is forwarded. It sends the request over the connector's relay as a `private` request
   (`privateConnectorRequest` in `connector-transport.ts`), whose ticket the authority allows only for the connector's
   owner, on a connector that says it forwards (`privateSessions` capability), from its current connection
   (`authorizePrivateTicket`). The server never holds a binding or a ticket for the session.
2. The connector checks the request against the same list (`relay-request.ts`) and passes it to the local server over
   loopback with the discovery file's secret (`x-pikibun-forward`).
3. The local server accepts it only with that secret, only for a route on the list, and only for a session of its
   owner's private workspace, and then acts as its owner (`forwardedOwner` in `authority/auth.ts`): its own access
   checks and redaction apply as to any request of its owner. Its answer, status, type and body, goes back the same
   way, and the other server shows records in it as its own (below).

### The requests

A list of its own, rather than the local server's whole HTTP API (`privateRoute` in
`packages/shared/src/private-sessions.ts`), checked by the connector and by the local server alike, so the two can be
different versions. The connector says which version it forwards in its manifest (`privateSessions: 1`), and a server
forwards only through a connector with a version it knows.

| Request | Does |
|---|---|
| `GET`, `POST /api/private-sessions` | List the private sessions; make a new one with a provider and model the computer offers, a title, and whether it runs on the host |
| `GET /api/sessions/:id` and `view`, `entries`, `events` | The session's record, its view since a revision, earlier entries, and its events, which come back whole, as one poll |
| `PATCH /api/sessions/:id` | Rename it, or show its tool output brief or full |
| `POST` `submit`, `ask`, `stop`, `withdraw`, `revert`, `fork`, `restart`, `sudo`, `uploads`, `tunnel/stop` | Work in the session |
| `POST` `archive`, `unarchive` | As on the session's own server |
| `schedules` (list, create, change, remove, run now) | Its scheduled prompts, which run on the computer |
| `GET` `files`, `changes`, `images`, `artifacts`, `resources`, `audit`, `pull-request`, `connections` | The session panel's tabs and its images |

Anything else a client asks about a forwarded session (share links, session roles, backups, moving it to another
workspace or host) is refused (`private_session_here`) and never reaches the computer: a private session is its
owner's alone.

### What the other server keeps

- **A cached record per session** (`forwarded_sessions`: the session's ID, the connector it came through, its record
  checked field by field, its last activity, and when its row was last written). The connector reports the local
  server's list every five seconds when it changes, and every minute anyway
  (`POST /api/connectors/self/private-sessions`); records in forwarded answers update it too, when they differ from
  what is kept. The session list shows these records in the private workspace, as its owner's, with
  `forwarded: { hostName, online }`, online while the connector is connected and was heard from in the last three
  minutes. Nothing of the conversation is kept.
- **A report it already holds costs nothing** ([below](#reports-by-digest)).
- **Notifications.** A reported change of activity (working to done or failed, or waiting) notifies the owner's devices
  signed in to that server, as for its own sessions. Its feed names the session in `forwarded_session_id`, since there
  is no session row to reference.
- **Nothing else.** Schedules run on the local server only, the session branch and pushes use its GitHub sign-in, and
  backups are its own.

### Reports by digest

A report used to be checked and written whole each time: every record verified, the connector's rows deleted and
inserted again, up to 500 of them, every minute and whenever one session's activity changed. Now:

- **The server answers a report with its digest** (`digest`, a SHA-256 of the session owner and the reported list,
  `apps/server/src/report-digests.ts`) and remembers it for the connector, in memory: one server runs per database
  ([single instance](security-rationale.md#single-instance)), and a restart only means the next report is applied in
  full.
- **A connector that got a digest sends it alone** while its list is unchanged (`{ digest }`, with no `sessions`;
  `apps/runner/src/connector/report-digest.ts`). The server answers a digest it holds with the same digest and
  writes nothing; one it doesn't hold (it restarted, an hour passed, a row changed) with `resend`, and the connector
  sends the list.
- **A whole report whose digest it holds** is neither checked nor written either, so a connector from before this,
  which always sends the list, costs the server one hash.
- **A changed report writes only what changed:** rows whose record or activity differ are written, rows no longer
  reported are deleted, and the rest are left as they are.
- **Online** no longer reads from the rows alone: the server keeps when it last heard from each connector beside the
  digest, and a row's own time serves after a restart until the first report.
- **What ends a digest:** a different report, a forwarded answer that changed a row, an hour (a held report is
  applied in full at least that often), and a restart. A report that was being applied while a forwarded answer
  changed a row is not held, and of two reports applied at once, the one that finishes last ends the other's digest,
  since its rows were written last.
- **Older and newer together.** An older server answers without a digest, so the connector keeps sending the list;
  should a server stop taking digests, the connector falls back to the list. An older connector ignores the answer's
  new field. Nothing in the manifest changes.

The [identity report](portable-sessions.md#a-delegation-is-signed-at-pairing) is handled the same way on the server
alone: its digest covers the delegation, rotations, settings and sessions, and a report it holds skips the signature
checks and the writes. Its answer (`archived`, `sign`) is still worked out each time, and the connector sends the
whole report as before, since older connectors read that answer strictly and it depends on the reported sessions.

### A session that would leave its sandbox

- **Refused by default.** Opening a session whose record says it last ran in a sandbox, on a host that would run it
  without one, fails with a reason the session's page shows (`LEFT_SANDBOX`, status 422, which every server version
  passes on), and the host logs it once a minute at most. Nothing else about the session changes, and a host with a
  sandbox still opens it.
- **Allowed by the host's own user, when they start it.** From a terminal, `--sessions-leave-sandbox` beside
  `--unsafe-no-sandbox` (`pikibun connect` and `pikibun serve`), which the typed confirmation doesn't stand for: a
  service unit that passes `--unsafe-no-sandbox` has no reader. In the desktop app, the consent dialog for running
  unsandboxed says that such sessions are opened too, and the consent covers them: a person reads it each time they
  start the host. A host the app starts again by itself at launch uses the consent given when it was last started,
  as it does for running unsandboxed at all.
- **Recorded and logged.** A session opened this way gets `leftSandboxAt` in its record and a line in the host's log,
  and from then on it opens without the sandbox like any session that never had one.
- **Not asked per session.** The one who can be asked is the user at the host, when the host starts; a prompt on the
  session's page would need a new request through every server and the forwarding list. The session's owner sees the
  refusal's reason, and the host's owner decides. For a private session they are the same person.
- **Sessions from before the record** have none, so they open as before and get one then.
- **A record that is there but can't be read** (damaged, too large, not a file) counts as sandboxed, so it never
  opens a session without the sandbox unasked; the next open writes it again. A session whose record can't be
  written isn't opened: a later open would otherwise go by a record that is wrong.

## In the apps

- The private workspace on any server lists the sessions of every computer its user paired, as ordinary rows: each with
  its computer's name where there is more than one, and **Offline** while its computer is.
- **New session** in the private workspace, on a model of a computer that forwards, makes it on that computer's local
  server.
- An offline computer's sessions are listed but don't open: "Ada's laptop is offline: start it, or open Pikibun on
  it." The desktop app on that computer reads them from its host directly, as [local views](local-views.md) do.
- **Bring here**, its rows and the host page's **Make private sessions portable** go. A session that moved before this
  still shows as moved, read-only, on the server it left.

## Trust

- **The other server can act as the owner** on forwarded sessions while the computer is connected to it, as any
  server can act for a session's owner: it signs its users in. It can't reach another user's private sessions: it
  forwards only through its user's own connectors, the connector only for its owner's tickets, and the local server only
  for its owner's private workspace.
- **It never holds a credential** of the session's: not the binding, tickets, GitHub sign-in or model credentials.
  Disconnecting the computer, or revoking it on that server, ends its access at once.
- **The local server is the authority** for private sessions, which is what portable sessions'
  [Trust](portable-sessions.md#trust) section left undone: no server but the computer's own decides what runs.
- **Only this OS user** reaches the local server as its owner: the forwarding secret is in its private state, which is
  as private as the identity key, and changes at each start.

## What it changed

| Part | Change |
|---|---|
| `apps/server/src/local` | Headless start with its owner and private workspace, the discovery file, hand-over, the private home |
| `apps/runner` | The `private` relay request, forwarded to the home; the `privateSessions` capability; the report of the list; `connect` and the app's host start a home |
| `apps/server` | `forwarded-sessions.ts` (cache, list, forwarding, creation, notifications), `private-sessions.ts` (the local server's list and creation), the `private` ticket in the authority |
| `packages/shared/src/private-sessions.ts` | The list of requests and their shapes |
| `apps/nsh` | Forwarded sessions in the list, by computer and offline; **Bring here** and making sessions portable removed |
| `apps/server/src/portable-sessions.ts` | `GET /api/portable-sessions`, `POST /api/portable-sessions/:id/attach` and `POST /api/connectors/:id/portable` removed, with `portable_offers`; identity reports, settings and detaching kept for sessions that moved before; `portableKeyFor` removed, so no new session gets a `portable_key` |

## Not decided here

- Whether a server should also forward other people's reads of a private session (a share link). Private sessions
  stay their owner's alone until then.
- A private session that needs a machine the owner has no computer on (a GPU elsewhere): it belongs in a workspace.
- Workspace schedules of the private workspace that start a new session each run still make it on the server they run
  on.
