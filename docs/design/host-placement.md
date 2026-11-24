# Host hardware and placement of sub-task sessions

Two pieces that build on each other:

1. **Hardware reports.** Each connector tells the Pikibun server what machine it runs on: operating system, CPU,
   memory, disk and GPUs, and how busy the machine is. Host pages show it, and the server uses it for placement.
2. **Placement.** The `sessions` tool's `create` can let the server choose the host for a sub-task, from conditions
   the agent states (a GPU, enough memory or CPUs, a platform, which models) and from how loaded each candidate host
   is, rather than naming one model, and so one host, itself.

## Hardware reports

The connector reports `HostHardware` (`packages/shared/src/hardware.ts`) on its own callback,
`POST /api/connectors/self/hardware`, once it is connected (after its manifest) and again every five minutes:

| Field | Source |
|---|---|
| `platform`, `release`, `arch`, `wsl` | `process.platform`, `os.release()`, `process.arch`; WSL from `/proc/sys/kernel/osrelease` |
| `cpuModel`, `cpus` | `os.cpus()[0].model`, `os.availableParallelism()` |
| `memoryBytes`, `freeMemoryBytes` | `os.totalmem()`, `os.freemem()` |
| `diskBytes`, `freeDiskBytes` | `statfs` of the connector's data directory, where sessions live |
| `load` | `os.loadavg()`, left out on Windows, where it is always zero |
| `gpus` | Linux DRM devices in `/sys/class/drm` (vendor id, `mem_info_vram_total`), `nvidia-smi` for NVIDIA names and memory (also WSL's), `system_profiler` on macOS; each probe best-effort with a short timeout, the slow ones once per connector process |

It is its own callback, not part of the manifest, because the manifest route refuses fields it doesn't know: a new
connector reporting hardware to an older Pikibun server would otherwise fail to connect at all. A refused report
(an older server answers 404) stops reporting for that connection, and nothing else changes.

The server validates every field strictly (`parseHardware`: bounded strings without control characters, finite
non-negative numbers, at most 16 GPUs from a fixed vendor list) and keeps it in `connectors.hardware_json`, with the
time it arrived in `connectors.hardware_at`. Revoking or removing a host clears both. Nothing in it is a credential;
it is shown to everyone who can see the host (`ConnectorInfo.hardware`), as its platform already is. Its free memory
and load are only trusted for 15 minutes after a report (`hardwareFresh`), so a host that stopped reporting doesn't
look idle forever; the rest describes the machine and stays.

## Placement

`sessions` `list` now also returns `hosts`: each host that offers the actor a model in this workspace, with its
online state, whether the agent may start sessions there (`agentMayStart`, the same trust rule as before: the actor's
own hosts, and this session's host when the actor owns this session), sandbox, whether a sandboxed session there can
use a GPU, its hardware and its active sessions. Each model names its `host`. A host whose `sandbox` is `unsandboxed`
runs every session without one; a sandboxed session's agent reaches it only as
[Sandboxed work stays sandboxed](#sandboxed-work-stays-sandboxed) says, whatever `agentMayStart` is.

`create` takes `placement` (the tool's `placement` parameter):

| Condition | Meaning |
|---|---|
| `hosts` | Choose only among these host ids |
| `models` | Model patterns, any of which the model must match: a model id `list` returns, `provider/modelId`, or a glob over `provider/modelId` such as `anthropic/*`, as Pi's `enabledModels` take them. A filter, not a preference: every match qualifies and load decides among them; their order only breaks ties between equally loaded hosts. To insist on one model, name it alone |
| `gpu` | A GPU sandboxed sessions there can use: the host reports one and lends it to sandboxed commands (its GPU setting), or the host is unsandboxed |
| `gpu_vendor`, `gpu_memory_gb` | One of its GPUs is of that vendor, or has that much memory |
| `min_cpus`, `min_memory_gb`, `min_free_memory_gb`, `min_free_disk_gb` | At least that many CPUs, memory, free memory (from a fresh report), free disk |
| `platform`, `arch` | `linux`, `darwin`, `win32`; `x64`, `arm64` |

With `placement`, `model` narrows the choice to that model's provider and model id, on whichever host offers it, so
"the same model, wherever there is room" is `model` plus `placement: {}`. Without `model` or `placement.models`, the
candidates are hosts offering this session's current model. `thinking` keeps only hosts offering the model at that
level.

The server (`apps/server/src/placement.ts`) collects every (model, host) pair the actor may use, keeps those whose host
is online, which the agent may start sessions on, which has a sandbox when the calling session runs in one, and which
meet every condition, and picks the one with the lowest load score:

```
score = active sessions on the host (working or waiting, every workspace, and those started in the last
        two minutes that haven't reported yet, so sub-tasks started in a row spread out)
      + 1-minute load average / CPUs          (0.5 when unknown or stale)
      + used memory / total memory            (0.5 when unknown or stale)
```

Ties go to this session's own host, then to the earlier `models` pattern, then to the host's id, so the same state always gives the same answer. Load deciding before the patterns' order is deliberate: placement is load balancing among what qualifies, and an agent that prefers one model names that one (and relaxes to more if it is refused). An empty placement for a model with no host (test fixtures' workspace models) is ignored rather than refused, so `placement: {}` never turns a create that would work into one that fails. A host
with no hardware report can still be chosen when no hardware condition is set. When nothing qualifies, the call is
refused (`placement_unsatisfied`) with how many hosts each condition ruled out, so the agent can relax them or tell
the person. The result names the chosen host and why (`placement`: candidates, the chosen score, and the conditions).

The workspace's **Sub-task sessions** setting still applies: with `childModels` off, `placement.models` and `model`
are refused, and placement only moves the parent's current model between hosts.

### What placement doesn't change

- **Trust.** Placement never starts a session on a host the agent couldn't start one on by naming its model: another
  member's host still needs a person to start the session there. Such hosts show `agentMayStart: false` in `list`, and
  a refusal says when only they would qualify.
- **Sandboxing.** A session the agent starts runs in its host's sandbox, as before; `gpu` asks for a GPU that
  sandbox can reach. The one exception is `host_environment: true`, below. Where the host has no sandbox at all, the
  next section decides.
- **Limits.** The per-session children limit, fan-out, hops and audience checks apply as for any `create`.

### Sandboxed work stays sandboxed

A host can run every session without a sandbox (`--unsafe-no-sandbox`, capability `unsandboxed`). Placement used to
treat it like any other host the agent may start sessions on, and so did a `create` that names a model there: an agent
working in a sandbox, possibly steered by something hostile it read, could continue the work outside one, on the
actor's own machine, with nobody deciding that (finding 61 of #479). Load balancing made it likely rather than
contrived: an idle unsandboxed host scores lowest.

So where the calling session runs in a sandbox (`sessionSandboxed` in `placement.ts`: it wasn't started directly on
its host, and its host's connector doesn't run unsandboxed), the Pikibun server keeps what its agent starts in one:

- `placeChild` leaves unsandboxed hosts out (`sandboxedOnly`), and a `placement_unsatisfied` refusal counts them
  ("running sessions without a sandbox") and names the explicit path below;
- a `create` whose model, named or inherited, sits on an unsandboxed host is refused (`sandbox_required`) whether or
  not it has a `placement`, so the rule doesn't depend on which parameters the agent used;
- the `schedule` tool neither makes nor changes (but for pausing, and deleting) a schedule whose runs start on an
  unsandboxed host, whoever chose that host ([workspace schedules](workspace-schedules.md)).

The explicit path is the one a session directly on a host already has: `host_environment: true` with exactly one host
in `placement.hosts`, in a message a person sent. On an unsandboxed host there is no sandbox to leave, so the new
session is an ordinary one there (`createSession` gets no `hostEnvironment`, which it refuses for such a host), and the
`session.cross_session.created` audit records `unsandboxedHost` beside `hostEnvironment`.

There is no workspace setting that lifts the rule. A setting would be read by every message, including those from
other sessions and schedules, which is exactly where nobody is looking; the explicit path asks for the decision where
a person made a request. A session that already runs without a sandbox (directly on its host, or on an unsandboxed
host) is not restricted: its agent already has a machine, so the rule would protect nothing.

What this changes for existing workspaces: a sandboxed session's sub-agents no longer spread onto the sender's
unsandboxed hosts by load, and an agent that named a model there is refused with the path above. Workspaces whose
hosts are all unsandboxed, or all sandboxed, see no change.

Auto mode (`POST /api/workspaces/:id/auto-mode`) is not on this path: it answers a person's client, which then starts
the session or sends the message itself, and it already scores unsandboxed hosts down. A `send` to an existing session
that runs without a sandbox is not placement either and is unchanged.

### Sessions directly on a host

`create` with `host_environment: true` starts the session directly on its host, without the sandbox, as a person can
from the app. The server passes `hostEnvironment` to the same `createSession` a person's request reaches, so the same
checks apply: only the host's owner, or a member they granted sessions on it, the host accepting such sessions
(`host_sessions_off`), and a connector that supports them (`connector_update_required`, `host_unsandboxed`). On top of
those, the agent's call:

- needs a message a person sent: a run admitted for a cross-session message (`xs:`) or a schedule (`schedule:`) is
  refused (`host_session_person_required`), so no chain of agents or unattended run leaves the sandbox on its own;
- names exactly one host in `placement.hosts`, so the session never lands on a machine nobody chose (`invalid_input`);
- shows "directly on the host, without the sandbox" in its approval target, and is audited with `hostEnvironment`.

`piki:sub-agents` adds no workspace conditions or balancing to such a call.

Whether a person sent the message is read from the run admission's `request_id`: the server's own submissions name
their source in it, `xs:<message>` for a cross-session message or notification (`cross-session.ts`) and
`schedule:<id>:<at>` for a scheduled run (`scheduled-prompts.ts`); every other admission comes from a person's request
to the sessions API. A new path that submits messages on its own must name itself with such a prefix and add it to
`personSent` in `cross-session.ts`. A person choosing a `requestId` with one of these prefixes only refuses themselves.

## The sub-agents extension: piki:sub-agents

Placement is a parameter the agent may or may not use. `piki:sub-agents` (`extensions/sub-agents/`, a hook package like
`piki:pr-flow`, workflow, built into the connector and published as `@pikibun/pi-sub-agents`) makes it the workspace's
policy, without a tool of its own:

- `before_agent_start` adds when to delegate (`delegate`), how to state conditions per task, the workspace's defaults,
  the per-message limit and how to collect results.
- `tool_call` on `sessions` `create` fills the workspace's `placement` conditions in where the call leaves them out
  (the agent's own win), adds its `models` patterns where the call names no model, adds an empty placement with
  `balance` on so even an unconditioned sub-agent goes to the least loaded host offering its model, sets `notify` for a
  call with a message, and blocks a create past `max-sub-agents` for the message (counting successful creates and
  those still under way, so creates the runtime started together can't pass it; reset by each message's
  `before_agent_start`). A refusal that no host offers the model, of a placement only the extension added, stops it
  adding one for the session. Pikibun's adapter applies changes to `event.input`
  ([host extensions](host-extensions.md)), and the tool's own checks run on the changed call.
- `tool_result` notes where the sub-agent runs and how to collect it, or why no host qualified; where hosts were left
  out for running without a sandbox, it says that this is Pikibun's rule and not a condition to relax.

It needs `piki:sessions`, a session-tool switch, rather than being merged into it: merging would give that switch
hooks and settings, which session-tool extensions don't have, change every workspace that already uses the tool
(delegation guidance and caps on every message), and lose the managed npm updates session-tool extensions can't take.
The catalogue says so instead (`needs: ["piki:sessions"]`): a workspace's first add of Sub-agents, turned on, adds
Other sessions where it has no entry (`addNeededExtensions`, audited as `workspace.extension.updated` with `reason:
needed` and `by`), an entry turned off stays off, and the extensions page shows a warning with an **Add** button while
a needed extension is off (`missingNeeds`).

It only shapes calls the agent makes with the sender's own `sessions` tool, so it adds no authority: trust, sandboxing
and the tool's limits apply as above. It degrades with what it talks to: a refusal that names `placement` (a server
from before it) stops it adding placement for the session, and a `child_models_disabled` refusal stops it adding
models; each says so in its note, and the agent calls again. Its state is in memory per session, as `pr-flow`'s.

## Compatibility

- The `placement` parameter is the connector's: hosts need a connector from this release for their agents to pass it.
  An older connector's agent keeps naming models.
- A Pikibun server from before this release refuses the `placement` field (`invalid_input`), and answers the hardware
  callback with 404, which the connector takes as "not reported".
- Hosts whose connector reports no hardware show none, and can only be placed on when no hardware condition is set.
