# Host extensions

Pi on a workstation is extended with extensions: TypeScript modules that add tools, react to the agent's events and
change its prompt. Sessions in Pikibun run on `@earendil-works/pi-durable`, not on `pi-coding-agent`, so none of those
load: the runner installs one pi-durable extension of its own (`workspace-tools`, see `Session.buildTools`).

A **host extension** is code the host's owner installed on the host, written against `PikibunExtensionAPI` (modelled on
Pi's `ExtensionAPI`), which the connector loads and installs into its sessions' pi-durable registry. The host's owner and
admins turn each one on and configure it from the host's page in Pikibun (**Settings → Hosts → the host → Extensions**),
as they enable its models.

## Decisions

1. **Installs only from the host.** Only `pikibun extensions add` on the machine installs code. The control plane turns an
   installed extension on or off and sets its settings; it never sends code or names a package to install, so neither a
   compromised server nor a host admin can make a host run code its owner didn't put there.
2. **In the connector process.** Extensions load into the connector, as Pi loads them into its own process. They run as
   the host's OS user, outside the sandbox, with its files, credentials and network; a buggy one can slow or crash the
   connector. Isolation (a worker or child process) is later work.
3. **Only the new API.** Pi's extensions don't load as they are: an extension's default export takes a
   `PikibunExtensionAPI`. Porting a Pi extension that uses only what the API offers is mostly renaming.
4. **Owner turns on, admins can turn off.** Turning an extension on, choosing which sessions get it and letting its tools
   run without approval are the owner's; admins can turn one off and change its settings.

## Rules

1. **Off until turned on.** A newly found extension is listed, disabled.
2. **Decided like a host command.** An extension tool call is an operation decided like `host_bash`: by the host's owner
   or a member granted host commands, unless the owner set the extension's tools to run automatically. Under the session
   owner's Auto-approve it runs without asking only where a host command would.
3. **No secrets in Pikibun.** Settings are plain JSON, visible to the host's owner and admins and recorded in the audit
   log. Keys and tokens stay on the host (its environment, files, or Pi's `auth.json`), where the extension reads them.
4. **Visible to everyone in the session.** A session lists the host extensions it runs with, as it shows **Runs on the
   host**, and a member starting a session on someone else's host sees them before **I trust …'s host**.

## Writing one

An extension is a module whose default export is a factory, as in Pi:

```typescript
import type { PikibunExtensionAPI } from "pikibun/extension";

export default function (pi: PikibunExtensionAPI) {
  pi.describe("Searches the team's internal index.");
  const settings = pi.settings(pi.Type.Object({ endpoint: pi.Type.String({ default: "https://search.example.com" }) }));

  pi.registerTool({
    name: "team_search",
    description: "Search the team's internal index.",
    parameters: pi.Type.Object({ query: pi.Type.String() }),
    replay: "safe",
    async execute(args, ctx) {
      const response = await fetch(`${settings().endpoint}/q?${new URLSearchParams({ q: args.query })}`,
        { headers: { Authorization: `Bearer ${process.env.TEAM_SEARCH_TOKEN}` }, signal: ctx.signal });
      return await response.text();
    },
  });

  pi.on("before_agent_start", ctx => `Session ${ctx.session.id} belongs to ${ctx.session.owner.id}.`);
  pi.on("tool_call", call => call.name === "bash" && /rm -rf \//.test(String(call.arguments.command)) ? { block: "Not here." } : undefined);
}
```

`PikibunExtensionAPI` (`apps/runner/src/extensions/api.ts`) keeps Pi's names where pi-durable has the same thing:

| `PikibunExtensionAPI` | pi-durable | Pi |
|---|---|---|
| `registerTool({ name, description, parameters, execute, replay?, executionMode? })` | `defineTool` | `registerTool` |
| `on("before_agent_start", ctx => text)` | `section` | `before_agent_start` (system prompt) |
| `on("context", messages => messages)` | `GenerationHooks.beforeRequest` | `context` |
| `on("tool_call", call => { block } \| { arguments })` | `ToolHooks.beforeTool` | `tool_call` |
| `on("tool_result", (call, result) => result)` | `ToolHooks.afterTool` | `tool_result` |
| `on("turn_end", …)` | `GenerationHooks.afterTools` | `turn_end` |
| `on("message_end", …)` | `GenerationHooks.afterResponse` | `message_end` |
| `on("agent_before_settle", answer => { continue })` | `GenerationHooks.onYield` | `agent_before_settle` |
| `on("session_before_compact", …)` | `CompactionHooks.beforeCompact` | `session_before_compact` |
| `settings(schema)`, `describe(text)`, `Type` | the host's extension settings | flags |

Not offered: `ctx.ui`, `registerCommand`, shortcuts, flags, renderers, `sendUserMessage`, `appendEntry`, session
lifecycle events (`session_start`, `session_shutdown`, `agent_start`, …), `input` and provider-request hooks,
`registerProvider` (models come from the host's Pi, see `local-pi.ts`) and `registerMcpServer`.

- The factory runs once when the connector starts, to learn what the extension offers, then once per session: closures
  and module state outside the factory are shared by every session on the host. Register everything while it runs;
  later registrations are ignored. Don't start processes or timers in it.
- A tool's `ctx` carries the call's `signal`, `output()` for streaming, the settings, and a read-only view of the session:
  its id, workspace, owner, whether it runs on the host, and its worktree's path on the host. Not Pikibun's credentials,
  the egress proxy, or other sessions.
- Hooks may run again on recovery (pi-durable runs `beforeRequest` before every attempt), and have a time limit. One that
  throws or times out is skipped and logged on the host, except `tool_call`, where a throw blocks the call (pi-durable's
  rule), so a broken guard never lets through what it would have stopped.

## Installing one

```sh
npx pikibun@latest extensions add npm:@acme/pikibun-search@1.2.0      # an exact version
npx pikibun@latest extensions add git:github.com/acme/search@<commit>  # a full commit, over https
npx pikibun@latest extensions add ./team-search.ts                      # a file or directory, loaded in place
npx pikibun@latest extensions list                                      # loads them and shows what each offers
npx pikibun@latest extensions remove @acme/pikibun-search
```

Installs live in the connector's state directory (`<state-dir>/extensions`: a private npm project, and `sources.json`
listing every source in order). npm runs no install scripts unless `--allow-scripts`, and fetches no Git dependencies of
the extension's own. An npm or Git package says it is an extension (`"pikibun": { "extensions": ["./dist/index.js"] }` in
its `package.json`), so no other package's default export ever runs; a local directory may instead keep its modules in
`extensions/` or have an `index.js`. Node.js strips TypeScript only outside `node_modules`, so a published extension ships
JavaScript; local ones can be TypeScript. Restart the connector after adding or removing one.

## Configuring one

The connector advertises what it loaded (HostExtensionSummary, `packages/shared/src/host-extensions.ts`): per extension
its name, source and version, description, tools, events, and settings schema (JSON Schema), or why it didn't load.

| Setting | Values | Changed by |
|---|---|---|
| `enabled` | on / off | Owner turns on; owner and admins turn off |
| `scope` | `owner` (the host owner's sessions), `host` (sessions running on the host), `all` | Owner |
| `tools` | `approval` (decided as host commands) or `automatic` | Owner |
| `settings` | JSON valid against the advertised schema, 16 KB at most | Owner and admins |

`POST /api/connectors/self/extensions` takes the advertised list when the connector connects and answers with the
settings; the connector asks again at most every 30 seconds, so a change reaches running sessions from their next
request, without a restart. An older control plane answers 404 there, and its hosts run no extensions.

## In the runner

- `extensions/store.ts` installs; `extensions/load.ts` loads each module and records what its factory registers;
  `extensions/adapter.ts` builds a factory into a pi-durable `Extension` (`host:<name>`) for one session.
- Each session installs the built extensions into its registry next to `workspace-tools`. Each message selects the ones
  that apply (`configure({ extensions, tools })` in `applyOptions`); every tool, section and hook also checks before it
  runs, so turning one off stops its next use.
- An extension tool's call goes through `ExtensionHost.runTool`: refused in a Read-only message, else an
  `extension.tool` card (`{ kind, extension, tool, arguments, digest }`) decided like `host.bash` unless the extension's
  tools are automatic. The call's intent is committed before it runs; one interrupted mid-way is not replayed unless the
  tool says `replay: "safe"`. Tools stop at the host's command time limit.

## Status

| Part | State |
|---|---|
| API, loader, adapter, `pikibun extensions` | Done (`apps/runner/src/extensions/`, `extensions-cli.ts`, `tests/host-extensions.test.ts`) |
| Session integration, `extension.tool` approval cards | Next |
| Control plane: storage, routes, owner/admin rules, audit | Next |
| Host page **Extensions** section, session list, approval card in web and mobile | Next |
| `pikibun/extension` types for authors in the published package | Next |

## Later

- Extensions in a worker thread or child process, with a narrower API.
- MCP servers as tools; `registerProvider` feeding the host's model list.
- Asking the session owner (a permission card) instead of refusing extension tools in Read-only messages.
