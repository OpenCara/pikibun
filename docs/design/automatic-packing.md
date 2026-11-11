# Automatic packing of archived sessions

Status: implemented. What people see is in [Packing archived sessions](../backups.md#packing-archived-sessions); this
note says why it works as it does.

## Why packs keep ignored files

A pack deletes the session's files, so whatever it leaves out is gone for good once it is written. A pack someone asks
for can leave out whatever its confirmation says, but one nobody asked for can't quietly drop a clone's `.env` file or
local database just because `.gitignore` names it. So packs keep a clone's ignored files, except what installing and
building bring back: anything in a directory named in `PACK_REBUILDABLE_DIRS`, and files ending in
`PACK_REBUILDABLE_SUFFIXES` (`apps/runner/src/sandbox-python/helper.py`).

- **How.** `pack_ignored_files` lists the clone's ignored paths with `git ls-files --others --ignored --exclude-standard
  --directory`, so a whole ignored directory such as `node_modules/` is one entry and is skipped without being walked.
  Other ignored directories are walked in Python, pruning the same names. What is kept is added with `git add -f` to the
  same temporary index the backup's worktree commit is written from, so it travels in the clone's bundle and unpacking
  checks it out with the rest (`read-tree --reset -u`), then resets the index to `HEAD`: the files are back, ignored as
  before. The clone's own index is never touched.
- **Limits before Git.** `git add` writes each file into the clone's object store before the bundle's budget is
  known, and a failed pack leaves those objects behind. So the ignored files are listed, counted and their sizes summed
  before the clone's first `git add`, up to `MAX_PACK_IGNORED_BYTES` and `MAX_PACK_IGNORED_FILES`. A clone over either,
  or with a Git repository among them (below), is refused before Git writes anything. A file that goes while they are
  listed is skipped.
- **Git repositories among ignored files.** Clones are looked for only so deep (`find_clones`). A repository deeper
  than that in an ignored directory would be added as a bare gitlink, its contents lost, so it is refused instead.
- **Backups don't keep ignored files.** A backup deletes nothing, so it keeps what it did, and stays as small as before.
- **Older connectors.** A connector without the `packIgnoredFiles` capability drops every ignored file. Packing by hand
  still works there, as its confirmation says; automatic packing asks again a day later, until the host is updated. A
  host without the sandbox, or a session that runs directly on its host, can never pack, and isn't asked again.

## Why a week, and why the server asks

Packing makes unarchiving slower (the clones are cloned again) and needs the host online, so a session archived by
mistake, or to tidy the list for a day, should be unarchived as it was. A week after archiving
(`automaticPackingDays`, `packages/shared/src/packing.ts`) most sessions that will come back have.

The server decides, not the host, because the server knows when a session was archived, its workspace's setting and its
owner's access, and audits the pack. `sessions.pack_due_at` is set when a session is archived (by its owner, an admin, a
one-shot schedule or a host move), cleared when it is unarchived, packed or refused, and moved on while it can't be
packed yet. Sessions archived before this got their week from the migration.

The sweep (`runAutomaticPacking`, `apps/server/src/automatic-packing.ts`, every five minutes, ten sessions at a time):

- **Only hosts that are connected** (`connectors.connection_hash`). `packSession` marks a session packed before it asks
  the host, so that a pack whose outcome is unclear is unpacked all the same. Asking an offline host would mark it
  packed with nothing packed, and unarchiving it would then need the host online, which unarchiving an unpacked session
  doesn't.
- **As the session's owner**, through `asSessionOwner`, as automatic backups and one-shot archiving do: the host checks
  that the ticket's actor is the owner for `pack` and `unpack`, and nothing else may ask it to.
- **A refusal is final.** A 422 from the host (too large, a stash, a macOS host ...), a frozen session, or an owner who
  lost access clears `pack_due_at` and is audited as `session.pack_refused` with the host's reason, so it isn't asked
  again every few minutes. Anything else tries again an hour later. A busy host (409) has `packed_at` cleared by
  `packSession`, as nothing was packed. A pack whose outcome is unclear (the host gone mid-way, a timeout, an invalid
  answer) keeps `packed_at`, so unarchiving meanwhile unpacks whatever the host packed (`unpack` answers
  `{unpacked: false}` where it packed nothing), and the sweep asks again: a host that did pack answers `{packed: true}`
  at once, and one that didn't packs now. Either way `pack_due_at` is cleared and the pack audited once it succeeds.

## Unarchiving a packed session

Unpacking and reopening go to the host as the session's owner, whoever of those who manage it unarchives it. Before,
only the owner could unarchive a packed session. With packing automatic most archived sessions would be packed, and a
workspace's owners and admins, who unarchive any session, would lose that. Unpacking only puts back the owner's own
files on the owner's own session, and the host clones again with the owner's access as it would when the owner opens
it: it lets nobody act as the owner beyond what unarchiving already allows them.
