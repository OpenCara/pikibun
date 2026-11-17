# Prompt cache warming

A host refreshes a session's prompt cache shortly before it expires by sending the session's last model request again
with a cap of one output token (#399, after Pine's `pine.cache-warming` and pi's own warming). The user-facing rules are
in [Models and tools](../models-and-tools.md#prompt-cache-warming); this note says where the pieces are and why.

## Where things are

| Piece | Where |
|---|---|
| The policy: refresh delay, cache lifetime, the savings estimate, replayable requests, refresh options | pi-ai's `cache-warming` module (1.5.2), used as it is: `getCacheWarmingDelayMs`, `getPromptCacheTtlMs`, `evaluateCacheWarming`, `isCacheWarmingReplayable`, `getCacheWarmingRequestOptions`, `CACHE_WARMING_MAX_AGE_MS`, `CACHE_WARMING_MAX_IDLE_AGE_MS` |
| Remembering each request, scheduling refreshes, the generation hooks | `apps/runner/src/session/cache-warming.ts` (`rememberRequests`, `CacheWarmers`) |
| What the session knows: is the conversation busy, would its next request differ, is it the shared conversation | `sessionWarming` in the same file, over the session's `Harness` and metadata |
| Wiring | `RunnerSession.openHarness`: the session's `Models` are wrapped, and the hooks sit on its `workspace-tools` extension, which every conversation of the session runs |
| The workspace setting | `workspace_cache_warming_settings` (`apps/server/src/cache-warming-settings.ts`), sent to hosts as `cacheWarming` in the answer of `POST /api/connectors/self/extensions/workspace`; `packages/shared/src/cache-warming.ts` |
| Client | **Settings → Workspaces → Prompt cache** (`apps/nsh/src/settings/workspace-options.tsx`) |

## Decisions

- **Remembered by response.** pi-durable sends a request through `Models.streamSimple` and gives `afterResponse` hooks
  only the response. The session's `Models` are wrapped in a proxy whose `streamSimple` keeps each request (model,
  context, options without the signal and callbacks, and when it was sent) in a `WeakMap` keyed by the response
  message, which pi-ai resolves before pi-durable runs the hooks. Everything else reaches the wrapped `Models` bound to
  itself, so refreshes (`completeSimple`) and compactions are not remembered.
- **Counted from the request's start.** Anthropic counts a cache entry's lifetime from when the request started, so the
  next refresh is due 90% of the lifetime after the request (then each refresh) was sent, not after its response ended.
  A refresh that can no longer go out by halfway between that time and the end of the lifetime (a slow check, a suspended
  host) is dropped, and warming ends.
- **No overlap with the session's own requests.** A `beforeRequest` hook stops the conversation's warmer, aborting a
  refresh under way, before every request attempt; the `afterResponse` hook starts a new warmer with the new request.
  Before each refresh the warmer also checks that `pi.live` shows no generation.
- **Would the next request differ?** Before each refresh: the conversation's model and reasoning level are still the
  request's, and its context still starts with the messages sent (compared as JSON). A compaction, a rewind or a reset
  changes the context, so they end warming. Pi-durable places a change of instructions or tools as a system entry after
  the context rather than rewriting its start, so the cached prefix stays useful and such a change doesn't end warming.
  A context an extension's `context` hook rewrote no longer matches, so it isn't warmed.
- **Which conversations are warmed once settled.** While a run works (`pi.live.run`) any conversation is warmed: its
  next request is certain. Once settled, only the session's current shared conversation (a `write` branch that isn't
  superseded) is, and not in sessions with a parent (sub-task sessions, side-ask forks, scheduled child runs): those
  rarely get another message, so pi's idle estimate overstates the saving. Side asks and pi's task-owned conversations
  aren't branches of that kind.
- **A failed refresh ends warming.** A refresh that ends in an error or is aborted leaves the cache as it was, so
  warming stops rather than schedule from a refresh that didn't happen; a thrown error is written to the connector's
  log. The next real request starts again.
- **Usage.** A refresh's usage is added to the conversation's `pi.usage` under its model, as pi-durable adds a
  response's (pi-durable doesn't export `addUsage`, so the session keeps a copy), so the session's usage includes it.
  Refreshes set `disableContinuation`, so the provider's thread state (such as an OpenAI response ID) stays the
  request's.
- **A workspace setting, delivered with the extensions answer.** The setting is the workspace's, chosen by its owners
  and admins, since the refreshes spend the account of whichever host runs a session there. Hosts already ask for the
  workspace's extensions answer, cached for 30 seconds, before each message; the mode rides on it as `cacheWarming`.
  A host that has never had an answer for the workspace doesn't warm; one whose server sends no `cacheWarming` (an
  older server) uses the default, `idle`. The mode is read before each refresh, so a change applies within a minute.
- **Older connectors** know nothing of it and don't warm; nothing on the server depends on it.
