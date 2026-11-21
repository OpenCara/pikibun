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
| `session/titles.ts` | The `title` action: one completion with the session's model that names the session, its usage added to the shared conversation's |
| `session/cache-warming.ts` | Refreshing the prompt cache of a conversation shortly before it expires ([Prompt cache warming](cache-warming.md)) |
| `session/run-queue.ts` | Running queued shared messages one at a time (a sender's next shared message, with the same options, steers their run at work instead) and side asks beside them, screening them with extensions, and settling their runs |
| `session/uploads.ts`, `inputs.ts`, `mirrors.ts`, `whole-results.ts`, `branch-reports.ts`, `host-commands.ts`, `tunnel.ts`, `entries.ts` | As before: uploads, queued images, cache mirrors, whole results, branch reports, the host-command policy, tunnels, transcript entries |
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
- **A side ask's thread forks like the shared conversation.** `forkEntries` takes a message of a side ask as well as
  one of the shared conversation: the side ask's conversation holds the shared one as it was when the side ask was sent,
  then the side ask, so the new session goes on from what was asked on the side, with the tools a shared message has.
  Forking from a side ask's latest reply waits only for that side ask's own run, not for the shared work, as the side ask
  didn't, and its runs are all it checks: a side ask makes no operations. Only whoever sent the side ask forks from it, as
  the app offers it only on one's own side asks. The server tells a side ask's message by its conversation's number, as
  the runner does, and starts such a fork as a child of the session (`parentSessionId`), titled `Side ask: …`, and only
  where the view says `askForks`, so a host whose connector predates it refuses nothing it never offered.
- **The server names a session; the host only answers.** Which sessions are named, the prompt, cleaning the reply and
  the fallback title are the Pikibun server's (`apps/server/src/session-titles.ts`, `packages/shared/src/session-titles.ts`),
  as they may change and hosts update slowly. The server claims the naming once, with the person's first message
  (`sessions.title_fallback`, set only for a session the app started with a title it made, and cleared by a rename),
  skipping messages without words and slash commands (`namesSession`) so they don't use up its one chance,
  sets the fallback, asks the host's `title` action, which only runs the completion the server describes, and writes
  the model's title only while the session's title is still the fallback, so a rename meanwhile wins. Hosts without
  `sessionTitles` are never asked. The host adds the answer's usage to the shared conversation's `pi.usage`, so the
  session's usage counts it, and aborts a completion still running when the session closes. Its 20 s limit sits well
  inside the relay's 30 s, so the host's own limit is the one that ends a slow answer. Its usage adds no entry, so the
  view's usage shows it at its next 10-second read (below).
- **The view reads the session's usage once per commit.** A client following a session reads its view four times a
  second, and pi-durable's `Harness.usage()` reads every conversation's `pi.usage` document to sum them. `SessionUsage`
  keeps the last sum while no branch has a new entry, and reads it again after 10 seconds anyway, for spend a later
  feature may record without an entry of the branches the view reads. The view sends the raw counts (each model's and
  the tools' tokens and cost, and the last answered request's prompt tokens); hit rates and their wording are worked out
  in the client (`packages/shared/src/usage.ts`), so changing how they read needs no connector release.
- **The session keeps thin members tests reach by name.** `metadata()`, `tools`, `buildTools()`, `drainQueue()`,
  `agentInstructions(mode)`, `activity()`, `harness` and `hostCommands` stay on `RunnerSession`, delegating where the work
  moved, so the whole-session tests read the same members they always did.
- **Tool calls have one helper.** `ToolCalls` (`session/tools/calls.ts`) is used by the tools, by `SessionPiki` for
  extension tools, by the built-in extensions for their output files and by `SessionOperations` for commands' limits,
  so who a call acts for, how its output is saved and the limits it runs with stay in one place.
- **The connector keeps its lifecycle.** Connecting, the connection's generation, restarting and the runtime stay in
  `LocalConnector`; `ControlPlaneCalls` and `RelayFrames` read them through callbacks and check the generation where the
  connector did.
- **The replay guard remembers relay requests only.** A request or ticket seen once is refused again, and the guard
  remembers up to 8,192 keys; a relay request over that limit ends the connection. It used to count uploads the
  Electron app handed straight to its own host as well, apart from relay requests. That path is gone (#230): every
  client uploads through the server, as an ordinary relay request.
- **Operation records keep their stored names.** A session's metadata keeps its operation records under `approvals`,
  and an `OperationRecord` still has the statuses `pending`, `approved` and `denied`, from before approvals were
  removed (#35). The code calls them operations (`OperationRecord`, `StoredOperation`, `WholeResults`), but the stored
  names stay: sessions made back then still hold records with those names and statuses, their views show them, their
  backups restore them, and their hosts compare a session's stored state as it is. New records are only ever
  `executing`, then `executed`, `failed` or `interrupted`.
- **Images are fitted once, by whoever makes them, and the hook comes last.** `apps/runner/src/images.ts` holds the one
  Photon processor, its host-wide line (`inTurn`, one image at a time, 8 waiting), its decode caps and timeout, and
  the limits: the conversation model's `imageLimits`, each bounded by Pi's defaults (2000×2000, 4.5 MiB), as a model's
  declared limits may be missing or huge. `read`, browser screenshots and pasted images prepare their own, to the
  model they go to, and so keep their own refusals (`read` answers that it's busy; a message is refused with 422). Every
  other tool's images, code mode's `image()` and extension and MCP tools' among them, go through pi-durable's
  `fit-images` `afterTool` hook (`fitImagesExtension`), with the same processor wrapped (`modelImages`): it is the last
  of each conversation's extensions, so it fits what the other extensions' hooks leave. The hook decodes every image
  it sees; an image the line itself prepared (its digest kept, 256 at most) that still fits is handed back as it is,
  without a turn, so `read`'s result is never fitted twice nor left out because the line is full meanwhile. A busy line
  leaves a hook's image out with a note, as Pi does for any image it can't prepare. A queued message's images were
  fitted to the model it named, or the conversation's, when sent; when it runs, those its model takes smaller are fitted
  again (`fitInputImages`), by their headers alone otherwise.
- **Every call to the control plane is posted one way.** `ControlPlaneCalls` builds the request in one place, so each
  call carries the connector's version, and the activity, tunnel and branch reports share one body that checks the
  connection's generation before and after.
