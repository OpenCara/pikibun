# Design: portable sessions

Status: implemented. Signing each request on the owner's devices, so that the server a session is attached to is out
of its trust entirely, is not: see [Trust](#trust). Replaced for new private sessions by
[private sessions on the local server](local-private-sessions.md), which removed **Bring here**: what follows of moving
sessions between servers applies to those made portable before.

## Why

A session in someone's [private workspace](../workspaces.md#your-private-workspace) runs only on their own hosts, and
its conversation and files are already on that host. What the server adds is the relay, sign-in, GitHub, notifications
and schedules, and one decision: who may use the session. In a private workspace that decision is always "its owner".

Before this, the server also owned the session's record, so pairing the host with another server (from a Pikibun on
your own computer to a team's, or back, or the same server again with `--force`) left every private session behind:
the host refused them, as their binding named the old pairing, and the new server had never heard of them.

A **portable session** belongs to its owner's **identity**, a key kept on their hosts, rather than to a server. The
server it is attached to keeps a record for the relay and its features, but the host holds what makes the session
whole and can attach it to another server the same identity's pairing is connected to.

## The identity

- Each OS user's connections on a computer share one Ed25519 key pair, made the first time `pikibun connect`, the
  desktop app's host or `pikibun serve`'s host starts: `~/.local/share/pikibun/identity/key.json`
  (`apps/runner/src/identity.ts`; `--identity-dir` or `PIKIBUN_IDENTITY_DIR` choose another), `0600` in a `0700`
  directory. Two connections starting at once make it once: the file is linked into place, never overwritten.
- Its ID is the public key, base64url. Only the public key and the statements it signs leave the computer.
- `pikibun identity export` writes the key encrypted with a passphrase (scrypt, N = 2¹⁵, and AES-256-GCM), and
  `pikibun identity import` takes it on another computer. Nothing syncs sessions between computers: each host keeps
  its own, and **Move to another host** still moves one.

## Statements

Every statement is canonical JSON (keys sorted, no whitespace) after the line `pikibun identity v1`, signed with
Ed25519 through WebCrypto (`packages/shared/src/identity.ts`, used by the connector and the server alike). Parsing is
strict: an unknown field, a non-origin server or an unknown kind is refused before a signature is checked.

| Kind | Says | Signed by |
|---|---|---|
| `delegation` | the account that paired connector `C` on server `S` acts for key `K` | `K` |
| `session` | session `X` belongs to key `K` (its mark) | `K` |
| `rotation` | key `K1` is replaced by `K2` | `K1` |
| `settings` | version `n` of the private workspace's settings | `K` |

### A delegation is signed at pairing

Pairing already needs the machine's own user, who types a code the account made. So the host signs the delegation for
its pairing itself, and sends it, with its sessions, each time it connects and every minute after
(`POST /api/connectors/self/identity`). The server checks the signature, that `S` is its own origin and `C` the
connector calling, and records it (`identity_delegations`). Nobody signs anything in a browser or on a phone: the apps
hold no key.

## What makes a session portable

At creation (`portableKeyFor` in `apps/server/src/portable-sessions.ts`), a session is portable when it is in its
owner's private workspace, on a host they paired themselves that says it keeps portable sessions (`portableSessions`
capability) and has sent a delegation, and it runs on the host or in the sandbox with no workspace sources (its clones
are made on demand with the owner's own access, on whichever server it is attached to). The server records the key
(`sessions.portable_key`) and the binding says so (`session.portable`). The host, provisioning it, signs its mark and
records it in the identity's index (`<identity>/sessions/<id>.json`: its folder and the mark).

The folder stays where its connection made it. Moving it would break absolute paths in its files (virtual
environments, `node_modules/.bin`), and the index lets every connection of the identity find it.

## Attaching a session to another server

**Bring here**, the button that did this from another server's private workspace, is gone: new private sessions live on
the computer's own Pikibun, which every other server reaches by forwarding ([design](local-private-sessions.md)), and
none moves. What remains serves the sessions that were made portable before, on the host and on the servers they are
attached to:

1. The host reports the portable sessions of its identity with each connection's identity report: ID, title, when each
   was made, where it runs, its model, whether it is attached to this pairing or working, whether the server it is
   attached to has archived it, and its signed mark. A server keeps no list of them any more; it uses the report to
   follow a rotated key, and answers it with the reported sessions attached to it that it has archived (`archived`,
   sent only to a host whose report gives each session an `archived` field, so an older connector, which reads its
   answer strictly, never gets it). The host keeps that in the session's folder (`portable-archived.json`).
2. The host still attaches a session (`attach`) only for its owner, and only one marked by its identity's current key.
   Under a lock in the identity (one attach of a session at a time on the computer), it refuses a session that is
   working or packed; asks the connection that has it open to let go (below); takes the session's open lease; replaces
   the pinned Git identity (`sandbox/owner.gitconfig`) and rewrites the binding kept in the session's own database, as
   a restore does; and only then replaces `binding.json`. Any failure before that puts the Git identity back and leaves
   the binding as it was.
3. The connection that had it notices: each open of a portable session checks that `binding.json` still names its own
   pairing and ID, and so does a sweep every second of the ones it has open, and of the ones it let go of for a
   minute after. It tells its server (`POST /api/connectors/self/portable/detached`), which archives its record as
   **Moved to another server** (`session.detached`), read-only. Such a record can't be unarchived: the session carries
   on where it was moved.

### Open leases between connections

A host's connections are separate processes, one per server, each with its own runtime, and two of them must never
work in one session's database. A connection holds a lease file in each portable session it has open
(`open.lock`: its process ID, a token of the runtime and the word `beat`; `apps/runner/src/portable-lease.ts`), and
another connection refuses to open it while the lease is held. Lease and lock files are written whole before they
appear (linked into place), so none is ever seen empty; one that can't be read is taken as held until it is a minute
old. To attach a session another connection has open, the attaching one asks it to let go (`release` in the session's
folder) and waits up to ten seconds: the other connection closes it at its next sweep unless it is working.

**When a lease is held.** A process ID alone doesn't say so: after a crash or a power loss the operating system gives
the ID to some other process, and a lease read by its ID would then never end. So a lease also has a **heartbeat**
(`apps/runner/src/lock-file.ts`):

- The holder sets the file's modification time every second, from the timer of the sweep above, for every lease it
  holds, after checking the file is still its own. The refresh doesn't wait for the sweep's own work, and goes on
  while the connection closes its sessions.
- A lease is free when its process is gone, as before, or when its heartbeat stopped: the time is more than 15
  seconds from now (either way, so a clock set back doesn't keep one alive), **and** it doesn't move while the taker
  watches it for 3 more seconds. The watch is what keeps a live holder safe: a computer that slept, a clock that
  jumped or a process that was held up all leave an old time, and a live holder refreshes within a second of running
  again. Only a holder that does nothing for 3 seconds while its lease is 15 seconds old loses it, and it then
  notices at its next refresh that the file isn't its own and closes the session at its next sweep, unless it is
  working.
- A lease of the same process (the connection and the host of the computer's own Pikibun share one) is read from
  memory: held while its runtime is.
- A lease without `beat` was written by an older connector, which never refreshes it. It is held while its process
  lives, as before, so a new connection never breaks a live older one's lease; and an older connector reads only the
  first two fields, so it honours a new lease by its process. A computer whose connections were all updated has no
  such lease left once they restarted.
- **Breaking a stale lease.** The taker renames the file away (`open.lock.<random>.stale`), looks at what it moved,
  and deletes it. Of several takers that judged the same lease stale, one rename succeeds and the others find
  nothing to move; all then create their own lease, which only one can (it is linked into place). Deleting by path
  instead let a slower taker remove the lease the faster one had just made. A taker that finds it moved something
  other than the lease it judged (the content or the time differs: another taker's new lease, or the holder's
  refreshed one), or that can't read what it moved, links it back, which never replaces a file. A holder that finds
  its lease missing at one refresh waits for the next before it takes it as lost, since it may be in a taker's hands
  for that moment.

The identity's attach lock (`<identity>/sessions/<id>.lock`: the process ID, `beat` and a random value) works the
same way, refreshed by a timer of its own while the attach runs, and removed afterwards only if it is still the
attach's own. The attach reads it once more just before it rewrites the binding, and stops if the lock is no longer
its own.

**Why not `flock`.** The connector's state and the local server's use a `flock` (or `lockf`) guardian, a child
process per lock, and a named pipe on Windows (`apps/runner/src/lease.ts`), which the kernel releases when the holder
dies. That fits one lock per process. A connection holds one lease per open session, so it would run a child process
for each, on two different mechanisms; the heartbeat is one timer and plain files on Linux, macOS and Windows alike.
The local server's lease and its hand-over ([design](local-private-sessions.md)) are untouched.

### What moves with it, and what doesn't

- **Moves:** the conversation, the files, the title, and its [scheduled prompts](../sessions.md): the server it is
  attached to keeps a copy of its title and schedules on the host (`portable.json`, through the `portable` action, sent
  with each change), and the next server creates them again when it attaches the session and has none for it.
- **Stays on the old server:** activity, push history, share links, backups and session roles. GitHub and other Git
  accounts are each server's own; connect them on the new one.

## Replacing the key

- `pikibun identity rotate` makes a new key, signs a `rotation` with the old one, and signs every mark and the settings
  again with the new one; delegations are signed again at the next report. Each server follows the rotations it is
  sent, for its user's records, only as a whole chain ending at the key the connection signs with. A mark still by an
  earlier key of the chain (a rotation stopped halfway) is signed again the next time the host reports.
- `pikibun identity reset` is for a lost or leaked key: a new key without the old one's signature, the marks and
  settings signed again. It is safe because only someone who can read the identity's directory can run it. Each server
  takes the new delegation from its own connector, which it authenticates, and the marks it reports with it.
- **A running connection follows.** `rotate`, `reset` and `import --replace` run in another process than the
  connections. A connection doesn't keep the key for its lifetime: before each use it compares `key.json`'s inode,
  size and modification time with those of the copy it loaded, and reads the file again when they differ (the file is
  always replaced by a rename, never written in place). So from the moment the command finishes, a connection signs
  with the new key only, marks new sessions with it, and attaches the sessions the command signed again; its next
  identity report, within a minute, signs a new delegation and tells its server. It carries on rather than stopping:
  a reset is what its owner asked for, a restart would do exactly the same on the same files, and stopping would end
  the sessions that are working. Between the command's first write and its last (the key, then the marks), a mark
  still by the old key is left out of a report for that moment, as after a restart at the same instant.

## Private workspace settings

The private workspace's settings that mean something on every server, its name, transcript paging and tool output
default, travel as a `settings` statement. When its owner changes them, the server asks the next identity report to
sign the new version (`sign` in its answer); the host keeps the latest beside its key and sends it with every report.
A server applies a signed version newer than any it applied, so a new server takes the name and defaults the owner set
elsewhere, and none can forge them: the version, the settings and the key are all signed. A change made on this server
that isn't signed yet wins over a version from elsewhere no newer than it: it is signed next, as the newer one.

## Trust

- The server a session is attached to still signs its users in, so it can act as the owner's account there, as for any
  session. It can't attach a portable session to another account, or one of another identity: the host attaches only
  for its pairing's owner and only sessions marked by its key.
- A server can't take a session away from the host or keep it: detaching is the host's decision, made when another of
  its connections attaches it, and the server it left only learns of it.
- Server administrators see that a portable session's record exists, as for any private session. Deleting a user on a
  server removes the records and delegation there; the sessions stay on the hosts.
- Not done: taking the server out of trust entirely needs each request signed by the owner's device and checked by
  the host. It needs keys on the owner's devices, enrolled from the identity, and requests the relay can't forge, and
  it belongs with [#113](https://github.com/OpenCara/pikibun/issues/113)'s direct connections, which the same key can
  serve.
