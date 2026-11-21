# Releasing idle conversations' provider resources

pi-ai providers keep process-local state keyed by the provider session ID pi-durable gives each conversation
(`pi.provider`, `ProviderDoc`): the OpenAI Codex WebSocket, Anthropic message-thread state, and the Anthropic/Bedrock
strict-tool fallbacks. pi-durable releases them with `cleanupSessionResources()` only when its Harness closes, and a
connector keeps every session that isn't portable open for its whole life, so without more a long-running connector
would hold them for every conversation it ever ran. A session therefore releases a conversation's resources once it
has been idle for a while, and stays open.

## Where things are

| Piece | Where |
|---|---|
| The delay, the timers, the hooks, the release itself | `apps/runner/src/session/provider-release.ts` (`ProviderReleases`, `PROVIDER_RELEASE_IDLE_MS`) |
| What the session knows: is the conversation working, its provider session ID | `sessionReleases` in the same file, over the session's `Harness` (`pi.live`, `pi.provider`) |
| Wiring | `RunnerSession.openHarness`: the hooks sit on the `workspace-tools` extension beside cache warming's; `CacheWarmers` tells it when a conversation's warming ends (`WarmingSession.ended`); `RunQueue` tells it when a run's conversation settled (`RunQueueOptions.settled`) |

## Decisions

- **15 minutes after the last activity** (`PROVIDER_RELEASE_IDLE_MS`). Every request attempt (`beforeRequest`), every
  response (`afterResponse`), every compaction (`beforeCompact`), the end of a run, and the end of the conversation's
  cache warming start the delay again, which also cancels the release due before. Fifteen minutes is past the
  5-minute prompt cache's life, and a conversation warmed with the 1-hour retention is still warming until its warming
  ends, so a release never comes while a cached prefix is still being kept for the next request.
- **Never while it works or is warmed.** When the delay ends, the conversation is checked: a run, a generation or a
  compaction in `pi.live`, or a warmer still on it, starts the delay again instead. Any activity during the check (a
  new request) wins over it: the release goes out only if nothing touched the conversation since its timer was set.
- **Each conversation on its own.** Every conversation of a session (the shared one, side asks, reverts, pi's
  task-owned ones) has its own provider session ID, since a fork gets a fresh `pi.provider`; the hooks run in each, as
  they all run the `workspace-tools` extension, and the run queue's settle covers a run in a conversation that
  doesn't.
- **Safe to release.** The next request opens a new WebSocket, or sends the whole conversation instead of continuing
  its Anthropic thread; token counts and prompt caching are as before (pi-ai 1.6.0). Closing the session still closes
  the Harness, which releases every provider session it used again; releasing one twice does nothing. `close()` and a
  reopen cancel the pending releases, and a release whose session closed meanwhile does nothing.
