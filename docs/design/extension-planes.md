# Decoupling extensions from connectors (#438)

Status: design note. Each phase below is one pull request, and phase 2 stops for the owner's go-ahead before changing a
default for every sandboxed host.

## Why

[Host extensions](host-extensions.md) bound every extension's discovery, installation, state and availability to a
connector (`connector_id`) because installed extensions first ran in the connector's own Node.js process as the host
owner's OS user, and every built-in session tool was code in `apps/runner`.

Since then, installed extensions moved into a per-session child process inside the session's Linux or macOS sandbox,
behind the workspace's egress proxy, with no model keys ([extension isolation](extension-isolation.md), steps 1 to 3),
six tools moved to data the Pikibun server serves ([tool definitions](tool-definitions.md)), and Pikibun's hook packages
gained pinned installs ([extension loading](extension-loading.md), phase 1 / #310). Yet the data model, install flow,
discovery and `piki:` catalogue still go through `connector_id`:

1. **Five mechanisms share one connector-bound extension model.** `PikiExtensionInfo`
   (`packages/shared/src/piki-extensions.ts`) carries 15 optional fields because built-in tool switches (24 no-op
   `sessionToolsFactory` entries), Pikibun server features (`piki:auto-mode`), pure workflow hooks (`piki:pr-flow`,
   `piki:sub-agents`, `piki:context-files`), credentialed CLI wrappers (`piki:gh`, `piki:glab`, `piki:azure-cli`) and
   third-party packages (`npm:`, `git:`) all report or filter through `connector_extensions`. A connector now reports 31
   `piki:` entries against `extensionLimits.connector` (32), running Pi's loader 24 times at start on empty factories,
   and two more switches would overflow `parseHostExtensionsReport` on older Pikibun servers when a host also has 64
   installed packages.
2. **Manual per-connector installs remain on sandboxed hosts.** Inside a sandboxed session, an agent can already run
   `pnpm install <pkg>` in its worktree without asking the host's owner. Yet when a workspace adds or updates
   `npm:pi-web-access@0.46.0` to `0.47.0`, every host owner in the workspace must click **Install** or **Update** per
   connector (`POST /api/connectors/:id/extensions/requests`), or sessions on that host silently run without it
   (*"Missing means without"*).
3. **Sessions in one workspace drift across hosts.** `sessionExtensions(workspace, installed, ...)`
   (`packages/shared/src/host-extensions.ts`) intersects `workspace_extensions` with each host's `connector_extensions`.
   With `piki:sub-agents` placing child sessions across qualifying hosts by load, and host pools (#181) ahead, sessions
   of the same workspace get different tools, guards, slash commands and system prompts depending on which host runs
   them.
4. **Discovery waits on a host's report.** `extensionOffer` (`packages/shared/src/workspace-tools.ts`) knows an `npm:`
   or `git:` extension's description, tools, `registerFlag` settings and tool-name collisions (`shadowed`) only once a
   host in that workspace has installed that exact version, run `describe.ts` and reported `HostExtensionsReport`
   (`unreported` until then).
5. **No Pikibun-server / remote extension plane.** Every extension hook and tool must run on the host's connector today.
   A workspace can't attach a remote MCP server or HTTP tool integration whose OAuth or API credentials stay in the
   Pikibun server's vault and work across shared hosts and older connectors. Even Pikibun's own brokered tools
   (`github_*`, `sessions`, `schedule`, `publish_artifact`) remain bespoke methods in
   `apps/runner/src/connector/runner-config.ts` because `BrokeredToolDefinition` (`packages/shared/src/tool-definitions.ts`)
   takes only flat scalar (`string`, `integer`, `boolean`) parameters and refuses Read-only messages outright.
6. **Storage is per connector pairing rather than per machine.** Desktop local hosts ([local-hosts.md](local-hosts.md))
   and re-paired connectors each keep their own `<state-dir>/extensions/packages/<digest>` and `connector_extensions`
   row rather than sharing a content-addressed cache on the computer.

## Three execution planes

What an extension offers belongs to the workspace (or to a host's `requiredExtensions`); where it executes is one of
three planes:

| Plane | What runs there | Host connector's role | Provisioning and trust |
|---|---|---|---|
| **1. Pikibun server / remote** (`server`, `remote-mcp`) | Remote MCP servers, HTTP tool integrations, `piki:auto-mode`, server-brokered tools | None: tools arrive as `BrokeredToolDefinition`s | Configured once in the workspace; credentials stay in the Pikibun server's vault; works on every host at once |
| **2. Session sandbox** (`sandbox`) | Workspace `npm:` and `git:` packages, and `piki:` workflow hooks, where both `describe` and the session's `extensionProcess` run in an OS sandbox | Content-addressed cache and sandboxed `ProcessChannel` | Workspace locks `(source, integrity)`; sandboxed hosts fetch and verify on demand (`--ignore-scripts`), unless `--no-remote-installs` |
| **3. Host** (`host`) | Unsandboxed hosts, sessions on the host (`onHost`), Windows until container extension processes land, `local:` dev extensions, and host-required guards | Bound to the host's `ExtensionStore` or `HostConfig` | The host's owner installs or requires it explicitly, as today |

No user setting names Plane 2 vs Plane 3 on an `npm:` or `git:` extension: the session's channel already knows whether
it is confined (`channel.sandboxed === true`, [extension isolation](extension-isolation.md)), and the connector knows
whether its `describe` runs in a sandbox (`sandboxDescribe` on Linux, `helperDescribe` on macOS). The same workspace
extension runs on Plane 2 on a sandboxed Linux or macOS session and falls back to Plane 3 (running only when the host's
owner installed it in `ExtensionStore`) on an unsandboxed host, an on-host session, or Windows.

## Decisions

1. **Tool switches stop depending on `HostExtensionsReport`.**
   - A connector sends `sessionToolSwitches: true` in `POST /api/connectors/self/extensions/workspace`. When set,
     `connectorWorkspaceExtensions` (`apps/server/src/extensions.ts`) returns every `sessionTools` switch (`piki:git`,
     `piki:node`, `piki:notion`, `piki:workspace`, …) without checking whether `HostExtensionsReport.installed` listed
     it—even before the connector's first `POST /api/connectors/self/extensions` sync.
   - Older connectors omit `sessionToolSwitches` and keep the `has.has(item.source)` filter and `piki:sources`
     replacement (`withReplacedSwitches`).
   - No new `sessionTools` switch is added to `connectorPikiExtensions` (`apps/runner/src/extensions/piki/index.ts`).
     The 24 switches already in `connectorPikiExtensions` stay reported only so a newer connector paired with an older
     Pikibun server still receives its disabled switches; they are removed together the next time
     `MINIMUM_CONNECTOR_VERSION` advances past a Pikibun server release with `sessionToolSwitches`, freeing 24 of the
     32 `extensionLimits.connector` slots and skipping 24 empty loader runs at connector start.

2. **Workspace extensions lock an immutable digest (`integrity`).**
   - Workspace extensions lock an immutable digest (`integrity`) for `npm:` packages (`workspace_extensions.integrity`,
     nullable `TEXT`; migrations for SQLite and Postgres).
   - For `npm:<package>@<version>`, `PUT /api/workspaces/:id/extensions` resolves the version's `dist.integrity`
     (`sha512-...`, matching `INTEGRITY` in `packages/shared/src/managed-extensions.ts`) from
     `https://registry.npmjs.org` (or accepts a caller-supplied `sha512-...` that matches the registry when reachable)
     and stores it. If the Pikibun server cannot reach the registry when the row is saved, `integrity` starts `NULL` (so
     airgapped self-hosted setups still save the extension for manually installed Plane 3 hosts) and is locked on the
     first verified install report or refresh; once set for `(workspace_id, source)`, `integrity` never changes without
     changing `source`.
   - `git:<url>@<commit>[#<directory>]` sources stay Plane 3 (installed explicitly by the host's owner in
     `ExtensionStore`): an arbitrary `https://` Git URL could otherwise reach a shared host's private network or
     tailnet when fetched outside a session's proxy.
   - `WorkspaceExtension` and `HostRequiredExtension` carry optional `integrity?: string` on the wire; older connectors
     ignore unknown fields or receive `WorkspaceExtension` without `integrity` unless they send `extensionLocks: true`
     in `POST /api/connectors/self/extensions/workspace`.

3. **A machine-wide content-addressed cache (`ExtensionCache`).**
   - Sandboxed auto-installed packages and managed `@pikibun/*` packages share a content-addressed layout keyed by
     `sha256("${source}\0${integrity ?? ""}")` (16 hex chars, or 32 hex chars in the shared cache):
     `<cache-dir>/pikibun/extensions/packages/<key>/`, where `<cache-dir>` is `$PIKIBUN_CACHE_DIR`, else
     `$XDG_CACHE_HOME` on Linux (`~/.cache`), `~/Library/Caches` on macOS and `%LOCALAPPDATA%` on Windows, with a
     fallback to `<state-dir>/extensions/cache` if the cache root isn't writable.
   - Several local hosts on one computer ([local-hosts.md](local-hosts.md)) and re-paired connectors share one install
     and one `pikibun-description.json` per `(source, integrity)`.
   - Installs stage in a sibling `<key>.tmp-<pid>-<random>` directory and rename atomically into `<key>` under a lock
     file (`<key>.lock`, stale after 5 minutes), so two sessions or two local hosts starting at once never corrupt each
     other's tree.
   - `serviceBindAllowed` (`apps/runner/src/sandbox.ts`, `seatbelt.ts`) already allows read-only mounts of directories
     under the user's cache directory as long as they are neither `$HOME` itself, `/tmp`, nor the session's files; tests
     on Linux and macOS verify the cache path mounts read-only into both sandboxes.
   - Pruning runs at most once per connector start after its first sync: entries untouched (`mtime` of a `used` marker
     updated on open) for 14 days and absent from the host's `requiredExtensions` and known workspaces are removed,
     keeping at most 128 cached packages (`CACHE_PACKAGES_LIMIT`). Explicit `pikibun extensions add` entries stay in
     `<state-dir>/extensions/sources.json` (`ExtensionStore`) and are never pruned.

4. **Lazy auto-provisioning on Plane 2 (sandboxed sessions, `npm:` packages with `integrity`).**
   - Auto-provisioning of a workspace's `npm:` extension runs **only** when all five hold:
     1. `source` is `npm:<package>@<version>` with a `sha512-...` `integrity` lock;
     2. `remoteInstalls` is true (not `pikibun connect --no-remote-installs`);
     3. the host's `autoCacheExtensions` option is enabled (opt-in in phase 1 via `--auto-cache-extensions` and
        `HostConfig.autoCacheExtensions`; on by default for sandboxed hosts in phase 2 after owner go-ahead);
     4. the connector's `describe` runs inside an OS sandbox (`sandboxDescribe` on Linux, `helperDescribe` on macOS);
     5. the session itself opens extensions on a sandboxed channel (`channel.sandboxed === true`, so never on an
        unsandboxed host, never in an on-host session, and never on Windows until its container runs `ProcessChannel`).
   - npm runs against `https://registry.npmjs.org` alone (`--registry=https://registry.npmjs.org`,
     `npm_config_allow_git=none`, `--ignore-scripts`, `--legacy-peer-deps`) with `npm_config_userconfig` and
     `npm_config_globalconfig` pointed at `/dev/null` (an empty file on Windows), so a shared host's `~/.npmrc` tokens,
     private registries and Git credentials are never read or sent. Every entry in `package-lock.json` must resolve from
     `https://registry.npmjs.org/`, and the root package's version and `integrity` must equal the workspace's lock.
   - **What that bounds, and what it doesn't:** the root package's tarball is verified by two parties (npm and the
     Pikibun server's stored `integrity`), nothing runs during `npm install`, and the loaded code runs only inside the
     describing sandbox and the session's sandboxed `ProcessChannel` (`MODEL_CALLS_REFUSED`, behind the workspace's
     egress proxy). A third-party package's own transitive npm dependencies, if it declares ranges, resolve from the
     public registry when the cache entry is populated and run inside that same sandbox, as `pnpm install` inside a
     session's worktree does.
   - When a session prepares a message (`chosenExtensions` in `apps/runner/src/session.ts`), any enabled workspace
     extension (or `requiredExtensions` entry) not in `ExtensionStore` that meets the five rules above is ensured in
     `ExtensionCache` (under `START_TIMEOUT_MS`, 60 seconds, with a 10-minute backoff per failed `(source, integrity)`
     key so a broken package doesn't stall every message), described in the describing sandbox, and opened in the
     session's sandboxed `ProcessChannel`.
   - On Plane 3 (unsandboxed hosts, on-host sessions, Windows, `git:` sources, or `--no-remote-installs`), nothing is
     auto-fetched: `sessionExtensions` keeps requiring an explicit install in `ExtensionStore`, and the session panel
     says why.

5. **Pikibun server caches extension descriptions by `(source, integrity)` (`extension_descriptions`).**
   - A new table `extension_descriptions (source TEXT, integrity TEXT, description_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (source, integrity))`
     (with `integrity = ''` for `git:` sources whose commit SHA is already in `source`) stores `{ name?, version?, description?, modules }`
     validated by `parseExtensionModules`.
   - Whenever any connector whose `describe` is sandboxed (advertised as `sandboxedDescribe: true` in capabilities, so an
     unsandboxed or modified host can't poison another workspace's tool descriptions—or, when none has reported yet,
     seeded with `{ name, version, description }` from the npm registry manifest without module summaries) reports an
     error-free `InstalledExtension` whose `(source, integrity)` matches, the Pikibun server records it.
   - `GET /api/workspaces/:id/extensions` returns `descriptions: Record<source, ExtensionOffer>` alongside `hosts`, and
     `workspaceTools` (`packages/shared/src/workspace-tools.ts`) falls back to `descriptions[source]` when no host of
     that workspace has reported the package yet. On a sandboxed host with `autoCacheExtensions` on, `availability`
     reports `"cached"` / `"ready"` (installs automatically on first session use) instead of `"missing"` whenever the
     extension has a valid lock.

6. **`BrokeredToolDefinition` takes bounded JSON Schema (`inputSchema`) and `readOnlySafe`, backing Plane 1 Remote MCPs.**
   - `BrokeredToolDefinition` (`packages/shared/src/tool-definitions.ts`) gains two optional fields alongside
     `parameters` (kept for connectors predating phase 3):
     - `inputSchema`: a bounded JSON Schema object (`type: "object"`, at most 64 properties, depth 6, 32 KB serialized,
       no `$ref` / `patternProperties` / arbitrary regexes over 256 chars), validated by `@earendil-works/pi-schema` /
       pi-durable before `execute` and re-validated on the Pikibun server route.
     - `readOnlySafe?: boolean`: when `true`, `definedTool` (`apps/runner/src/session/tools/defined.ts`) allows the call
       in Read-only messages and side asks (passing `mode: "read"` or the run's `admissionId` when present, checked via
       `authorize(actorId, "read")` instead of requiring a write `admissionId`). Tools that both read and write (such as
       `workspace` or `schedules`) keep enforcing write admissions on mutating actions on the Pikibun server.
   - `github_read`, `github_comment`, `github_issue`, `github_merge`, `schedule`, `sessions` and `publish_artifact` can
     then move onto `bundledToolDefinitions` as `BrokeredToolDefinition`s (keeping their routes for older connectors).
   - **Workspace Remote MCP servers (Plane 1):** a workspace's owners and admins register a remote MCP endpoint
     (`https://` URL on a public address, refused against `non-public-addresses.ts`, with optional Bearer / header
     secret stored encrypted in the Pikibun server's vault) under **Workspace → Extensions → Remote MCP**. The Pikibun
     server connects over Streamable HTTP (bounded at 15 seconds for `tools/list`, 60 seconds and 1 MB per `tools/call`),
     prefixes or namespaces colliding tool names, enforces `tool_groups` and `readOnlyHint` / Read-only rules, audits
     calls, and serves the discovered tools to connectors in `POST /api/connectors/self/tools` as
     `BrokeredToolDefinition`s routing to `broker/mcp/<serverId>/<tool>`. No host installs anything, no credential
     reaches a connector or sandbox, and `codemode` can chain them like any other tool.

7. **Policy-gated `complete` RPC on `ExtensionChannel` and unbundled `piki:*` packages.**
   - `ExtensionRequests` (`apps/runner/src/extensions/protocol.ts`) gains `complete`:
     `{ source, model?: { provider: string; id: string }, systemPrompt?: string, messages: UserMessage[], maxTokens?: number }`
     answering `{ content: TextContent[], stopReason: string, errorMessage?: string }`.
   - `ExtensionWorker`'s `describedRegistry` implements `streamSimple` over `complete` when `open` granted `modelCalls: true`
     for that source, and still throws `MODEL_CALLS_REFUSED` for every other source and for `getApiKey*`.
   - The connector grants `modelCalls: true` only to `piki:prompt-audit` and to sources in `HostConfig.requiredExtensions`
     where the host's owner turns on `allowModelCalls: true` for that required extension. Provider API keys and custom
     `models.json` headers never leave the connector process, and calls count under a 60-second timeout and 4,096
     `maxTokens` ceiling.
   - `sub-agents` joins `packages` / `managedSource` in `apps/runner/src/extensions/piki/index.ts`, and once `complete`
     is in place `piki:prompt-audit` leaves `bundledOnlySources` (`extension-loading.md` phase 4), moving into the
     per-session `ProcessChannel` too. `gh`, `glab` and `az` move to `ProgramToolDefinition` (`extension-loading.md`
     phase 3).

## Compatibility

- **Older connectors, newer Pikibun server:** older connectors omit `sessionToolSwitches`, `extensionLocks` and
  `sandboxedDescribe`; the Pikibun server sends them the filtered `WorkspaceExtension[]` and flat `ToolDefinition[]`
  they parse today (`parseToolDefinition` already skips individual definitions it can't parse).
- **Newer connector, older Pikibun server:** `connectorPikiExtensions` keeps reporting the existing 24 `sessionTools`
  switches until `MINIMUM_CONNECTOR_VERSION` advances; missing `integrity` on `WorkspaceExtension` simply skips Plane 2
  auto-provisioning for `npm:` packages and falls back to `ExtensionStore`, as before.

## Phases

| Phase | What lands | Default changed? |
|---|---|---|
| 1 | `sessionToolSwitches: true` on `/api/connectors/self/extensions/workspace` (lifting the 31/32 `connectorPikiExtensions` ceiling for new switches and fixing pre-report switch races); `sub-agents` enabled in `managedSource`; machine-wide `ExtensionCache`; `workspace_extensions.integrity` and `extension_descriptions` migrations; Plane 2 sandboxed auto-provisioning behind `--auto-cache-extensions` / `HostConfig.autoCacheExtensions` (off by default) | No |
| 2 | *(After owner go-ahead)* Turn on `autoCacheExtensions` and `managedExtensions` by default on sandboxed Linux and macOS hosts where `remoteInstalls` is true; update workspace/host availability UI to show auto-cached readiness | **Yes** — stops for decision first |
| 3 | `BrokeredToolDefinition` `inputSchema` (bounded JSON Schema) and `readOnlySafe`; Plane 1 Workspace Remote MCP servers on the Pikibun server with vault credentials | No |
| 4 | Policy-gated `complete` RPC on `ExtensionChannel` so `piki:prompt-audit` (and opted-in `requiredExtensions`) run in `ProcessChannel` without host keys; credentialed CLI rules on `ProgramToolDefinition` (`gh`, `glab`, `az`) | No |

## Alignment with #437 and #181

- **Dropping `pi-coding-agent` (#437):** Plane 1 (Pikibun server / Remote MCP) and data-defined tools don't use
  `pi-coding-agent` at all. Plane 2 and Plane 3 speak to extensions strictly across `ExtensionChannel` (`protocol.ts`),
  so replacing `piLoader` / `ExtensionRunner` inside `worker.ts` with a lightweight `ExtensionAPI` shim or a native
  `pi-durable` manifest leaves the cache, locks, sandbox mounts and Pikibun server tables untouched.
- **Host pools and remote sandboxes (#181):** Plane 1 tools and Plane 2 auto-cached extensions give every sandboxed
  member of a host pool the exact same workspace tools and hooks without pool operators manually syncing installs across
  machines.
