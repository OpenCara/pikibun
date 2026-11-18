# Design: private sessions live on the local server

Status: proposed. It replaces moving sessions between servers ([portable sessions](portable-sessions.md)) for new
private sessions, and removes **Bring here**.

## Why

A session in someone's [private workspace](../workspaces.md#your-private-workspace) runs only on their own computers,
and its conversation and files already live there. [Portable sessions](portable-sessions.md) let such a session move
between the Pikibun servers a computer is paired with, but it is attached to one server at a time: every other server
lists it with **Bring here**, and the one it left shows it as **Moved to another server**. Someone who uses two servers
(their own Pikibun and a team's, or `pikibun.com` on a phone and a laptop) sees each session on one server only, and
moves it by hand.

The servers can't share a session as things are. Each pairing on a computer is its own connection process, and a
session's database and agent belong to the one that has it open (`open.lock`). Its binding names one server, one owner
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
   they do now; new ones are made on the local server.

## The local server

- **One per OS user.** Its state stays in `~/.local/share/pikibun/server` with its lease
  (`apps/server/src/local/state.ts`), so one runs at a time. Whichever command needs it first starts it; the others
  find it through a file in its state directory naming its loopback port and process, written whole when it listens
  and removed when it stops, and check that the process still holds the lease.
- **Headless when no one asked to see it.** Started by `pikibun connect` or the app's Host mode, it serves only
  loopback, as it does now, with no sign-in link printed. `pikibun serve` and Self host keep showing theirs. A computer
  that is someone's host without its owner ever opening the local server still has one.
- **Its owner is this OS user's identity.** Its owner's account is made at its first start, as at the first sign-in
  now (`password:<user>`), and it records the identity's public key as its owner's
  (`~/.local/share/pikibun/identity`, [The identity](portable-sessions.md#the-identity)).
- **Its host runs the private sessions.** Its own connector (`<state>/connector`, `apps/server/src/local/host.ts`)
  is the only process that opens them, so nothing changes hands. Connectors paired with other servers keep running
  those servers' workspace sessions, as now, and run no private ones.
- **Shared** (`pikibun serve --share`), it is also a team's server, and its owner's private sessions are still its
  own.

## Forwarding

A request about a private session, made on another server, goes **server → that server's connector on the computer
→ the local server**:

1. The other server receives it from its client as for any session, and sees that the session is a forwarded private
   one (its cached record below). It checks only that the account asking owns the private workspace, then sends the
   request over the connector's relay connection, which is already authenticated. It never sees a binding or a ticket
   for the session.
2. The connector forwards it to the local server over loopback, signed with the identity key: the statement names the
   other server's origin, its own connector ID, the account there, the request and a fresh nonce and time.
3. The local server accepts it only signed by its owner's identity key, for a connector of that identity, and acts as
   its owner. Its own access checks, approvals and redaction apply as to any request of its owner. A refused or
   unknown request is answered as an error, which the other server passes on.

### The requests

A protocol of its own, rather than the local server's whole HTTP API, so each side checks every field
(`packages/shared/src/private-sessions.ts`, by [request schemas](request-schemas.md)), and so the two can be different
versions. The connector says which version it forwards in its manifest (`privateSessions: <version>`), a server
offers forwarded private sessions only from a connector with one it knows, and a newer local server answers an older
version's requests.

| Request | Does |
|---|---|
| `list` | The private sessions with their records (title, status, activity, model, archived, packed, schedules due), and the models the computer offers |
| `create` | A new session, with a model of the computer and the first message |
| `view`, `entries`, `events` | The session's view since a revision, earlier entries, and its live stream, as a view is relayed now |
| `submit`, `ask`, `stop`, `withdraw` | Send a message or side question, stop the session, take back a queued message |
| `approve` | Answer an approval card |
| `rename`, `archive`, `unarchive`, `delete` | As on the session's own server |
| `schedules` | List, create, change and remove its scheduled prompts |
| `files`, `changes`, `artifacts`, `image`, `upload` | The session panel's tabs and attachments |

Anything else a client asks about a forwarded session (share links, session roles, moving it to another workspace) is
refused: a private session is its owner's alone.

### What the other server keeps

- **A cached record per session** (`forwarded_sessions`: the session's ID, the connector it came through, its title,
  status, activity, archived, and when last seen), refreshed from `list` each time the computer connects and from
  the changes it reports after. It lets the session list, search and notifications work without asking the computer,
  and is what shows while the computer is offline. Nothing of the conversation is kept.
- **Notifications.** The local server reports each private session's activity changes (working, waiting for an
  approval, finished, failed) to every server the computer is paired with, through those connectors, as connectors
  report activity now (`POST /api/connectors/self/activity`). Each server notifies its own signed-in devices.
- **Nothing else.** Schedules run on the local server only, the session branch and pushes use its GitHub sign-in, and
  backups are its own.

## In the apps

- The private workspace on any server lists the sessions of every computer its user paired: each with its computer's
  name where there is more than one, and **Offline** while its computer is.
- **New session** in the private workspace chooses among the computers' models and makes it on that computer's local
  server.
- An offline computer's sessions are listed but don't open: "This computer is offline: start it, or open Pikibun on
  it." The desktop app on that computer reads them from its host directly, as [local views](local-views.md) do now.
- **Bring here**, its rows and **Moved to another server** go. A session that moved before this still shows as moved,
  read-only, on the server it left.

## Trust

- **The other server can act as the owner** on forwarded sessions while the computer is connected to it, as any
  server can act for a session's owner now: it signs its users in. It can't reach another user's private sessions:
  the connector forwards only for the account that paired it, and the local server only for its owner's identity.
- **It never holds a credential** of the session's: not the binding, tickets, GitHub sign-in or model credentials.
  Disconnecting the computer, or revoking it on that server, ends its access at once.
- **The local server is the authority** for private sessions, which is what portable sessions'
  [Trust](portable-sessions.md#trust) section left undone: no server but the computer's own decides what runs.
- **Only this OS user** can sign with the identity key, start the local server or read its state, as now.

## What it changes

| Part | Change |
|---|---|
| `apps/server/src/local` | A local server started headless, found through its state directory, with its owner's identity key recorded |
| `apps/runner` (connector) | Start or find the local server; forward private-session requests, signed; report its sessions' activity to the server it is paired with |
| `apps/server` | Forwarded private sessions: the cached records, the forwarding of each request, the `privateSessions` capability; no new portable sessions on servers other than the local one |
| `packages/shared` | The private-session requests and their schemas |
| `apps/nsh` | The private workspace's list from forwarded sessions, the computer picker, the offline state; **Bring here** removed |
| `apps/server/src/portable-sessions.ts` | `GET /api/portable-sessions` and `POST /api/portable-sessions/:id/attach` removed, with `portable_offers`; reports and detaching kept for sessions that moved before |

## In order

1. The local server always runs: started or found by every connector, headless, owned by the identity.
2. Forwarding, for `list`, `view`, `entries`, `events`, `submit`, `stop` and `approve`: enough to follow and work in a
   private session from another server.
3. The rest of the requests, notifications and the offline list.
4. New private sessions made on the local server from every server; **Bring here** removed.

## Not decided here

- Whether a server should also forward other people's reads of a private session (a share link). Private sessions
  stay their owner's alone until then.
- A private session that needs a machine the owner has no computer on (a GPU elsewhere): it belongs in a workspace.
