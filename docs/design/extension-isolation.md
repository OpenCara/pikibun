# Running extensions out of the connector's process

Review 268, finding 14 (High): installed extensions run in the connector's own Node.js process, as the host owner's OS
user, with the owner's files, credentials and network. The workspace's network policy doesn't confine them. This
document says what is contained today, what isn't, and how extensions move into a per-session child process with the
session's sandbox and egress proxy. It is the plan; the code hasn't changed yet.

## What is contained today

- **Their tools are host commands.** A call to an extension's tool is an `extension.tool` operation, and `runsOnHost`
  counts every one of them as running on the host. So it runs only in sessions of the host's owner and of members they
  granted host commands, for messages of theirs (`session/host-commands.ts`, `HOST_COMMANDS_RULE`), and the
  connector asks the server again before each call. `docs/extensions.md` says this to users ("Outside the sandbox").
- **The host's owner installs them.** A workspace chooses among what a host has installed; it can't install code on a
  host whose connector runs with `--no-remote-installs`, and remote installs are audited.
- **They are bounded in time.** Every hook runs under `hookTimeoutMs` (30 seconds), input handlers under
  `inputTimeoutMs` (60 seconds).

## What isn't

- **Hooks run for everyone's messages.** `input`, `before_agent_start`, `context`, `tool_call`, `tool_result`,
  `turn_*`, `message_end`, `agent_*` and `session_before_compact` handlers run for any member's message in a session
  that selected the extension. A member without host commands can't call an extension's tool, but their message makes
  the extension's code run, and it sees their text, the model's context and every tool call's arguments and results.
  Text the agent reads (a repository's files, a web page) reaches those handlers too.
- **Nothing confines the code itself.** A handler can read `~/.ssh`, the connector's own credentials and its model
  keys, open any socket, and change the connector's memory, including other sessions' state and the code that enforces
  the rules above. A timeout stops waiting for a handler; it doesn't stop the handler.
- **One extension's crash or leak is the connector's.** A handler that blocks the event loop stalls every session on
  the host.

## Target

Each session that selects at least one installed extension gets one **extension process**: a Node.js child of the
connector that loads that session's extensions and nothing else. The connector keeps everything that decides: the
durable harness, approvals, host-command checks, the egress proxy and the session's files.

- **Same sandbox as the session's commands.** In a sandboxed session the process runs in the session's sandbox, with
  the session's worktree as its working directory, the extension store read-only, and no other path of the host. It
  reaches the network only through the session's egress proxy (`HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1`, as
  `egress.ts` sets for commands), so the workspace's network access applies to extensions like everything else.
- **Per platform, the backends that exist.** On macOS and Windows, `HelperWorkspace` already runs a long-lived Node.js
  helper inside Seatbelt or the Windows sandbox and passes it the proxy (`node-helper.ts`). The extension process is a
  second helper of the same kind, with its own entry point. On Linux it runs under `bwrap` with the mounts `sandbox.ts`
  gives commands, plus the store read-only.
- **Sessions on the host.** Where the session itself runs on the host (unsandboxed hosts, sessions on the host's
  environment), its commands already run as the owner's user, so the extension process runs unsandboxed too. It is
  still a separate process, so a crash or a blocked event loop costs that session only.
- **Pikibun's own extensions stay in the connector.** `piki:` extensions (`gh`, `glab`, `azure-cli`) and Pi's
  built-ins (`pi:codemode`) are part of the connector, reviewed with it, and need the host's sign-in or its sandbox
  backends. Only extensions from the store move.
- **Killed, not abandoned.** A hook that outlives its timeout ends the process. The session warns, marks the session's
  extensions broken until the next message, and starts a fresh process then.

## Where the boundary cuts

`session.ts` uses extensions only through `SessionExtensions` (`ensure`, `select`, `input`, `sessionStart`,
`beforeAgentStart`, `agentEnd`, `shutdown`, `isOpen`, `get`) and through the durable `Extension` objects `build()` makes
from each `ExtensionRunner`: tool registrations, `ToolTask`, `GenerationTask` and `CompactionTask` hooks, and a prompt
section. Neither side needs Pi's `ExtensionRunner` itself. So the split is:

- **In the connector:** a `SessionExtensions` with the same methods, whose `build()` makes the same tools, hooks and
  section from a description the child sends after loading: each tool's name, description, JSON-schema parameters and
  execution mode, and which events have handlers. Each callback sends one request to the child and awaits its answer.
- **In the child:** `loadSource`, Pi's `ExtensionRunner`, `noActions` and `contextActions`, answering requests:
  `emit`, `emitInput`, `emitBeforeAgentStart`, `emitToolCall`, `emitToolResult`, `emitContext`, `emitBoundary`,
  `execute` for a tool, and `flags` to apply a source's settings. The connector still decides `applyState` (whether a
  source applies, and its settings) before each request, as now.
- **The protocol** is length-prefixed JSON over the child's stdio, like the helpers'. Every value already crosses as JSON
  (`isJsonValue`, `structuredClone` of arguments); images cross as base64, as tool results do now. Requests carry an id
  and an abort, so a tool's `AbortSignal` reaches the child.

## What changes for extensions

- **`ctx.modelRegistry` has no credentials.** The child gets the session's model as a description (provider, id,
  context window) and `getModel()` returns that. An extension that called a model with the connector's keys stops
  working; a later grant could proxy model calls through the connector, under the session's own model access.
- **`prepareArguments` runs in the child.** It is a function, so the connector sends the arguments and awaits the
  prepared ones, under the hook timeout.
- **`ctx.ui`** keeps its present behaviour: `notify` becomes a notice, the rest does nothing, as `noActions` does now.
- **Host paths.** An extension that reads host files (`@pikibun/pi-context-files`' `host:` files) gets them only from
  directories the host's owner lists in the extension's settings, mounted read-only.
- **State in memory** lasts as long as the child: across messages, but not across a connector restart, as now.

## Steps

1. **The protocol in-process.** Split `adapter.ts` into the connector half and the child half, joined by an in-memory
   transport. Behaviour is unchanged, and `tests/extensions.test.ts`, `host-extensions.test.ts` and
   `context-files.test.ts` hold it.
2. **The child, unsandboxed.** Run the child half in a child process for every session. This already takes crashes,
   blocked event loops and leaks out of the connector, and makes timeouts kill.
3. **The sandbox and the proxy.** Start the child in the session's sandbox per platform, with the mounts and egress
   above; tests in `tests/sandbox-conformance.test.ts` check that an extension can't read a host path or reach a host
   the policy refuses.
4. **The docs.** `docs/extensions.md` loses "Outside the sandbox" for sandboxed sessions; `host-extensions.md` moves
   isolation from Later to Done.

Until step 3 ships, the rule in `docs/extensions.md` stands: the host's owner installs only extensions they trust with
their own account, as they would a program.
