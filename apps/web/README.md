# Pikibun's React web client (deprecated)

> **Deprecated, to be deleted.** The Native Shell client ([`apps/nsh`](../nsh/README.md)) replaces this one:
> pikibun.com already serves it (`STATIC_CLIENT=nsh`). This client stays only until the NSH client covers what still
> depends on it (the Electron desktop app's **This Computer** pages, through `window.pikibunDesktop`, and the default
> client of self-hosted servers and `pikibun serve`), and is then removed with [`apps/desktop`](../desktop/README.md).
> Fix what breaks here, but build new features in `apps/nsh`.

The React web client, built by `pnpm build:web` into `dist/web` and served by servers whose `STATIC_CLIENT` is unset or
`web` (see [choosing the web client](../../docs/self-hosting.md#choosing-the-web-client)). `pnpm test:web` tests it under
its strict script policy.
