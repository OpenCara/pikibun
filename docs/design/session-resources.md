# Session resources

Each session's **Details** tab shows what the session uses of its host's hardware: CPU, memory, processes, GPU memory
and disk. The host measures it, since nothing else can (`SessionResourcesView` in
`packages/shared/src/session-resources.ts`), and the client words it (`resourceLines`).

## Transport

The client asks `GET /api/sessions/:id/resources` every 5 seconds while the tab is open. The Pikibun server checks that
the asker may read the session and passes the request to its host as the runner action `resources` (permission
`read`, like `artifacts`: allowed on a frozen session, during a move, and in a packed one), and checks the answer's
shape strictly (`parseSessionResources`) before returning it. It answers `{ resources: null }` without asking the host
for an archived or packed session, which runs nothing, and for a host whose connector doesn't advertise
`sessionResources`, so an older connector is never sent an action it would refuse; the client then shows no section.

It is not part of the session's view. The view is compared between polls and sent as patches: a value that changes
every few seconds while commands run would make a new revision each time, and an idle session's view must stay the
same from one read to the next (several runner tests rely on that). Asked on its own, it costs nothing unless someone
has the tab open. It needs no schema change: nothing is stored.

## What is measured

`apps/runner/src/session-resources.ts`, one `SessionResources` per open `RunnerSession`:

| Field | Linux with resource limits (`--resources`) | Linux without them, macOS | Windows |
|---|---|---|---|
| `processes` | `pids.current` of the session's cgroups | processes below the ones the session started | the ones it started |
| `cpuSeconds`, `cpuCores` | `cpu.stat` `usage_usec`, from the session's open; cores between two samples | per-process CPU time (below) | not measured |
| `memoryBytes`, `peakMemoryBytes` | `memory.current`; the highest sample since the open | the processes' resident memory, summed | not measured |
| `limits` | the host's CPU quota and `memory.max` for each of the session's cgroups | none | none |
| `gpuMemoryBytes` | `nvidia-smi --query-compute-apps=pid,used_memory` (WSL's too), for the session's processes | same on Linux; not on macOS | not measured |
| `diskBytes`, `diskPartial` | the session's folder (`<data>/sessions/<id>`), allocated blocks | same | same |

The session's cgroups are the two domains the resource supervisor already makes (`resources.ts`): `session-<key>` for
its commands and `session-<sha256(key + "\0service")>` for its servers. Nothing new is created or written; the
connector only reads files in the directory it was delegated.

### Which processes are a session's

Every workspace (`Sandbox`, `HelperWorkspace`, `HostWorkspace`) keeps the process ids it started and hasn't seen end
(`ProcessRoots`), as each `spawn` returns and each `close` ends: sandboxed commands and file steps, servers, extension
processes in the Linux sandbox, and host commands (`runHostShell`). A session's processes are those roots and every
process below them, from one table of the host's processes (`/proc/<pid>/stat` on Linux, `ps -A` on macOS) that all
sessions share for a second. Inside bubblewrap's PID namespace the processes still have host PIDs and parents, and orphans
go to bubblewrap's own init, which is one of them.

Extension processes on an unsandboxed host, and the agent's own work in the connector's process, aren't a session's
processes: the connector serves every session in one process, and the model runs at its provider.

### CPU time without double counting

A process's CPU time is its own (`utime + stime`) plus that of the children it reaped (`cutime + cstime`), so a
compiler that started and ended between two samples still counts, through the `make` that waited for it. A child seen
alive at the last sample and reaped since would count twice: once while it ran, once in its parent's children time.
So `cpuCredit` adds each live process's increase since the last sample (all of it for a new one), and takes off the
last-seen total of each process that has gone, where a process of the session above it is still alive to have reaped
it. What a process used between its last sample and its end is lost only when nothing of the session reaped it (the
root process itself, reaped by the connector): at most one interval of that process. With cgroups, CPU time is exact.

macOS's `ps` has no children time, so there a short-lived process counts only for the samples that saw it, and nothing
is taken off when one goes (each sample's entry says whether its table had children time). A process is known by its
PID and start time (`/proc` start ticks, `ps`'s `lstart`), so a reused PID is a new process.

## When it samples

Sampling costs a read of every process's `stat` file, so it runs only while the session has processes: every 2 seconds
from the first root on, while any is left (`ProcessRoots.onChange`), on an unreferenced timer. A request more than 2
seconds after the last sample, or after a process started or ended, samples again first; otherwise it gets the last
sample. The CPU rate is taken over at least a second. What a root process used after its last sample is the part that
can be lost, so the interval bounds it.

Disk is walked at most every 5 minutes, in the background, and only once someone asks: one directory handle at a time, `lstat` without following links, stopping at
200,000 entries or 10 seconds and saying so (`diskPartial`). GPU memory reads `nvidia-smi` at most every 10 seconds,
only while the session has processes, and never again on a host that has no `nvidia-smi` (`ENOENT`); any other
failure is tried again in the next window.

## Who sees it

Everyone who may read the session, as for its token usage and context: the workspace's members and the session's
grantees, each asking as themselves. There is no share-link route, so link readers don't see it, as they don't see the
host. It says nothing of other sessions on the host.

## Not done

- A host-wide list of every session's use on the host's page. It needs the connector to report all its sessions
  together on a callback of its own, and the Pikibun server to show each viewer only the sessions they may read.
- Windows: job objects (see [Windows sandbox](windows-sandbox.md)) would give exact CPU and memory once the runner
  holds a job per step.
- Placement: it still scores hosts by active sessions and the host's load average, not by what sessions use.
