# A session on the host: RunnerSession and its parts

`apps/runner/src/session.ts` holds `RunnerSession`, one per session a host runs. It coordinates: it builds and wires its
parts, opens and closes the session, holds the `exclusive` lock, reads and changes the session's metadata (`metadata`,
`mutate`), authorizes, and answers what `server.ts` asks. What the session does is in its parts, under
`apps/runner/src/session/`; `apps/runner/src/connector.ts` is split the same way under `apps/runner/src/connector/`.

## The rules the parts follow

- **A part never sees the session.** It is constructed with an options object: the data it needs and callbacks into the
  session (`authorize`, `metadata`, `mutate`, `exclusive`, `closing`, …). A part that could only work by being handed the
  session would be the session again under another name.
- **The session decides when, the part decides how.** The session calls a part at the moments it did the work itself:
  checks run at the same points and in the same order (`authorize`, the host-command policy, `requireUnfrozen`, the tool
  call's actor and checks, `requireSessionTool`, `requireSenderTool`).
- **State the session's races depend on stays readable at the moment it was read.** `generation`, `closing`, the
  repositories' epoch and the connector's `restarting` are passed as functions, not values, so a part reads them exactly
  where the code read the field.
- **Logic with no state is functions** (`entries.ts`, `instructions.ts`, `view.ts`).
- **Each part has tests of its own**, in `tests/runner-session-parts.test.ts` and `tests/connector-parts.test.ts`, which
  need no whole session, socket or sandbox.

## Where things are

| Part | Takes care of |
|---|---|
| `session/state.ts` | The metadata the session keeps in its durable store: runs, branches, operation records, tool actors |
| `session/instructions.ts` | The agent's instructions for a message (a pure function of the session's state) |
| `session/repositories.ts` | Preparing a restored or moved session's clones again, and resuming its work once they are ready |
| `session/operations.ts` | Running an operation a tool call asks for: commands, GitHub effects, pushes; aborting pushes on close |
| `session/tools/` | The session's tools, by family, over one `ToolContext`; `calls.ts` is who a call acts for and its checks |
| `session/definitions.ts` | The tools Pikibun defines as data, and the ones a refresh adds while the session runs |
| `session/availability.ts` | Which tools a session offers and refuses: the workspace's switches, tool groups, the host's programs |
| `session/piki.ts` | The host extensions' view of the session, their tool calls, and the CLIs they run in the sandbox |
| `session/view.ts` | What a session's view shows (functions over the state the session gives them) |
| `session/run-queue.ts` | Running queued shared messages one at a time (a sender's next shared message, with the same options, steers their run at work instead) and side asks beside them, screening them with extensions, and settling their runs |
| `session/uploads.ts`, `inputs.ts`, `mirrors.ts`, `approval-waits.ts`, `branch-reports.ts`, `host-commands.ts`, `tunnel.ts`, `entries.ts` | As before: uploads, queued images, cache mirrors, whole results, branch reports, the host-command policy, tunnels, transcript entries |
| `connector/control-plane.ts` | The connector's calls to the control plane, each tied to the connection it was made on |
| `connector/runner-config.ts` | The callbacks the connector gives the runner (`RunnerConfig`) |
| `connector/frames.ts` | Relay requests and their replies, the replay guard, and uploads sent straight to the host |
| `connector/relay-request.ts`, `wire.ts`, `generation.ts` | The relay request's checks, shared limits and body reading, a connection's state |

## Why some seams are where they are

- **The queue drains through the session.** `RunQueue` starts every drain it causes (a settled run, a screened message, a
  drain asked for while one ran) through `RunnerSession.drainQueue()`, which delegates back to it. That keeps the one
  entry point the session always had, so anything that replaces it, as tests do to pause the queue, still holds.
- **Side asks don't wait for the shared work.** A side ask works in a conversation of its own, forked from the shared
  one when it was sent, with only the read-only tools, and a tool call acts for the run of the conversation it was made
  in. So the drain starts one at once, beside a running shared message, an executing operation (only shared messages
  make those) or a waiting shared message, and a running side ask holds up neither. Shared messages keep to one at a
  time, in order. Up to `MAX_RUNNING_ASKS` (4) side asks run at once, so a burst of them doesn't stack up model
  requests on the owner's account; nothing starts while a stop is under way. Host extensions' `agent_end` and
  `agent_settled` follow shared messages only, as `agent_start` and `before_agent_start` do, so a side ask that ends
  mid-task doesn't tell them the agent's work ended.
- **The session keeps thin members tests reach by name.** `metadata()`, `tools`, `buildTools()`, `drainQueue()`,
  `agentInstructions(mode)`, `activity()`, `harness` and `hostCommands` stay on `RunnerSession`, delegating where the work
  moved, so the whole-session tests read the same members they always did.
- **Tool calls have one helper.** `ToolCalls` (`session/tools/calls.ts`) is used by the tools, by `SessionPiki` for
  extension tools, by the built-in extensions for their output files and by `SessionOperations` for commands' limits,
  so who a call acts for, how its output is saved and the limits it runs with stay in one place.
- **The connector keeps its lifecycle.** Connecting, the connection's generation, restarting and the runtime stay in
  `LocalConnector`; `ControlPlaneCalls` and `RelayFrames` read them through callbacks and check the generation where the
  connector did.
- **The replay guard counts relay requests and direct uploads apart.** A request or ticket seen on either path is
  refused on both, but each path remembers its own, up to 8,192 keys. A relay request over that limit ends the
  connection, as before; an upload over it is answered 503 and can be sent again. Were they counted together, a fast
  upload from the desktop app to its own host could fill the guard and end the connection for every session on it.
- **Every call to the control plane is posted one way.** `ControlPlaneCalls` builds the request in one place, so each
  call carries the connector's version, and the activity, tunnel and branch reports share one body that checks the
  connection's generation before and after.
