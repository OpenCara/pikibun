# Design: reading sessions from this computer's host

Status: implemented, for the desktop apps' [host](../desktop/host.md) mode.

## What it does

The server relays every read of a session to its host (see [How it works](../how-it-works.md)). When the desktop app
also runs the host, as **Settings → This Mac**, that is a round trip from the app to the server and back to the same
computer, and a session running a few centimetres away can't be followed at all while the server can't be reached.

So the desktop app reads a session that its own host runs **from that host first**:

- It reads the session's view straight from the host it started, over the `pikibun host --stdio` channel it already
  has (`view` and `entries` in `packages/shared/src/app-host-protocol.ts`), about twice a second while the session works and
  every 1.5 seconds while it is idle. Only what changed crosses the channel after the first read, as with the server.
- It still asks the server, every 30 seconds as before, whether the signed-in account may read the session. A refusal
  (401, 403, 404) stops the reads at once, and so does the server's record saying the session runs on another host.
- While the server can't be reached (no answer from Pikibun's API: the network fails, or a proxy in front of it gives up
  with a gateway error), reads of a session the server said runs here carry on from the host, and the page shows no
  error. A server that answers with an error of its own isn't unreachable, and vouches for nothing. The session is then
  **read-only**: sending, stopping, approvals and everything else that changes a session go through the server, as
  always.
- Where the host can't answer (it stopped, it hasn't connected since it started, the session isn't on it), the app goes
  back to the server's stream at once, and asks the host again at the next access check, 30 seconds later.

Every other client, and the desktop app for sessions on other hosts, reads through the server as before.

## Who may read what

The host serves a read from the app without asking the server: the app is the process that started it, as the same OS
user, through a pipe no one else holds. That user is the host's operator, who can already see the prompts and files of
every session on it ([Sharing a host](../hosts.md#sharing-a-host)), and can read the host's state directory anyway, so
the channel gives them nothing new.

The app holds itself to more than that, so that it shows each signed-in account only what the server would:

- It reads from the host only sessions the server said, for the account signed in, run on this computer's host
  (`connectorId`), on the server that host is paired with (`apps/nsh/src/lib/local-sessions.ts`). It learns them from
  the session list and from each session's record, and forgets them when the account changes.
- A view read from the host shows only once the server has said, in that live session, that the account may read it
  (`confirmHere` in `packages/client/src/live-session.ts`), or couldn't be reached at all to say otherwise. A session
  opened from memory while the server is up waits for its answer, and keeps waiting while the server answers with
  errors. Once vouched for, a later error doesn't stop the reads, as it doesn't stop the server's stream.
- The host shapes the view as the server does (`apps/runner/src/local-view.ts`): secrets redacted, approvals left out,
  tool output brief where the session keeps it brief (`toolOutput` in the server's record).

## What differs from the server's view

The host shows each conversation's latest 50 entries, with **earlier messages** a click away, whatever the workspace's
transcript paging says: the workspace setting is the server's, and one read over the channel stays small. Earlier
entries come from the host too, and from the server where the host can't read them.

## Where it lives

| Part | File |
|---|---|
| The view the host shows the app, and its revisions | `apps/runner/src/local-view.ts`, `RunnerService.localView` and `localEntries` in `apps/runner/src/server.ts` |
| Reading it through the connector's runtime, which outlives the relay connection | `LocalConnector.localView` in `apps/runner/src/connector.ts` |
| The `view` and `entries` requests | `packages/shared/src/app-host-protocol.ts`, `apps/runner/src/app-host.ts` |
| The app's side of the channel, which never starts the host to read | `readView`, `readEntries` in `apps/nsh/src/lib/this-computer.ts` |
| Which sessions run here | `apps/nsh/src/lib/local-sessions.ts` |
| Reading here first, falling back to the server, and the access checks | `startLiveSession` in `packages/client/src/live-session.ts` |

## Limits

- The host must have connected to the server once since it started: the connector makes its runtime then. A host
  started while the server is down serves nothing until it first connects.
- The app's session list, workspaces and sign-in still come from the server. Opening the app while the server can't be
  reached shows **Can't reach Pikibun**, as before; what carries on is a session already open, or opened from the list
  already loaded.
- **Self host** runs the server on this computer too, so it gains nothing here beyond the relay hop.
