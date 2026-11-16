# Design: portable sessions

Status: implemented. Signing each request on the owner's devices, so that the server a session is attached to is out
of its trust entirely, is not: see [Trust](#trust).

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

1. The host, paired with the new server, reports the portable sessions of its identity: ID, title, when each was made,
   where it runs, its model, whether it is attached to this pairing or working, and its signed mark. The server keeps
   the ones whose mark is by the delegated key (`portable_offers`) and lists those not attached here under the private
   workspace, with **Bring here** (`GET /api/portable-sessions`). The host reports titles as plain single lines, and a
   session the server can't take is left out of the list rather than refusing the report.
2. **Bring here** (`POST /api/portable-sessions/:id/attach`, with the host and optionally a model of it) makes the
   session's record, private, under the same ID, and asks the host to `attach` it with the new binding.
3. The host attaches it only for its owner, and only a session marked by its identity's current key. Under a lock in
   the identity (one attach of a session at a time on the computer), it refuses a session that is working or packed;
   asks the connection that has it open to let go (below); takes the session's open lease; replaces the pinned Git
   identity (`sandbox/owner.gitconfig`, which pins the owner's name and email) and rewrites the binding kept in the
   session's own database, as a restore does: interrupted cards stay history, used tickets and grants are dropped; and
   only then replaces `binding.json`. Any failure before that puts the Git identity back and leaves the binding as it
   was.
4. The connection that had it notices: each open of a portable session checks that `binding.json` still names its own
   pairing and ID, and so does a sweep every second of the ones it has open, and of the ones it let go of for a
   minute after. It tells its server (`POST /api/connectors/self/portable/detached`), which archives its record as
   **Moved to another server** (`session.detached`). Such a record can't be unarchived: it is brought back as in 2.

Session IDs are UUIDs, so a session keeps its ID on every server. Bringing it back to a server that has its record
reopens that record, when the session comes back through the same pairing. A record there under another pairing (the
host was paired again with `--force`) can't change its host, which is immutable, so the session is attached under a
new ID (`sourceSessionId` in the request): the host signs a mark for the new ID, forgets the old one, and the old record
is archived as moved.

### Open leases between connections

A host's connections are separate processes, one per server, each with its own runtime, and two of them must never
work in one session's database. A connection holds a lease file in each portable session it has open
(`open.lock`: its process ID and a token of the runtime; `apps/runner/src/portable-lease.ts`), and another connection
refuses to open it while that process lives. Lease and lock files are written whole before they appear (linked into
place), so none is ever seen empty; one that can't be read is taken as held until it is a minute old. To attach a session another connection has open, the attaching one asks
it to let go (`release` in the session's folder) and waits up to ten seconds: the other connection closes it at its
next sweep unless it is working.

### What moves with it, and what doesn't

- **Moves:** the conversation, the files, the title, and its [scheduled prompts](../sessions.md): the server it is
  attached to keeps a copy of its title and schedules on the host (`portable.json`, through the `portable` action, sent
  with each change), and the next server creates them again when it attaches the session and has none for it.
- **Stays on the old server:** activity, push history, share links, backups and session roles. GitHub and other Git
  accounts are each server's own; connect them on the new one.

## Converting existing sessions

**Make private sessions portable** on a host's page (`POST /api/connectors/:id/portable`) converts its owner's private
sessions on that host that qualify and are idle, fifty at a time, each batch after the last one it tried (`after`), so
ones the host refuses don't hold up the rest: the server records the key and asks the host to `attach` each with its
current binding, which marks and indexes it. Those the host refuses, working ones say, keep their record as it was.

## Replacing the key

- `pikibun identity rotate` makes a new key, signs a `rotation` with the old one, and signs every mark and the settings
  again with the new one; delegations are signed again at the next connection. Each server follows the rotations it is
  sent, for its user's records, only as a whole chain ending at the key the connection signs with. A mark still by an
  earlier key of the chain (a rotation stopped halfway) is signed again the next time the host reports.
- `pikibun identity reset` is for a lost or leaked key: a new key without the old one's signature, the marks and
  settings signed again. It is safe because only someone who can read the identity's directory can run it. Each server
  takes the new delegation from its own connector, which it authenticates, and the marks it reports with it.

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
