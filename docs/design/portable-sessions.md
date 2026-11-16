# Design: portable sessions

Status: in progress.

## Why

A session in someone's [private workspace](../workspaces.md#your-private-workspace) runs only on their own hosts, and
its conversation and files are already on that host. What the server adds is the relay, sign-in, GitHub, notifications
and schedules, and one decision: who may use the session. In a private workspace that decision is always "its owner".

Until now the server also owned the session's record, so pairing the host with another server (from a Pikibun on your
own computer to a team's, or back) left every private session behind: the host refused them (their binding names the
old pairing), and the new server had never heard of them.

A **portable session** belongs to its owner's **identity**, a key kept on their hosts, rather than to a server. The
server it is attached to keeps a record for the relay and its features, but the host holds what makes the session
whole, and can attach it to another server the same identity is paired with.

## The identity

- Each OS user's hosts share one Ed25519 key pair, made the first time a connector, the desktop app's host or
  `pikibun serve` starts: `~/.local/share/pikibun/identity/key.json` (`--identity-dir` chooses another), private to the
  user (`0600` in a `0700` directory). Every pairing of that user on that machine uses it, whichever server it is for.
- The identity's ID is the public key, base64url. It is never sent anywhere private: servers see the public key and
  the statements it signs.
- Another machine joins the same identity with `pikibun identity export` and `pikibun identity import`, which carry the
  key in a file encrypted with a passphrase (scrypt and AES-256-GCM). Nothing syncs sessions between machines: each
  host keeps its own.

## Statements

Every statement is canonical JSON (keys sorted, no whitespace) signed with Ed25519, in
`packages/shared/src/identity.ts`:

| Kind | Says | Signed by |
|---|---|---|
| `delegation` | the account that paired connector `C` on server `S` acts for key `K` | `K` |
| `session` | session `X` belongs to key `K` | `K` |
| `rotation` | key `K1` is replaced by `K2` | `K1` |
| `settings` | version `n` of the private workspace's settings is this | `K` |

### Delegation is signed at pairing

Pairing already needs the machine's own user: they type a code that the account made. So the host signs the
delegation for that pairing itself, the first time it connects, and sends it to the server
(`POST /api/connectors/self/identity`). The server checks the signature, and records that the connector's owner acts
for `K` on this server. Nobody signs anything in a browser or on a phone: the apps hold no key.

## What makes a session portable

A session is portable when, at creation, all of these hold:

- it is in the owner's private workspace, on a host the owner paired themselves;
- the host has said it supports portable sessions (`portableSessions` capability) and has sent a delegation;
- it runs [directly on the host](../hosts.md#sessions-on-the-host), or in the sandbox with no workspace sources (its
  clones are made on demand with the owner's own access, wherever the session is attached).

The server marks the row (`sessions.portable_key`) and the binding (`session.portable`). The host, provisioning it,
signs a `session` statement and records the session in the identity's index
(`<identity>/sessions/<id>.json`: its folder, its key and the signed mark). The session's folder stays where the
connector made it: moving it would break absolute paths in its files (virtual environments, `node_modules/.bin`).

## Attaching a session to another server

1. Pair the host with the new server, as usual. Its connector signs a delegation there.
2. It reports the portable sessions in its identity's index (`POST /api/connectors/self/portable`): ID, title, when
   each was made, and the signed mark. The server checks each mark against a key the reporting connector's owner has
   a delegation for, and lists the ones attached elsewhere under **Other servers' sessions** in the private workspace.
3. **Bring here** (`POST /api/portable-sessions/:id/attach` with a model of that host) creates the session's record on
   this server, under the same ID, and asks the host to `attach` it with the new binding.
4. The host attaches it only if: the session's mark is by the key the binding's owner has a delegation for on this
   pairing; the session isn't working (no `working` marker); and no other connector on this machine has it open for
   work. It rewrites `binding.json` (the only file that names the server) under the identity's lock, then opens it.
5. The connector that had it before notices the next time it opens it (every open checks that `binding.json` still
   names its own pairing) and tells its server (`POST /api/connectors/self/portable/detached`), which archives its
   record as **Moved to another server** (`session.detached`). Bringing it back is the same step in the other
   direction: an existing record with the same ID is reopened instead of a new one made.

Session IDs are UUIDs, so one session keeps one ID on every server.

### What moves with it, and what doesn't

- **Moves:** the conversation, the files, the title, and its [scheduled prompts](../sessions.md): the server that has
  it keeps a copy of its schedules on the host (`schedules.json`, sent with each change), and the next server creates
  them again when it attaches the session.
- **Stays on the old server:** activity, push history, share links, backups and session roles. GitHub and other Git
  accounts are each server's own: connect them on the new one.

## Converting existing sessions

**Make private sessions portable** on a host's page (`POST /api/hosts/:id/portable`) converts the owner's existing
private sessions on that host that qualify (above): the server marks each, and the host signs and indexes them
(`attach` with the session's current binding). Sessions working at the time are skipped and can be converted later.

## Losing or replacing the key

- `pikibun identity rotate` makes a new key, signs a `rotation` with the old one, re-signs every mark and delegation
  in the index with the new one, and sends the rotation to each server with the delegation. Servers accept a rotation
  only signed by a key their user has a delegation for.
- `pikibun identity reset` is for a lost or leaked key: it makes a new key without the old one's signature and
  re-signs this host's own sessions. It is safe because only someone who can already read the host's state can run
  it. Its delegations are signed again at the next connection, and the old key's delegations on each server are
  replaced by the connector's new one.
- `pikibun identity export` writes an encrypted copy, for backup or for another machine.

## Private workspace settings

The settings of the private workspace that mean something on every server (its name, the extensions its sessions
run, the transcript and tool output defaults) are kept in a `settings` statement signed by the identity. When the
owner changes them, the server sends them to the owner's connected hosts (`settings` in the host's config answer),
which sign the new version and keep it beside the key. A host paired with a new server sends its latest version with
its delegation, and the server applies it when its version is newer than the one it applied. A server can't forge
one, since only the host's key signs them.

## Trust

- The server a session is attached to still signs its users in, so it can act as the owner's account there, as for
  any session. It can't attach a portable session to another account: the host attaches only to the account its own
  pairing delegates to, and only sessions whose mark is by that key.
- A server can't take a session away from the host: detaching is the host's decision, made when another of its
  pairings attaches it.
- Server administrators see that a portable session's record exists, as for any private session; deleting a user on
  a server removes its records and delegation, and the sessions stay on the hosts.
- Taking the server out of trust entirely needs each request signed by the owner's device, checked by the host: see
  [#113](https://github.com/OpenCara/pikibun/issues/113), which this key is meant to serve.
