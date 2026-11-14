# Running extensions out of the connector's process

Review 268, finding 14 (High): installed extensions run in the connector's own Node.js process, as the host owner's OS
user, with the owner's files, credentials and network. The workspace's network policy doesn't confine them. This
document says what is contained today, what isn't, and how extensions move into a per-session child process with the
session's sandbox and egress proxy. Steps 1 and 2 are built, and step 3 on Linux (see each "as built" section); step 3 on macOS
and Windows is the plan.

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
durable harness, host-command checks, the egress proxy and the session's files.

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
  context window) and `getModel()` returns that. Built in step 1: see below. An extension that called a model with the connector's keys stops
  working; a later grant could proxy model calls through the connector, under the session's own model access.
- **`prepareArguments` runs in the child, before `execute`.** pi-durable calls a tool's `prepareArguments`
  synchronously, before it validates the arguments, so the connector can't wait for the child there. The connector's
  tool has none; the child runs the extension's on the validated arguments just before `execute`. Arguments that only
  the repair would have made valid are refused, as any other invalid ones.
- **`ctx.ui`** keeps its present behaviour: `notify` becomes a notice, the rest does nothing, as `noActions` does now.
- **Host paths.** An extension that reads host files (`@pikibun/pi-context-files`' `host:` files) gets them only from
  directories the host's owner lists in the extension's settings, mounted read-only.
- **State in memory** lasts as long as the child: across messages, but not across a connector restart, as now.

## Steps

1. **The protocol in-process** (done). Split `adapter.ts` into the connector half and the child half, joined by an
   in-memory transport. Behaviour is unchanged but for the model registry, and `tests/extensions.test.ts`,
   `host-extensions.test.ts` and `context-files.test.ts` hold it.
2. **The child, unsandboxed** (done). Run the child half in a child process for every session. This already takes crashes,
   blocked event loops and leaks out of the connector, and makes timeouts kill.
3. **The sandbox and the proxy** (done on Linux). Start the child in the session's sandbox per platform, with the mounts and egress
   above; tests in `tests/sandbox-conformance.test.ts` check that an extension can't read a host path or reach a host
   the policy refuses.
4. **The docs.** `docs/extensions.md` loses "Outside the sandbox" for sandboxed sessions; `host-extensions.md` moves
   isolation from Later to Done.

## Step 1 as built

- **Three files.** `extensions/protocol.ts` is the protocol: one request per thing the connector asks of an
  extension (`open`, `emit`, `input`, `beforeAgentStart`, `toolCall`, `toolResult`, `context`, `messageEnd`,
  `turnEnd`, `beforeSettle`, `compact`, `execute`, `shutdown`), each with JSON parameters and a JSON answer.
  `extensions/worker.ts` is the child half: `ExtensionWorker` holds Pi's `ExtensionRunner` for each source and answers
  the requests. `extensions/adapter.ts` is the connector half: `SessionExtensions` and the durable tools, hooks and
  sections, unchanged for `session.ts`, which ask a channel instead of a runner.
- **Two channels per session.** Sources with factories (the `piki:` extensions built into the connector, and Pi's) go
  through a direct channel to a worker that has the host's model registry and the session's `PikiSession`: they stay
  in the connector, as above. Every other source (the store's, and managed packages) goes through a JSON channel, which
  copies each request and answer through `JSON.stringify`, so nothing that wouldn't cross a process boundary does.
  Step 2 replaces that channel with the child process; nothing else needs to change.
- **What each request carries.** Each request for a source carries its settings, which the connector reads (with
  whether the source applies) before asking, as it did before every call; the worker sets the source's flags from them.
  Each also carries the session's current model, as a description, and reasoning level. Each answer carries the
  events the source handles at that moment, so a handler an extension adds once it runs (in `session_start`, say) is
  seen, as `hasHandlers` saw it before.
- **The model registry, from step 1.** Sources behind the JSON channel get a registry over descriptions of the host's
  models: `find`, `getAll` and `getAvailable` work, with the models' `headers` left out (custom headers in
  `models.json` can hold keys); every other method (`streamSimple`, `getApiKeyForProvider`, …) throws
  `MODEL_CALLS_REFUSED`. This is the one change people see before the child runs anywhere else: an installed extension
  that called a model with the host's keys stops working with the next connector. It is in step 1 rather than 2 so that
  the boundary is the one the child will have, and tested as such.
- **Timeouts are the connector's.** It still stops waiting after `hookTimeoutMs` and `inputTimeoutMs`; a call it
  stopped waiting for still runs in the worker until step 2 can end the child.
- **Errors cross as their message.** A request that fails in the worker fails in the connector with the same message,
  as a tool's error or a hook's warning did before.

## Step 2 as built

- **One process per session, started when first needed.** `extensions/process.ts` (`ProcessChannel`) replaces step
  1's JSON channel: the first request for an installed source starts `extensions/child.ts`, which answers with an
  `ExtensionWorker`. A session whose extensions are all built in starts none.
- **Node's IPC channel carries the protocol.** It frames JSON itself, and it leaves the process's stdout and stderr
  free: an extension that prints doesn't break the protocol, and what it prints goes to the connector's log, a line at
  a time. Requests carry an id; an abort sends `cancel` with it, and the child aborts that request's signal.
- **Where the entry is.** The release build makes `dist/extension-worker.js` a second entry point of the CLI's
  bundle (`packages/cli/scripts/build.mjs`), sharing its chunks and `node_modules`. From source (`pnpm connect`, the
  tests), the connector starts `child.ts` with `--import tsx`. `workerEntry` finds whichever is there.
- **A timeout ends the process.** A hook or input handler that outlives its timeout makes the connector kill the
  process (`restart`), so a blocked event loop costs the session that much time and no more; the connector's own loop
  never waited. Starting a process and opening its sources again doesn't count against a handler's time: its timer
  starts once the process is ready, and starting has a minute of its own (`START_TIMEOUT_MS`), so a slow start isn't
  killed over and over. A crash (an `exit`, an uncaught exception) ends it the same way. An abort settles its request at once;
  if the process hasn't ended the request within `CANCEL_GRACE_MS` (5 seconds), its loop is taken to be stuck and it is
  ended too. Ending the process fails every request it had, for every source of the session. Requests waiting on it fail with the
  reason, and each open source gets a warning.
- **The next request starts a new one.** It opens every source again and emits `session_start` again to those that had
  it (with the settings it was first sent), before anything else, so the session goes on with what its extensions rebuild from that; what they kept in memory
  is gone, as across a connector restart. A source that fails to open again is tried again at its own next request.
- **Handles hold the connector only while it waits.** The process, its IPC channel and its pipes are unref'd while no
  request is pending, so a connector (or a test) that is done isn't kept alive by a session that wasn't shut down.
  A pipe or socket that has closed is skipped (`holdHandles`, `hold.ts`): it holds nothing open, and Node's
  `net.Socket` answers `ref()` and `unref()` on a socket without a handle by waiting for a `connect` that never comes,
  leaving one more listener on it at each call. A sandbox service's stdin closes once its request line is written, so
  each request to a sandboxed extension process left two there, and Node warned of a leak at the eleventh
  (`MaxListenersExceededWarning`).
- **Its environment is the connector's.** Until step 3, the process runs as the host's user, in the session's
  directory, with the connector's environment, as extensions did in the connector. A promise an extension leaves
  failing is logged rather than ending the process.

## Step 3 as built, on Linux

- **The process is a sandbox service.** A session whose workspace is a Linux `Sandbox` starts its extension process with
  `Sandbox.startService`, as a server a session puts online is started (`session.ts`, `extensionProcess`): the same
  `bwrap` mounts and environment as the session's commands, its egress proxy (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`,
  the interception CA), the host's Node.js as the sandbox is given it (`nodeBin` is its `bin` directory), and the session's worktree, at the sandbox's
  path, as its working directory. Its lifetime is a service's longest (24 hours); when it ends, the next request starts
  another, as after a crash.
- **A socket instead of the IPC channel.** The sandbox's helper doesn't pass an IPC channel on, so the child listens on
  `extensions.sock` in the service socket directory and speaks newline-delimited JSON (`child.ts`, `lines.ts`). The
  connector pins the socket the way it pins a service's (`pinServiceSocket`): it links it into a directory of its own
  only once it is a socket owned by the connector's user, so the process can't point the connector at another socket
  on the host. A message over 64 MiB ends the process.
- **Mounted read-only, at the host's own paths:** the connector's code (the `node_modules` the release runs from, or a
  source checkout's root, `workerCodeMounts`) and each installed extension's project (`installMount`: the package with
  its dependencies, a local package's directory, or a local single-file extension alone). `Sandbox.startService`
  refuses a mount that is a system directory, the home directory or one of its parents, anything under `/tmp`
  (the sandbox's `/tmp` is a link into its home), `/run`, `/proc`, `/dev`, `/sys`, `/etc` or `/sessions`, and the
  session's own files (`serviceBindAllowed`). A source whose files are somewhere refused is refused alone, before its path
  joins the mounts, so it can't keep the session's other extensions from starting. Run from a source checkout
  (`pnpm connect`), the connector's code is the checkout's root, which is mounted whole, `.env` files included; a
  release mounts only the `node_modules` it runs from. A source opened later whose files aren't mounted yet restarts the process
  with them; the adapter declares a session's mounts before opening its sources, so that is one restart at most.
- **It fails closed.** A sandbox the host's Node.js can't be given to refuses every request (`refusedChannel`) rather
  than run extensions outside it.
- **Not yet on macOS and Windows.** Their sandboxes run commands through `HelperWorkspace`, which has no services; their
  sessions' extension processes run as in step 2, as the host's user. So do those of sessions on the host and of
  unsandboxed hosts, whose commands do too.
- **What extensions lose there.** Files of the host outside the worktree and their own install (the npm copy of
  `context-files` loses its `host:` files; the copy built into the connector keeps them), the connector's environment
  (they get the sandbox's: the owner's `APP_` values and the proxy's), and any network the workspace's network access
  doesn't allow: a web search extension needs its provider's host allowed there.
- **Their tools are still host commands.** Calls stay limited to the host's owner and members granted host commands,
  as the rule in `host-commands.ts` counts every `extension.tool` operation as running on the host. Loosening that for
  sandboxed sessions is a separate decision.

Until step 3 ships on every platform, the rule in `docs/extensions.md` stands: the host's owner installs only extensions they trust with
their own account, as they would a program.
