# Pikibun's React web client (deprecated)

> **Deprecated, to be deleted** with [`apps/desktop`](../desktop/README.md). The Native Shell client
> ([`apps/nsh`](../nsh/README.md)) replaces it: pikibun.com, the Docker image and `pikibun serve` serve that one, and no
> workflow builds, tests or ships this one any more. Build new features in `apps/nsh`.

The React web client. `pnpm build:web` still builds it into `dist/web` from a source checkout, where a server serves it
with `STATIC_DIR=dist/web` (see [choosing the web client](../../docs/self-hosting.md#choosing-the-web-client)), and
`pnpm test:web` tests it under its strict script policy.
