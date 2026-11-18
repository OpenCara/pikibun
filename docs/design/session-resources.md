# Session resources

Each session's **Details** tab shows what the session uses of its host's hardware: CPU, memory, processes, GPU memory
and disk. The host measures it, since nothing else can, and sends it with the session's view (`SessionView.resources`,
`SessionResourcesView` in `packages/shared/src/session-resources.ts`); the client words it (`resourceLines`). The
Pikibun server passes it through as it passes the rest of the view, so this needs no schema change, no callback and no
new server: a session on an older connector simply has no `resources`, and the section isn't shown.

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

macOS's `ps` has no children time, so there a short-lived process counts only for the samples that saw it.

## When it samples

Sampling costs a read of every process's `stat` file, so it runs only while the session has processes: every 2 seconds
from the first root on, while any is left (`ProcessRoots.onChange`), on an unreferenced timer. A view asked for more
than 2 seconds after the last sample, or after a process started or ended, samples again first; otherwise it gets the
last sample, so frequent view polls see a stable value and send no patch for it. The CPU rate is taken over at least a
second. What a root process used after its last sample is the part that can be lost, so the interval bounds it. Disk is walked at most every 5 minutes, in the background, and
only once someone looks at the session: one directory handle at a time, `lstat` without following links, stopping at
200,000 entries or 10 seconds and saying so (`diskPartial`). GPU memory reads `nvidia-smi` at most every 10 seconds,
only while the session has processes, and never again on a host where it failed.

## Who sees it

Everyone who can read the session's view, as for its token usage and context: the workspace's members and the session's
grantees. A share link's view (`sharedView`) keeps entries only, so link readers don't see it, as they don't see the
host. It says nothing of other sessions on the host.

## Not done

- A host-wide list of every session's use on the host's page. It needs the connector to report all its sessions
  together on a callback of its own, and the Pikibun server to show each viewer only the sessions they may read.
- Windows: job objects (see [Windows sandbox](windows-sandbox.md)) would give exact CPU and memory once the runner
  holds a job per step.
- Placement: it still scores hosts by active sessions and the host's load average, not by what sessions use.
