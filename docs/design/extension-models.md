# Models that a host's extensions provide (#147)

Many Pi extensions register model providers (`pi.registerProvider`): proxies such as LiteLLM, subscription bridges,
providers Pi doesn't ship. Pikibun loads extensions for sessions ([host extensions](host-extensions.md)) and reports
`registerProvider` as ignored, so a host offers only what Pi's own `auth.json` and `models.json` give it
(`loadLocalPiModels`). This note says how a host offers its extensions' models too, and why that is a different kind
of decision from every other one about extensions.

## The tension

Everything else about installed extensions moved away from the host's authority: a process per session, in the
session's sandbox on Linux and macOS, behind its egress proxy, with descriptions of the host's models and no keys
([extension isolation](extension-isolation.md)). A provider is the opposite on each count:

- It **is** the code that makes model requests, with the host owner's credentials (an API key from the environment, or
  an OAuth token in Pi's `auth.json` that it refreshes and writes back).
- Models are **the host's**, not a session's: one list, reported in the manifest, for every workspace the host is
  shared with. No session's sandbox is the right place for it.
- pi-durable calls a model through the host's one `ModelRuntime`, in the connector.

So a provider extension can only run on the host, as the host's user, outside any sandbox, for every session that
picks one of its models. That can't be something a workspace turns on.

## Decisions

1. **The host's owner marks each extension, per version.** `HostConfig.modelExtensions` lists the sources that may
   provide models: owner only (`ownerOnlyHostConfig`), at most 16, each an `npm:<name>@<version>` or
   `git:<url>@<commit>` source, so a new version is a new decision. Nothing in a workspace's settings, an extension's
   own settings, a session or the `workspace` tool reaches it; the route is `PATCH /api/connectors/:id/config`, which
   only a person's signed-in app calls, and it is audited (`host.config.updated`). The host's page shows **Provide
   models** on each installed extension, to the owner, with a confirmation that says what it means.
2. **Only what the owner installed.** A marked source provides models only if the host's `ExtensionStore` has it at
   that exact source: installed with `pikibun extensions add` or by the owner's **Install**. Never a package a sandboxed
   session auto-cached (`ExtensionCache`), never a managed `@pikibun/` package, never one of Pikibun's own (`piki:`),
   and not a dev extension (`local:`), whose path the host's configuration would show to the host's admins.
3. **In the connector, registrations only.** The connector loads a marked extension's modules with Pi's loader, in its
   own process, with an extension runtime that is never bound: `registerProvider` calls made while the extension loads
   are queued (`pendingProviderRegistrations`, `pendingNativeProviderRegistrations`) and the connector applies them to
   its `ModelRuntime` (`registerProvider`, `registerNativeProvider`), as Pi's `ExtensionRunner.bindCore` and
   `createAgentSessionServices` do, then refreshes the runtime offline. No event is ever emitted to this copy, so its
   handlers (`session_start`, `tool_call`, ...) never run, its tools are never offered from it and its action methods
   throw as they do before Pi binds them. Its module code and its factory do run, in the connector: that is the
   authority the owner gives it. A provider registered later, from a handler, is not seen.
4. **Sessions still run their own copy, in their sandbox.** Whether a workspace also uses the extension's tools and
   hooks is unchanged: a session's copy runs in the session's extension process, with model descriptions and no keys,
   and its `registerProvider` stays ignored there. The two copies share nothing.
5. **Before the manifest, and again when the list changes.** The connector reads its configuration when it connects,
   before it sends its manifest; it applies the marked extensions then, and again from the extension sync (every 30
   seconds) when the list or the installed sources changed, sending the manifest again. Unmarking an extension, or
   removing it, unregisters its providers (Pi restores a built-in provider it had overridden); its code stays in the
   connector's memory until the connector restarts, doing nothing.
6. **Its models are models like any other.** They pass through `manifest()`: Pi's `enabledModels`, the 200-model limit,
   the metadata checks, and on the Pikibun server the Models section's switches (`connector_disabled_models`). A
   provider without credentials offers nothing, as for Pi's own (`getAvailable`). A connector started with `--model`
   offers exactly the models named, which are checked before any extension loads, so it offers no extension's.
7. **A failing extension costs its models, not the connector.** Each source is applied on its own: a module that
   doesn't load, a load that takes more than a minute, a registration `ModelRuntime` refuses, or a result the manifest
   refuses (over 200 models, a provider or model name outside the manifest's patterns) is rolled back (its providers
   unregistered) and logged on the host as `Extension models: <source>: <reason>`; the others, and Pi's own models,
   are offered as before. A provider that fails when called fails that model request, like any provider error.
8. **The host can refuse.** `pikibun connect --no-extension-models` never loads one, whatever Pikibun says, and the
   connector then doesn't advertise the `extensionModels` capability, so the switch is shown as unavailable.
9. **Sign-in happens in Pi.** A provider with OAuth (`oauth.login`) needs Pi's `/login` UI. The owner installs the
   extension in Pi on the host, signs in there, and Pikibun's connector then finds the credential in Pi's `auth.json`
   (the `ModelRuntime` refreshes tokens with the extension's `refreshToken`). Pikibun shows no sign-in.

## Trust

What the switch means: **this package's code runs in the connector, as the host's user, for as long as the connector
runs**, with the user's files, network and Pi credentials, and every model request a session makes to one of its models
passes through it (the prompt, the context, the answers). That is what installing the same extension in Pi on that
machine means, and no more: Pi runs it with the same authority.

What bounds it:

- **Only the host's owner, explicitly, per version.** Decisions 1 and 2. A workspace admin on a shared host can choose
  among the host's installed extensions for sessions, but can't make one provide models.
- **A sandboxed host stays sandboxed for everything else.** Marking an extension changes where that one package's
  provider code runs, not where sessions, their commands or their extensions run.
- **The Pikibun server's word, as for the owner's other choices.** The connector learns the list from the Pikibun
  server, as it learns `hostSessions`, `requiredExtensions` and install requests. Whoever controls the owner's Pikibun
  account, or the Pikibun server, could mark an installed extension, and with remote installs install one first: on a
  host that already takes sessions on the host (`hostSessions`) that adds nothing; on a sandboxed host that takes
  none, it is a way to run code outside the sandbox, which is why decision 8's local refusal exists and why
  `--no-remote-installs` narrows it to what was installed on the machine.
- **Nothing is taken from the extension but providers.** A provider's models are reported through `modelSummary`,
  which copies the provider, id, name and thinking levels and refuses anything else.

What it doesn't protect against:

- **The code itself.** It runs in the connector's process: it can read what the connector can, block its event loop
  or end it. A throw is contained (decision 7); `process.exit` or a busy loop is not. The alternative, a host-side
  process of its own that streams model events to the connector, would contain those and is left for later: it needs
  pi-ai's whole `Models` surface proxied over a channel, and two processes refreshing one `auth.json`.
- **A provider can replace one of Pi's.** `pi.registerProvider("anthropic", { baseUrl })` sends that provider's
  requests, and its key, to another address, as in Pi. The host's log names the providers each extension registered.
- **Transitive dependencies** of an `npm:` extension resolve when it is installed (no install scripts), as for every
  installed extension.

## Older servers and connectors

- **Older connector, newer Pikibun server.** `readHostConfig` keeps only the keys a connector knows, so an older one
  ignores `modelExtensions` and offers Pi's own models. It doesn't advertise `extensionModels`, and the host's page
  says to update it instead of offering the switch.
- **Newer connector, older Pikibun server.** The configuration has no `modelExtensions`, which reads as none, so
  nothing is loaded. The connector advertises `extensionModels` like its other capabilities, and a Pikibun server
  refuses a manifest with a capability it doesn't know, as it does for every capability added so far: a self-hosted
  Pikibun server is updated before its hosts' connectors.
- **Client.** The app shows the switch only where the host's configuration carries `modelExtensions` and the host
  advertises the capability, so an app newer than its server doesn't send a key the server would refuse.

## Left out

- **Virtual models** (`registerVirtualModel`): a router chooses a physical model per request (`ModelRuntime.resolveModel`),
  which pi-durable's sessions don't call. Still reported as ignored.
- **Dev extensions** (`local:`) as providers, and providers registered after loading.
- **Reporting failures in Pikibun.** A failed provider extension is logged on the host only; the host's page shows the
  switch and the Models section shows what arrived. `HostExtensionsReport` is parsed strictly by older Pikibun servers,
  so a new field needs the opt-in that `reportAutoCache` has.
- **A process of its own** for provider code (above).
- **Sign-in from Pikibun** for OAuth providers.
