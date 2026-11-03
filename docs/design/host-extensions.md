# Extensions

Pi on a workstation is extended with extensions: modules that add tools, react to the agent's events and change its
prompt. Sessions in Pikibun run on `@earendil-works/pi-durable`, not on `pi-coding-agent`'s agent session, so none of
those load today: the runner installs one pi-durable extension of its own (`workspace-tools`, see `Session.buildTools`).

With this design a **workspace** chooses Pi extensions for its sessions, each pinned to an exact version, and each
**host** installs them, from Pikibun or from its command line. A session runs with exactly the workspace's extensions
its host has.

## Decisions

1. **Pi's extensions, as they are.** Extensions load through `pi-coding-agent`'s own loader (TypeScript, `pi` manifests,
   its bundled modules), in a session context like Pi's print mode (`hasUI: false`). Pikibun maps what pi-durable can do
   and turns UI, commands and the rest into no-ops. There is no Pikibun-specific API to port to.
2. **The workspace decides.** Its owners and admins add extensions (npm `name@version` or a Git commit), turn them on or
   off, and set their settings. Sessions run with the workspace's enabled extensions that their host has at that exact
   version, and no others.
3. **Hosts install, the host owner clicks.** Only the host's owner installs, updates or removes an extension on the host:
   from its page in Pikibun, where extensions a workspace uses but the host lacks show an **Install** button, or with
   `pikibun extensions` on the machine. Every install is pinned, runs no npm scripts, and is audited.
4. **In the connector process.** Extensions run in the connector, as the host's OS user, outside the sandbox, with its
   files, credentials and network. A buggy one can slow or crash the connector. Isolation is later work.
5. **Approval by default.** An extension tool call is decided like `host_bash`, by the host's owner or a member granted
   host commands. It runs without approval only where the workspace set the extension's tools to automatic **and** the
   host's owner lets workspaces do that on their host (off by default).
6. **Dev mode.** An extension installed from a local path on the host isn't something a workspace can name: it runs only
   in the host owner's own sessions on that host, in every workspace, marked as a dev extension.
7. **Missing means without.** A session on a host that lacks one of the workspace's enabled extensions, or has another
   version, starts without it and says so. (A per-extension **Required** switch could block it later.)
8. **Settings per workspace.** An extension's settings are its Pi flags (`registerFlag`); the workspace sets their values.
   Secrets never go there: the extension reads them on the host (its environment, files, or Pi's `auth.json`), which the
   host's owner sets up.
9. **Web tools are extensions.** Pikibun's own `web_fetch` and `web_search` are retired (`retiredToolNames`): no session
   offers them, the server's `WEB_SEARCH` provider and the workspace's **Web search** setting are gone, and older
   connectors' searches are refused (410). An extension may register tools with retired names, so a Pi web search
   extension provides `web_search` as it does in Pi. Unlike `web_fetch`, an extension's requests aren't confined by the
   workspace's network access: they run in the connector, approved like host commands unless automatic.
10. **Pi's built-ins, from the host's configuration.** Pi ships built-in extensions (pi-coding-agent's `builtInExtensions`).
   A host's owner and admins turn them on for every session on the host, in every workspace
   (`HostConfig.builtinExtensions`, Host → Extensions), with nothing to install. Pikibun runs pi-durable's own versions,
   because Pi's call other tools through the coding agent's loop (`ctx.executeTool`), which Pikibun doesn't run. Today
   that is **code mode** (`pi:codemode`, from `@earendil-works/pi-durable/codemode`). Pi's others have no counterpart:
   `mcp` and `llama.cpp` register MCP servers and providers (ignored, see below), and `tool-search` finds deferred tools,
   which Pikibun has none of.

## Compatibility

Pikibun runs each extension's factory with `pi-coding-agent`'s loader once per session, so module state and closures are
the session's own, then maps what it registered:

| Pi | In Pikibun |
|---|---|
| `registerTool` | A pi-durable tool (`execute(toolCallId, params, signal, onUpdate, ctx)`), behind the approval of rule 5. `onUpdate` is ignored. A tool named like one of Pikibun's own is ignored, unless that one is retired (`web_fetch`, `web_search`, …) |
| `before_agent_start` | Run once per message with its prompt; a returned `systemPrompt` (appended to the empty base it gets) and `message` become a prompt section |
| `context` | `GenerationHooks.beforeRequest` |
| `tool_call` | `ToolHooks.beforeTool`: `block`/`reason`, and changes made to `event.input` |
| `tool_result` | `ToolHooks.afterTool`: `content`, `isError`, `details` |
| `turn_start`, `turn_end` | Before each model request, `GenerationHooks.afterTools` (results ignored) |
| `message_end` | `GenerationHooks.afterResponse` (replacing the message is ignored) |
| `tool_execution_start`, `tool_execution_end` | Around each tool call |
| `agent_start`, `agent_end`, `agent_settled` | When a message starts and ends |
| `agent_before_settle` | `GenerationHooks.onYield`: `continue` sends one more turn |
| `session_before_compact` | `CompactionHooks.beforeCompact`: `cancel`, or `compaction.summary` |
| `session_start`, `session_shutdown` | When the session opens and closes |
| `registerFlag`, `getFlag` | The extension's settings, set by the workspace |
| `exec` | Runs on the host, in the session's worktree |
| `ctx.cwd`, `ctx.signal`, `ctx.model` | The session's worktree on the host, the call's signal, the session's model |
| `ctx.ui.*`, `registerCommand`, shortcuts, renderers, `setActiveTools`, `setModel`, `sendMessage`, `sendUserMessage`, `appendEntry`, session names and labels | No-ops, as in print mode; listed on the host's page |
| `registerProvider`, `registerMcpServer`, `registerVirtualModel`, `input`, provider-request events, `session_before_switch`/`fork`/`tree`, `user_bash` | Ignored; listed on the host's page as unsupported |

The host's page shows, per extension, which of its registrations work, are no-ops or are ignored, so a workspace can
tell what it gets. `ctx.modelRegistry` is the host's Pi model registry, so an extension that uses the host's provider keys
works.

Extensions written directly against pi-durable (`defineExtension`) are libraries without a plugin contract (their own
options and lifecycle), so a workspace can't name one. Pikibun wraps the useful ones itself as built-ins (rule 10).

## Built-in extensions

- `HostConfig.builtinExtensions` lists the names the host runs (`pi:<name>`, beside Pikibun's own `piki:<name>`; reads
  also take the bare names saved before, which migrations `0048`/`0041` rename), in the catalog's order (`builtinExtensions` in
  `packages/shared/src/host-config.ts`); the default is none. It is saved as `connector_configs.builtin_extensions_json`
  (sqlite `0047`, postgres `0040`) and read by the connector with the rest of the configuration, every 30 seconds. A
  connector drops names it doesn't ship rather than the whole configuration, and so does the control plane for stored
  names it no longer ships. Connectors that run them advertise `builtinExtensions`.
- A session installs every built-in in its registry when it opens, so a script it resumes finds its tool. Each shared
  message selects the ones the configuration turns on, after the workspace's extensions; one steps aside where a
  workspace extension of that message offers a tool by its name, as Pi's built-ins do (`extensions/builtin.ts`).
- **Code mode**: `createCodemodeExtension` with a QuickJS sandbox per session (`LimitedCodemodeSandbox`), 256 MiB per
  script, at most 2 scripts at once per session and 8 per connector (another is refused), and `models: false`.
  pi-codemode's `start()` sets no deadline unless the script asks for `timeout_ms`, so the sandbox stops a VM that has
  computed for 120 seconds in all (from its start and each delivered result until `onIdle`). That ends the script as a
  time-out, not an abort, which the tool would take for a closed sandbox. Time the script's calls take, approvals
  included, doesn't count. Pikibun gives the harness no execution environment, so the tool gets one of its own that
  writes only its full text output, into the worktree's `codemode-output/` as the message's sender (`writeFile`, the file
  tools' rules), except in Read-only messages; images still reach the model but aren't saved. Scripts call the conversation's callable
  tools as nested calls through the harness, so each one is permitted, approved (`extension.tool` cards included) and
  refused in Read-only messages exactly as the model's own call would be. Scripts survive a restart (pi-durable's
  journal). The script itself runs outside the OS sandbox, in a worker thread of the connector, but QuickJS gives it no
  Node, file system, network or timers.
- The session view lists the built-ins the next message gets (`SessionView.extensions.builtin`).

## Installing

On the host, or from its page (owner only):

```sh
npx pikibun@latest extensions add npm:@ollama/pi-web-search@0.0.5
npx pikibun@latest extensions add git:github.com/acme/search@<40-character commit>
npx pikibun@latest extensions add ./my-extension.ts          # dev mode: the host owner's own sessions only
npx pikibun@latest extensions list
npx pikibun@latest extensions remove @ollama/pi-web-search@0.0.5
```

Each source installs into its own directory, `<state-dir>/extensions/packages/<digest>/`, so two versions can sit side by
side and a new one loads without restarting the connector (Node caches modules by path). npm runs no install scripts,
installs no peer dependencies (the loader provides `pi-coding-agent`, `pi-ai`, `pi-tui` and `typebox`, as Pi does), and
fetches no Git dependencies of the extension's own; `package-lock.json` keeps the integrity of what was installed.

From Pikibun, the host's owner's **Install** (or **Update**, **Remove**) is recorded as a request for the host. The
connector syncs every 30 seconds (`POST /api/connectors/self/extensions`): it reports what is installed and how its last
requests went, and the answer lists the requests still to carry out, which it does at once and reports again. So nothing
reaches the host over its connection but its own sync, and a request made while it is offline waits for it.
`pikibun connect --no-remote-installs` refuses them; installs made with `pikibun extensions` meanwhile are picked up at
the next sync.
The connector already takes the control plane's word on who approved a host command, so an install the host's owner
starts in Pikibun asks for the same trust; it is recorded in the audit log.

## Where things show

- **Workspace → Extensions** (owners and admins edit, members read): the workspace's extensions, each with its source,
  **Enabled**, **Tools** (approval, automatic) and settings; per host shared with the workspace, whether it has each one
  (installed, missing, other version).
- **Host → Configuration → Extensions**: Pi's built-in extensions, each with an **Every session** switch for the owner and
  admins; what the host has installed and what each offers or ignores; the owner's **Install**, **Update**, **Remove**; **Let workspaces run extension tools without approval** (owner only). Per workspace
  the host is shared with, extensions it uses that the host lacks, with **Install** or **Update** for the owner.
- **Session**: the extensions it runs with, dev ones marked, and the workspace's enabled ones its host lacks.
- **Approval card** `extension.tool`: the extension, tool and exact arguments, decided like a host command.

## Data and routes

- `workspace_extensions`: workspace, source (normalized `npm:<name>@<version>` or `git:<url>@<commit>`), package key
  (`npm:<name>` or `git:<url>`, unique per workspace), enabled, tools mode, settings JSON, who changed it and when.
- `connector_extensions`: what the connector last reported (installed sources and their loaded extensions). Its dev
  extensions (their paths are the owner's files) are shown to the host's owner only.
- `connector_extension_settings.automatic_tools`: the host owner's switch.
- `connector_extension_requests`: the host owner's install and remove requests, with their outcome once reported.
- Connector → control plane: `POST /api/connectors/self/extensions` (ExtensionsSync: the report and request results;
  the answer lists pending requests), on connect and every 30 seconds; `POST /api/connectors/self/extensions/workspace`
  (WorkspaceExtensionsAnswer: one workspace's extensions and the host owner's switch), asked at most every 30 seconds
  per workspace, so changes reach running sessions from their next message.
- Apps → control plane: `GET /api/workspaces/:id/extensions` (members: the list and where each host stands),
  `PUT` (an extension, by package: a new version keeps its place) and `DELETE ?source=` (owners and admins);
  `GET /api/connectors/:id/extensions` (the host's owner and admins: its report, requests, and its workspaces'
  extensions it lacks), `POST /api/connectors/:id/extensions/requests` (`{ action, source }`, owner only) and
  `PATCH /api/connectors/:id/extensions` (`{ automaticTools }`, owner only).
- An `extension.tool` card is reviewed against the session: an enabled extension of its workspace, or a dev extension
  in its host owner's own session.

## In the runner

- `extensions/store.ts` installs; `extensions/load.ts` loads sources through `discoverAndLoadExtensions` and summarizes
  them; `extensions/adapter.ts` builds one session's pi-durable extension per source.
- A session loads the extensions that apply when it opens and installs them next to `workspace-tools`. Each message
  selects the ones that apply now (`configure({ extensions, tools })` in `applyOptions`) and runs `before_agent_start`;
  every tool and hook also checks before it runs, so turning one off stops its next use.
- An extension tool's call is refused in a Read-only message, otherwise an `extension.tool` card
  (`{ kind, extension, tool, arguments, digest }`) unless its tools run automatically. Its intent is committed before it
  runs; one interrupted mid-way isn't replayed. It stops at the host's command time limit.
- A hook that throws or times out is skipped and logged on the host, except `tool_call`, where it blocks the call.

## Status

| Part | State |
|---|---|
| Install store, loader and adapter through Pi's loader, `pikibun extensions` | Done |
| Sessions: selection, `before_agent_start`, lifecycle events, `extension.tool` cards; connector sync and installs | Done (`session.ts`, `extensions/host.ts`, `connector.ts`) |
| Control plane: tables, routes, owner/admin rules, connector reports, remote installs, audit | Done (`apps/server/src/extensions.ts`, migrations `0046`/`0039`) |
| Web and mobile: workspace and host sections, install buttons, session list, approval card | Done (`WorkspaceExtensions.tsx`, `HostExtensions.tsx`, `session-panel.tsx`; mobile: the approval card) |
| Pi's built-ins from the host's configuration: code mode | Done (`extensions/builtin.ts`, `host-config.ts`, `HostExtensions.tsx`) |

## Pikibun's built-in extensions (`piki:`)

The connector also carries workspace extensions of its own, `piki:gh`, `piki:glab` and `piki:azure-cli`, which every host
has without installing them and a workspace gets with its first repository on that forge: see
[Pikibun's built-in extensions](piki-extensions.md). Unlike Pi's built-ins above, the workspace chooses them, like any extension.

## Later

- Isolation in a worker or child process.
- `registerMcpServer` as tools, `registerProvider` feeding the host's models.
- `ctx.ui.confirm`/`select` as cards; asking the session owner instead of refusing tools in Read-only messages.
- `tool-search` as a built-in, once Pikibun defers tools (MCP servers' tools, say).
