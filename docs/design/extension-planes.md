# Decoupling extensions from connectors (#438)

Status: phases 1 to 4 are built (phase 2 with the owner's go-ahead). Each phase below is one
pull request. See [Phase 1 as built](#phase-1-as-built), [Phase 2 as built](#phase-2-as-built),
[Phase 3 as built](#phase-3-as-built) and [Phase 4 as built](#phase-4-as-built) where the code settles details of the
text below.

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
     (`sha512-...`, matching `EXTENSION_INTEGRITY` in `packages/shared/src/host-extensions.ts`) from
     `https://registry.npmjs.org` (checking any caller-supplied `sha512-...` against it) and stores it. If the Pikibun
     server cannot reach the registry when the row is saved, any unverified caller-supplied digest is dropped so
     `integrity` starts `NULL` (airgapped self-hosted setups still save the extension for manually installed Plane 3
     hosts, and a later save once the registry is reachable locks the verified digest); once set for
     `(workspace_id, source)`, `integrity` never changes without changing `source`.
   - `git:<url>@<commit>[#<directory>]` sources stay Plane 3 (installed explicitly by the host's owner in
     `ExtensionStore`): an arbitrary `https://` Git URL could otherwise reach a shared host's private network or
     tailnet when fetched outside a session's proxy.
   - `WorkspaceExtension` and `HostRequiredExtension` carry optional `integrity?: string` on the wire; older connectors
     ignore unknown fields or receive `WorkspaceExtension` without `integrity` unless they send `extensionLocks: true`
     in `POST /api/connectors/self/extensions/workspace`.

3. **A machine-wide content-addressed cache (`ExtensionCache`) and `sub-agents` in `managedSource`.**
   - Sandboxed auto-installed packages and managed `@pikibun/*` packages share a content-addressed layout keyed by
     32 lowercase hexadecimal characters (`sha256("${source}\0${integrity}").slice(0, 32)`):
     `<cache-dir>/pikibun/extensions/packages/<key>/`, where `<cache-dir>` is `$PIKIBUN_CACHE_DIR`, else
     `$XDG_CACHE_HOME` on Linux (`~/.cache`), `~/Library/Caches` on macOS and `%LOCALAPPDATA%` on Windows, with a
     fallback to `<state-dir>/extensions/cache` if the cache root isn't writable. Plane 3 installs made explicitly with
     `pikibun extensions add` or from a host's page keep their existing 16-character keys in
     `<state-dir>/extensions/packages/<dir>` (`ExtensionStore`), so nothing migrates.
   - `piki:sub-agents`, a hook package like `pr-flow` and `context-files`, joins `packages` and `managedSource` in
     `apps/runner/src/extensions/piki/index.ts` in phase 1 so a pin can update it too.
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
     3. auto-caching is on for the host: on by default for sandboxed hosts since phase 2, unless its connector runs with
        `--no-auto-cache-extensions` or its owner turned it off in Pikibun ([Phase 2 as built](#phase-2-as-built));
     4. the connector has an OS sandbox for describing and installing (`Sandbox` on Linux, `HelperWorkspace` over
        `SeatbeltBackend` on macOS);
     5. the session itself opens extensions on a sandboxed channel (`channel.sandboxed === true`, so never on an
        unsandboxed host, never in an on-host session, and never on Windows until its container runs `ProcessChannel`).
   - **Network and file boundary during `npm install`:** `npm` runs **inside a dedicated installing sandbox** (`Sandbox`
     on Linux, `SeatbeltBackend` on macOS, with its own empty home directory and both `npm_config_userconfig` and
     `npm_config_globalconfig` pointed at `/dev/null` so neither `~/.npmrc` nor a host-wide `$PREFIX/etc/npmrc` under
     `/usr` or the Node.js install can supply a registry token or setting) behind a local `EgressProxy` whose fixed
     `EgressGrant` allows HTTPS `CONNECT` to `registry.npmjs.org` alone
     (`{ mode: "allowlist", domains: ["registry.npmjs.org"], packageRegistries: false }`, checked through
     `non-public-addresses.ts`). Because the proxy sits in front of `npm` before any dependency is resolved, a direct
     tarball URL (`http://127.0.0.1/.../x.tgz`), a Git dependency or a redirect to any host other than
     `registry.npmjs.org` (or to a non-public IP) is refused before a connection is made.
   - **Post-install checks (defense in depth):** `npm` runs with `--registry=https://registry.npmjs.org`,
     `npm_config_allow_git=none`, `--ignore-scripts` and `--legacy-peer-deps`. Before the staged directory moves into
     `ExtensionCache`, the connector checks that every entry in `package-lock.json` resolved from
     `https://registry.npmjs.org/`, that the root package's version and `integrity` equal the workspace's lock, and
     that no symbolic link in the tree resolves outside the staged directory.
   - **What that bounds, and what it doesn't:** `npm` can reach only `registry.npmjs.org`, the root package's tarball is
     verified by two parties (npm and the Pikibun server's stored `integrity`), nothing runs during `npm install`, and
     the loaded code runs only inside the describing sandbox and the session's sandboxed `ProcessChannel`
     (`MODEL_CALLS_REFUSED`, behind the workspace's egress proxy). A third-party package's own transitive npm
     dependencies, if it declares ranges, resolve from `registry.npmjs.org` when the cache entry is populated and run
     inside that same sandbox, as `pnpm install` inside a session's worktree does.
   - When a session prepares a message (`chosenExtensions` in `apps/runner/src/session.ts`), any enabled workspace
     extension (or `requiredExtensions` entry) not in `ExtensionStore` that meets the five rules above is ensured in
     `ExtensionCache` (under `START_TIMEOUT_MS`, 60 seconds, with a 10-minute backoff per failed `(source, integrity)`
     key so a broken package doesn't stall every message), described in the describing sandbox, and opened in the
     session's sandboxed `ProcessChannel`.
   - On Plane 3 (unsandboxed hosts, on-host sessions, Windows, `git:` sources, or `--no-remote-installs`), nothing is
     auto-fetched: `sessionExtensions` keeps requiring an explicit install in `ExtensionStore`, and the session panel
     says why.

5. **Pikibun server registry metadata (`extension_descriptions`), and workspace-scoped host module reports.**
   - Connectors report their own capabilities ([security rationale](security-rationale.md)), so a host's reported
     `modules` and tool descriptions must never populate a table shared across workspaces: a modified host in one
     workspace could otherwise inject prompt text or misleading tool descriptions into another workspace's offer view.
   - Shared rows in `extension_descriptions (source TEXT, integrity TEXT, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (source, integrity))`
     hold **only** data the Pikibun server fetches and verifies itself from `https://registry.npmjs.org` (`name`,
     `version`, `description`, verified against `dist.integrity` when saving `PUT /api/workspaces/:id/extensions`).
   - Dynamic module summaries (`modules`: registered tools, events and `registerFlag` settings) reported by connectors
     stay scoped to the hosts shared with that workspace (`connector_extensions`), as `extensionOffer`
     (`packages/shared/src/workspace-tools.ts`) reads them today; at runtime, the model's tool definitions always come
     from each session's own `ExtensionWorker`, never from `extension_descriptions` or another host's report.
   - `GET /api/workspaces/:id/extensions` returns `registryMetadata: Record<source, { name: string; version: string; description?: string }>`
     alongside `hosts`, so a newly added `npm:` package shows its verified package description before any host runs it,
     and on a sandboxed host with `autoCacheExtensions` on, `availability` reports `"auto-cache"` (fetched on first
     session use) instead of `"missing"` whenever the extension has an `integrity` lock.

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
     prefixes or namespaces colliding tool names, enforces `tool_groups`, audits calls, and serves the discovered tools
     to connectors in `POST /api/connectors/self/tools` as `BrokeredToolDefinition`s routing to
     `broker/mcp/<serverId>/<tool>`. Because a remote MCP server's `annotations.readOnlyHint` is untrusted, every remote
     MCP tool defaults to `readOnlySafe: false` (refused in Read-only messages and side asks); `readOnlyHint` is shown
     only as a label on the settings page, and `readOnlySafe` becomes `true` only for tool names a workspace owner or
     admin explicitly lists in `readOnlyTools` on that MCP registration. No host installs anything, no credential
     reaches a connector or sandbox, and `codemode` can chain them like any other tool.

7. **Policy-gated `complete` RPC on `ExtensionChannel` and unbundled `piki:prompt-audit` / CLI definitions.**
   - `ExtensionRequests` (`apps/runner/src/extensions/protocol.ts`) gains `complete`:
     `{ source, model?: { provider: string; id: string }, systemPrompt?: string, messages: UserMessage[], maxTokens?: number }`
     answering `{ content: TextContent[], stopReason: string, errorMessage?: string }`.
   - `ExtensionWorker`'s `describedRegistry` implements `streamSimple` over `complete` when `open` granted `modelCalls: true`
     for that source, and still throws `MODEL_CALLS_REFUSED` for every other source and for `getApiKey*`.
   - The connector grants `modelCalls: true` only to `piki:prompt-audit` and to sources in `HostConfig.requiredExtensions`
     where the host's owner turns on `allowModelCalls: true` for that required extension. Provider API keys and custom
     `models.json` headers never leave the connector process, and calls count under a 60-second timeout and 4,096
     `maxTokens` ceiling.
   - Once `complete` is in place, `piki:prompt-audit` leaves `bundledOnlySources` (`extension-loading.md` phase 4),
     moving into the per-session `ProcessChannel` too, and `gh`, `glab` and `az` move to `ProgramToolDefinition`
     (`extension-loading.md` phase 3).

## Compatibility

- **Older connectors, newer Pikibun server:** older connectors omit `sessionToolSwitches` and `extensionLocks`; the
  Pikibun server sends them the filtered `WorkspaceExtension[]` and flat `ToolDefinition[]` they parse today
  (`parseToolDefinition` already skips individual definitions it can't parse).
- **Newer connector, older Pikibun server:** `connectorPikiExtensions` keeps reporting the existing 24 `sessionTools`
  switches until `MINIMUM_CONNECTOR_VERSION` advances; missing `integrity` on `WorkspaceExtension` simply skips Plane 2
  auto-provisioning for `npm:` packages and falls back to `ExtensionStore`, as before.

## Phases

| Phase | What lands | Default changed? |
|---|---|---|
| 1 | `sessionToolSwitches: true` on `/api/connectors/self/extensions/workspace` (lifting the 31/32 `connectorPikiExtensions` ceiling for new switches and fixing pre-report switch races); `sub-agents` enabled in `managedSource`; machine-wide `ExtensionCache`; `workspace_extensions.integrity` and `extension_descriptions` migrations; Plane 2 sandboxed auto-provisioning behind `--auto-cache-extensions` / `connector_extension_settings.auto_cache` (off by default) | No |
| 2 | *(Owner go-ahead given)* Turn on `autoCacheExtensions` and `managedExtensions` by default on sandboxed Linux and macOS hosts where `remoteInstalls` is true; update workspace/host availability UI to show auto-cached readiness | **Yes** — stops for decision first |
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

## Phase 1 as built

- **The host owner's switch lives in `connector_extension_settings.auto_cache`** (`PATCH /api/connectors/:id/extensions`
  with `{ autoCache: boolean }`, audited as `connector.extension.auto_cache`, and carried to connectors sending
  `extensionLocks: true` as `WorkspaceExtensionsAnswer.autoCache`) alongside `pikibun connect --auto-cache-extensions`,
  rather than on `HostConfig`, which older connectors parse with a fixed set of keys.

## Phase 2 as built

- **The default is the connector's, the override the owner's.** A connector whose sessions open extensions in the
  sandbox (Linux with bubblewrap, macOS with Seatbelt) turns `autoCache` and `managed` on unless started with
  `--no-auto-cache-extensions` / `--no-managed-extensions` (`--auto-cache-extensions` / `--managed-extensions` still turn
  them on, and are the only way on hosts without the sandbox, where auto-caching still never runs). Local `--no-...`
  wins over Pikibun's setting, since it is the host owner's machine: the connector reports it as
  `HostExtensionsReport.autoCacheRefused`, and the Pikibun server then never reports `"auto-cache"` for that host, even
  with the setting on, so its extensions stay installable there.
- **The Pikibun server's setting has three states**: `connector_extension_settings.auto_cache = 1` (on),
  `auto_cache_off = 1` (off), neither (follow the host's default). `PATCH /api/connectors/:id/extensions` takes
  `{ autoCache: true | false | null }`; `WorkspaceExtensionsAnswer.autoCache` carries `true` or `false` to connectors
  sending `extensionLocks: true` and is left out for the host's default. Phase 1 connectors read only `true`, so an
  explicit off leaves them at their own default, which was off.
- **The host reports its default** as `HostExtensionsReport.autoCache`, only once the Pikibun server's sync answer says
  `reportAutoCache: true`, because older Pikibun servers refuse a report with a key they don't know. Availability is
  `"auto-cache"` where the setting is on, or follows the host and the host reports `autoCache: true`, and the host is
  sandboxed Linux or macOS with remote installs.
- **UI**: the workspace page shows **Fetched on first use** for such hosts, offers no **Install** there, and falls back
  to the Pikibun server's verified `registryMetadata` description before any host reports the extension; the host page
  has **Fetch workspace extensions in the sandbox** (host default, on, off) and lists the workspace extensions it will
  fetch instead of as missing.
- **Plane 3 isolation on the same machine:** `ExtensionCache` (`apps/runner/src/extensions/cache.ts`) stays separate from
  `ExtensionStore` (`sources.json`), and `RunnerSession` consults `ensureCached` / `peekCached` only when the session's
  own extension channel runs inside the OS sandbox (`sandboxedExtensionChannel()`), so an on-host session on the same
  computer never loads a package that only a sandboxed session auto-cached.
- **Describing fails closed:** the `ExtensionCache` describer passes `refusingDescribe` as the fallback to
  `sandboxDescribe` and `helperDescribe`, so a cache path the sandbox refuses to mount fails rather than falling back to
  an unsandboxed `processDescribe`.


## Phase 3 as built

- **`inputSchema` replaces `parameters` for a brokered tool that has one** (`packages/shared/src/tool-definitions.ts`,
  bounded by `sanitizeInputSchema` in `packages/shared/src/input-schema.ts`): the root is `type: "object"`, at most 64
  properties in all, 6 levels deep and 32 KB serialized; `$ref`, `$defs`, `definitions` and `patternProperties` refuse
  the schema, a `pattern` must compile and be at most 256 characters, and keywords outside the bounded set (`$schema`,
  `examples`, vendor keys) are dropped. Such a definition has empty `parameters` and `target`. Older connectors skip a
  definition with a key they don't know (`parseToolDefinitions` passes over what fails to parse), so they never see one.
- **`readOnlySafe` is the existing `write` flag.** A brokered tool with `write: false` already runs in Read-only messages
  (`ToolCalls.check` refuses only write effects there), so no second flag was added. Side questions (`mode: "ask"`) have
  no run admission and still can't call brokered tools; the Pikibun server checks the admission as for `source_read`.
- **Workspace remote MCP servers** (`workspace_mcp_servers`, an authority table; `apps/server/src/authority/remote-mcp/`):
  owners and admins add up to 8 per workspace (`/api/workspaces/:id/mcp-servers`) by name, a prefix
  (`^[a-z][a-z0-9]{0,15}$`, unique in the workspace, starting each tool's name), an `https://` address without
  credentials, and up to 8 headers, which are encrypted with `VAULT_KEY` (context `remote-mcp:<id>`), never shown again
  (only their names) and never audited. The Pikibun server speaks Streamable HTTP (JSON or SSE answers, `Mcp-Session-Id`,
  `MCP-Protocol-Version: 2025-06-18`), lists tools on save and on **List tools again** (15 s), and calls them (60 s),
  each answer capped at 1 MB and a result shown to the model at 64 KB, text parts only.
- **Only public addresses**: `publicHttpsTransport` connects with a `lookup` that refuses any resolved address in
  `NON_PUBLIC_IPV4` / `NON_PUBLIC_IPV6` as it connects (so a name that rebinds to a private address after a check gets
  nowhere), refuses literal private addresses, and follows no redirect.
- **Delivery**: connectors that send `remoteTools: true` on `/api/connectors/self/extensions/workspace` get
  `WorkspaceExtensionsAnswer.remoteTools`, brokered definitions named `<prefix>_<tool>`, switched by
  `piki:remote-mcp` (on unless a workspace turns it off), routed to `mcp/<prefix>/<16-hex key of the tool's name>`, which
  the connector forwards to `/api/connectors/self/mcp/:prefix/:key` with the session, requester, admission and
  `arguments`. The session validates `arguments` against the schema before forwarding, and the Pikibun server again
  (pi-schema `compile`) before calling.
- **Untrusted `readOnlyHint`**: every tool is `write: true` unless its name is in the registration's `readOnlyTools`;
  a write tool is refused for a Read-only message's admission (`run_admissions.access = 'read'`), and every call is
  audited as `workspace.mcp.called` with the server, tool and whether it may write.
- **Open sessions follow the current registration.** A session reads its workspace's `remoteTools` at each call
  (`SessionDefinitions.current`): a tool removed or turned off is off for the session (`definedToolsOff`), and a call uses
  the current `write` flag, schema and route; only the tool's description and schema shown to the model stay as they were
  until the session next opens.
- **Deadlines**: a call has one deadline (60 s) for its `initialize`, `notifications/initialized` and `tools/call` together;
  the connector waits 30 s longer than that for `mcp/` routes, so it never reports a call as failed that the Pikibun server
  still completes. An event-stream answer is taken as soon as the response with the request's id arrives, without
  waiting for the server to close the stream. A failed re-listing keeps the tools last listed and shows the error.

## Phase 4 as built

- **`complete` goes from the extension process to the connector**, not the other way: the child sends
  `{ ask, complete: CompleteRequest }`, and the connector answers `{ answered, value | error }` (`child.ts`, `process.ts`);
  an abort in the extension sends `{ cancelAsk }`, and a process that stops aborts its calls. `ExtensionWorker` gives a
  source opened with `modelCalls: true` a described registry whose `streamSimple` makes that request (`streamOver`); every
  other source's still throws `MODEL_CALLS_REFUSED`.
- **Only `piki:prompt-audit` for now** (`modelCallSources`, `apps/runner/src/extensions/complete.ts`). The connector
  checks it again on every request (the source was opened with `modelCalls` in the process that asks), validates the
  request (user messages only, at most 32, text and `image/*` parts, bounded sizes), and calls the session's model or
  the one named with its own registry (`completeWith`): at most 4,096 tokens, 60 seconds, 4 at once, text-only answers.
- **The guard runs outside the session's sandbox.** A managed prompt audit opens in a third channel of
  `SessionExtensions` (`guardChannel`): a `ProcessChannel` the connector starts as the host's user, not
  `extensionProcess` (the session's sandbox), so the agent whose messages it audits can't touch the process. Its code is
  a pinned, digest-checked `@pikibun/` package, as trusted as the connector.
- **`bundledOnlySources` is empty**, so a pin for `piki:prompt-audit` now applies like one for `pr-flow`. No pin exists
  yet, so every host still runs the bundled copy in the connector until a release pins one.
- **`allowModelCalls` on a host's required extensions** (#438 phase 4, second part): the host's owner ticks **May call
  models** on a required extension (`RequiredExtension.allowModelCalls`, kept in `connector_configs.required_extensions_json`,
  no migration). Older connectors take a fixed set of keys in each required extension, so `/api/connectors/self/config`
  leaves the key out for a connector that doesn't announce the `modelCalls` capability. A connector that does opens such an
  extension with `modelCalls` in a process of its own (`SessionExtensions.callerChannel`, keyed by source and, in the
  Linux sandbox, with its own socket): sandboxed where the session is, since it is someone else's code, and holding
  nothing else, because the source a child names in a request is only its word for it. Each such process, like each
  guard process, answers model calls for its own source only (`bound`), whatever the child claims, and the session's
  shared extension process answers none, so no other extension can spend the owner's accounts under its name. The
  connector checks the setting again on every call (`SessionPiki.host().complete`), so turning it off refuses the next
  call without waiting for the session to reopen.
- **`gh`, `glab` and `az` are data** (`kind: "cli"`, `packages/shared/src/cli-definitions.ts`), not
  `ProgramToolDefinition`s: those run a program in the sandbox under the session's grants, while these tools run on the
  host's sign-in or with a leased forge token, refuse what would show a token, and tell reads from writes per subcommand
  and API method. So the definition carries the rules (refusals; read-only groups or verbs; `api`, `rest` and `devops
  invoke` request rules; `@file`, `--web`, file-writing and secret-word checks; the `gh` watch interval) and
  the engine (`apps/runner/src/extensions/piki/cli-engine.ts`) keeps how a call runs (`command.ts`: environment, the
  sandbox and its lease, the host's sign-in, output). The connector builds its own `ghSpec`, `glabSpec` and
  `azureCliSpec` from the bundled definitions, so the existing tests hold the data to the old code's behavior.
- **Served definitions only tighten.** `/api/connectors/self/tools` answers `clis` beside `tools` (older connectors read
  only `tools`). A connector that reads them applies a served definition on top of its own: a call is refused if either
  refuses it, and counts as a write if either says so (`PikiSession.servedRules`). So Pikibun can refuse more, or count
  more commands as writes, without a connector release, but neither a compromised Pikibun server nor a mistaken release
  can loosen what the connector holds, such as the refusals that keep its tokens hidden. A definition that would refuse
  nothing, names another extension, or sets variables or roots outside bounded patterns is passed over.

