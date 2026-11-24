# Design: host build caches

Status: phases 1, 2 and 3 built (#472). Phase 1: the workspace's caches, the host setting, the role rule and the
connector endpoint on the Pikibun server (`packages/shared/src/build-caches.ts`, `apps/server/src/build-caches.ts`).
Phase 2: the Linux and macOS connectors (`apps/runner/src/build-caches.ts`, `build-cache-janitor.ts`, the mounts in
`sandbox.ts`, `helper-workspace.ts` and `seatbelt.ts`, `--build-caches` and its check in `resources.ts`, `pikibun cache`).
Phase 3: the client's settings (the workspace's **Build caches** section and the host's **Build caches** setting); which
copy each member gets isn't shown yet. The phases at the end say what follows.

Sessions on a host share Git mirrors and Git LFS files through the [repository cache](repository-cache.md), but
nothing they build. Every session compiles, encodes and bakes from scratch, and a restored or moved session does it
again, since packs and backups leave build output out ([backups.md](../backups.md)). A host build cache is a directory
the host keeps for a workspace, which sessions' commands see at a path an environment variable names, so the tools
that already keep a cache directory (ccache's `CCACHE_DIR`, sccache's `SCCACHE_DIR`, Gradle's local build cache,
Bazel's `--disk_cache`, Turborepo and Nx, ParadiseEngine's `PARADISE_EXPORT_CACHE` asset artifacts) keep it there.
Pikibun knows nothing about the tools.

## What a workspace declares

A workspace's owner or an admin declares **build caches** under **Settings → Workspaces →** the workspace **→ Build
caches**, at most 16:

| Field | Meaning |
|---|---|
| `name` | `^[a-z0-9][a-z0-9-]{0,39}$`, unique in the workspace: names the directory |
| `env` | The variable commands get its path in: `^[A-Z_][A-Z0-9_]{0,63}$`, never `PATH`, `HOME`, `TMPDIR`, `LD_*`, `DYLD_*`, `PYTHON*`, `NODE_OPTIONS`, `GIT_*`, `SSH_*` or a variable the sandbox sets itself |
| `writerGroups` | Optional tool groups that narrow who writes the shared copy (below); empty means the role rule alone |

Stored in `workspace_build_caches` (`workspace_id`, `name`, `env`, `writer_groups_json`, `created_by`, `created_at`,
`updated_by`, `updated_at`; unique on `workspace_id, name`), for SQLite and Postgres. `GET /api/workspaces/:id/build-caches`
(every member), `PUT /api/workspaces/:id/build-caches/:name` and `DELETE …/:name` (owner and admins), audited as
`workspace.build_cache.created`, `.updated`, `.deleted`. Deleting one doesn't delete what hosts keep of it; `pikibun
cache prune` does, once nothing has used it for its cutoff.

## What a host keeps

The host's owner turns them on with a new owner-only host setting, **Build caches** (`HostConfig.buildCaches`):

- `off` (the default): no session gets one.
- `workspace`: the trust rule below decides, per session, between the workspace's shared copy and the owner's own.
- `owner`: every session gets its owner's own copy, whatever the rule says, for hosts whose owner wants no sharing
  between people at all (the build-cache twin of the repository cache's **Per owner**).

```text
build-caches/<workspace id>/<cache name>/shared/                 # the workspace's shared copy
build-caches/<workspace id>/<cache name>/owners/<hash of owner>/ # one per session owner
```

The root is a private directory of the connector's user under its state directory, checked as the repository cache's
is. Only commands and services see a cache (`bash`, the program tools and `startService`), never the file tools, the
file browser, snapshots or packs, so a cache never enters a backup, a pack, a move or an export, and a restored or
moved session simply gets the cache again on that host, or an empty one on another. Nothing is needed for restores.

## Trust: whoever can already change your sessions

A build-cache entry is named by a digest of its inputs, not of its content, so neither the host nor the next reader
can check it: whoever writes a cache can make every session that reads it run what they wrote. That adds a risk only
where the writer couldn't already change the reader's sessions, and the workspace's roles already settle that
([workspaces.md](../workspaces.md), [collaboration.md](../collaboration.md)): the owner, admins and collaborators send
messages to every session of the workspace and run its tools as its owner, and nothing (no session role) takes that
from them; members act in their own sessions only. A message runs only the tools both the owner's and the sender's
tool groups have, so the sender must also be able to change files.

So the Pikibun server decides each session's copy from its owner's membership, and whether a command writes it from
the sender of the message that runs the command:

| Session owner | Gets |
|---|---|
| Workspace owner, admin or collaborator whose tool group has `write` | the **shared** copy |
| Anyone else (members, collaborators whose group can't write files) | their **own** copy |

| The message's sender | Mounts that copy |
|---|---|
| Passes the copy's writer rule, and so does everyone holding a session role that sends this session messages | read-write |
| Anyone else, and anything no message started (services) | read-only |

The **writer rule** of the shared copy is the first row above, applied to the sender (with the cache's writer groups).
The writer rule of an owner's own copy is: its owner, or someone whose workspace role messages every session (the
workspace's owner, admins and collaborators) and whose tool group has `write`. Both say the same thing: the sender can
already change every session that reads the copy (`buildCacheWrites`).

- Two people on the shared copy can each already write files in the other's sessions (both roles message every
  session; both groups have `write`, so their intersection has it), so neither trusts the other more than today.
- A member never writes what others read, and in this version never reads the shared copy either. Letting members
  read the shared copy under their own (an overlay) is safe by the same rule, since everyone writing the shared copy
  can already change the member's sessions, but it needs overlayfs or a tool's read-only secondary cache, so it is a
  later phase.
- **A per-session Collaborator role doesn't make a writer**: it reaches one session, not every reader's. A member who
  holds one on an admin's session sends messages whose commands run there, so the copy is chosen from the owner and
  its access from the sender: the member's commands read the admin's copy and never write it (finding 75 of #479; the
  first version chose from the owner alone, so the member wrote the copy every admin and collaborator reads). The same
  holds for a member's own copy, which all of that member's sessions read: another member with a session role on one
  of them reads it only.
- **While such a role is held, nobody's message writes the copy from that session.** The member's message can leave
  anything in the worktree (a compiler wrapper, a changed build script), and the owner's next build would run it with
  the copy writable. So the Pikibun server answers read-only for every sender while someone who fails the copy's rule
  holds a session role with `write` there, and read-write again once the role is revoked. What an earlier holder left
  in the worktree stays: see the next section.
- **Who the sender is.** The person whose message started the run (`run.initiatedBy` on the host, the admission's
  actor on the Pikibun server). A scheduled prompt is sent as the session's owner, so it counts as the owner. A
  cross-session message is sent as the person whose message the sending session was working on, so it counts as that
  person, whichever session it came from. No message is started by an event without a person today.
- **Services only read.** A server the session keeps running (the tunnel's, an extension's process) outlives the
  message that started it, and a later message from someone else can change the files it runs. It gets the caches
  read-only whoever started it, and the host enforces that whatever the answer says. A command no message's sender
  started (the Review tab's `git` read) gets no cache at all.
- **Writer groups narrow, never widen.** A cache that names `writerGroups` gives the shared copy only to the
  workspace's owner and to people in those groups who also pass the role rule; everyone else gets their own copy.
  Tool groups say what someone may run, not whom others trust, so they can't make anyone a writer the role rule leaves
  out. Deleting a named group leaves the cache with the groups that remain; with none left it falls back to the
  workspace owner alone, never to everyone.
- A personal workspace has one person, so its shared copy and its owner's are the same people; it uses the shared one.

The rule runs on the Pikibun server, not the host, so a change to it reaches every host without a connector release,
and the host learns only the answer.

### What writes a cache is code, not a person

The rule above is about people, but what writes a cache is code running in a sandbox, and the sandbox exists because
sessions run code nobody reviewed: a dependency's install script, the tests of a repository from outside the workspace,
a program the agent ran after reading something hostile, a file an earlier message left in the worktree. Without
caches such code is confined to its session's worktree and home. With a cache mounted read-write it can leave an
entry, named by its inputs, that a later build in another writer's session takes as its own output and runs with that
session's credentials. A shared copy therefore carries one sandbox's compromise into the other writers' sessions, as a
shared CI cache does between jobs (finding 77 of #479). Nothing in Pikibun prevents it; what bounds it:

- the feature is off by default and turning it on is the host owner's decision, which the confirmation says;
- `owner` mode shares nothing between people, so a compromise stays within one person's sessions on that host;
- caches are never mounted for sessions on the host, nor for the file tools;
- messages of senders outside the writers, and services, mount caches read-only;
- `identity` tells the agent so (`buildCachesNote`), and that it can unset a cache's variable for a build it has no
  reason to trust.

**Considered, not built:** mounting the shared copy read-only for a session whose clones include a repository from
outside the workspace. The Pikibun server doesn't know a clone session's clones (the host does, and the rule must stay
on the Pikibun server), a session's first build often precedes the clone that would taint it, and a workspace's own
repositories pull in unreviewed dependencies just the same, so the line would be drawn in the wrong place. Messages
started from an external event don't exist yet; when they do, they should count as a sender who fails every rule
(`{ kind: "none" }` in `sessionBuildCaches`), which is one line. A workspace that builds code it doesn't trust should
use `owner` mode or writer groups until entries can be attributed.

## Delivering it to the host

`POST /api/connectors/self/build-caches` with `{ sessionId, senderId }`, after `requireCallbackScope` as for cache warming,
answers `{ caches: [{ name, env, scope: "shared" | "owner", access: "write" | "read" }] }` from the session's workspace's
caches, its owner's and the sender's roles and tool groups, the session roles held on it, and the asking host's setting:
`off` answers no caches, and `owner` turns every `shared` into `owner`, so the host needs no rule of its own
(`sessionBuildCachesFor`). `senderId` is the person whose message runs the command, or `null` for what no message
started (a service), which answers `read` throughout. The connector asks before a command, for that command's sender,
and again once its last answer for that sender is 30 seconds old (as it keeps the host's configuration), so a role,
group or session-role change reaches the next command within half a minute, and a command already running keeps what
it started with. It keeps each sender's answer apart (the latest 32 senders), so an answer kept for an admin's message
is never used for a member's. A failed request keeps that sender's last answer for at most 5 minutes, then mounts
nothing: a cache is a speed-up, and a stale grant is not.

**Older connectors and servers.** A connector from before this names no sender and mounts whatever it is given
read-write for every message, and it ignores `access`. The Pikibun server can tell (the request has no `senderId`), so
it answers such a connector with a cache only where everyone who may send that session a message that acts (its
owner, the workspace's owner, admins and collaborators, and holders of a session role with `write`) passes the copy's
writer rule, and leaves the cache out otherwise: no cache is slower, and never writable for the wrong person. A grant
made after the answer still takes that connector's 30 seconds to apply. A connector with this change talking to a
Pikibun server from before it is refused (the older server takes `{ sessionId }` alone), so it mounts nothing until
the server is updated. An answer without `access`, or with a value the connector doesn't know, is read as `read`. Connectors advertise `buildCaches: true`; the Pikibun server sends the host setting only to those, and
**Settings → Hosts** says a host must update to offer it.

## Mounting

The connector makes the directory (owned by its user, mode 0700) before the command and exposes it:

- **Linux (bubblewrap):** `--bind <dir> /build-caches/<name>` and `--setenv <env> /build-caches/<name>`, beside
  `/repository-mirrors`. Every
  session sees the same path, so tools that write absolute paths into their cache (ccache's manifests, Gradle's)
  find them again in another session.
- **macOS (Seatbelt):** the real path, with `(allow file-read* file-write* (subpath …))` beside the session's own
  grants; the variable names the real path. Long-lived processes (`processCommand`) don't get caches in this version.
- **Read-only steps** get the cache read-only (`--ro-bind`, or the read grant alone), so a Read-only message's command
  can use what is there and write nothing.
- **A cache answered `read`** is mounted the same way, cache by cache, in a step that otherwise writes: one command can
  have its owner's copy of one cache read-write and the shared copy of another read-only. Both platforms can mount
  read-only, so no cache is left out for want of it. A tool pointed at a directory it can't write may fail rather than only read it;
  some have a setting for that (ccache's `CCACHE_READONLY`), which the agent can set for the command, and `identity`
  says which caches this message only reads.
- **The variable never replaces one the sandbox set**: a cache whose variable the step already has (`HOME`, the egress
  proxy's, the helper's `SANDBOX_*`) is mounted without it, besides the names `parseBuildCache` refuses outright.
- **Windows:** a write grant for the session's container on the directory. This is a later phase; until then Windows
  hosts don't advertise `buildCaches`.
- **Sessions on the host** (unsandboxed, or a sandboxed host's sessions that run directly on it) get no build caches in
  this version, and an unsandboxed connector advertises none: a sandboxed writer could leave a symlink in a cache that
  a process outside any sandbox would follow to the host's own files. In a sandbox such a link resolves inside the
  sandbox's own view (bubblewrap) or is checked against the profile at its target (Seatbelt), so it reaches nothing
  more than the session could already. Giving host sessions their owner's own copy is left for later.

### Disk

A session's own files are bounded by its provisioned filesystem (`writableMaxBytes`, `writableMaxInodes` in
`--resources`), and a writable bind outside it would escape that bound. So on a connector started with `--resources`,
build caches need their own bounded filesystem: `--build-caches PATH`, a dedicated mount the operator provisions, checked
as session filesystems are (the resource supervisor's `probe-cache` mode: private and the connector user's, its own
mount of tmpfs, ext4, xfs or btrfs, `rw,nosuid,nodev`, no aliases or nested mounts, outside the resource controls).
Its size is the operator's choice and bounds the caches by itself. Without it such a connector keeps no build caches,
says why when it starts, and advertises none, so Pikibun shows that the host offers none. A connector without
`--resources` runs commands only for its owner and members they granted host commands, without disk limits anyway, and
keeps caches under its state directory.

Inside that bound, the host evicts: once a cache root passes 90% of its capacity (or, without `--build-caches`, a
host-wide **size limit** in the setting, 20 GiB by default), the connector deletes the least recently modified files
across the caches until it is under 80%, and removes empty directories. It checks every 10 minutes while the host's
setting isn't `off`. Tools that keep their own limit (ccache's `max_size`) do so too.

Sessions write these directories while the host walks and deletes in them, so a session could swap a directory for a
link to the host's own files between the host's listing and its deletion. Node has no `openat`, so listing, pruning
and eviction run in a short Python program (`BUILD_CACHE_JANITOR`) that opens every level with `O_NOFOLLOW` relative to
its parent's descriptor and unlinks relative to the directory's descriptor: a swapped level fails to open and is
skipped, and a link is only ever removed as a link.

## Housekeeping

- `pikibun cache list` adds a line per cache directory: its size, the workspace and name, and whether it is shared or
  whose.
- `pikibun cache prune --older-than DAYS` deletes cache directories whose newest entry is older than that. A directory's
  own time doesn't change when a file deeper down does, so prune looks past the walk's depth too (without recursion,
  within a bound), and keeps a cache it couldn't look through in full: one over a million entries, or deeper than that
  bound. It runs without the Pikibun server, so a cache a workspace deleted goes once nothing
  wrote to it for that long.
- Walks never follow links and stop at a depth of 64 and a million entries, reporting a walk cut short. What lies
  past that depth can't be sized, so eviction removes such directories whole, oldest first, before any file. Removal goes down and up a tree without recursion, holding at most
  128 levels' descriptors and opening the rest again from the top, so no depth stops it.
- Changing the host setting applies to sessions' next commands; a switch from `workspace` to `owner` leaves the shared
  copies on disk until prune collects them.

## What sessions are told

`identity`'s `commands` gains `buildCaches: [{ name, env, path, scope, access }]`, as the message's sender gets them,
and `buildCachesNote`, so the agent knows where a tool's cache goes, whether this message's commands write it, that a
shared one holds what code in other people's sessions wrote, and that what its own commands run writes it too
(`BUILD_CACHES_NOTE`). The workspace page shows, for each member, which copy their sessions get.

## Out of scope

- Sharing between hosts. Tools' own remote caches (sccache's, Bazel's, Gradle's) already do it.
- Checking entries, which no host can do for a cache named by its inputs.
- Caches for the file tools: only commands build.

## Phases

1. **Pikibun server and shared types.** `workspace_build_caches` and its API; `HostConfig.buildCaches` and its size
   limit; the trust rule in `packages/shared`, tested on every role and group combination; the connector endpoint;
   `buildCaches` in connector capabilities. Nothing reaches a session yet.
2. **Linux and macOS connectors.** Asking for and caching the answer, the directories, the mounts and variables,
   `--build-caches` and its checks, eviction, `pikibun cache list/prune`, `identity`.
3. **Client.** The workspace's **Build caches** section, the host's **Build caches** setting, and which copy each member
   gets.
4. **Later.** Windows; members reading the shared copy under their own (overlayfs, read-only secondary caches);
   attributing entries to the session that wrote them, so that a session building code from outside the workspace
   could be kept from the shared copy ("What writes a cache is code").

Each phase is its own pull request. Turning the setting on stays the host owner's decision: the default is `off`
everywhere.
