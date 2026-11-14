# Native Shell prototype: Mac test results

> **Since this report** (all three found here, and fixed on the same branch):
>
> - **Web**: the page's Content-Security-Policy now allows the runtime's inserted import map and `blob:` modules, and
>   the web app no longer stays on `Loading…`: NSH 0.4's web runtime has no `lifecycle`, and calling the missing import
>   threw as the signed-in screens were made (`src/lib/lifecycle.ts` stands in for it). `pnpm test:client-web` runs the
>   web build in headless Chrome in CI: signed out, signed in, a settings address, signing out, with no page errors or
>   policy violations.
> - **Native GitHub sign-in**: the app no longer signs in with GitHub (nor with a password); it signs in with a code
>   made on the web or in another signed-in app. `pnpm test:client-macos --live` checks that on a Mac. The GitHub
>   OAuth findings below are kept as they were observed.

Tested PR #206 at `063868b8a0650db2afbb3dc0fecc1684e26544d5` on an Apple Silicon Mac running macOS 26.6.2,
Node 26.13.0, pnpm 10.32.1 and Native Shell 0.4.0 (`e626a8d`). The macOS release archive's SHA-256 was verified.
These are observations on this machine, not a claim that every target or the complete repository suite passes.

## Passed

| Check | Result |
|---|---|
| Root `pnpm exec tsc --noEmit` | Clean |
| `tests/nsh-web.test.ts` | 4/4 |
| `pnpm test:nsh` | 14/14, including headless screen walkthroughs |
| App tests with `nsh test --target macos tests/app.test.tsx` | 12/12 on real AppKit windows |
| Screenshot tests with `nsh test --target macos tests/screenshots.test.tsx` | 2/2 after creating the output directory |
| `pnpm test:nsh-live` | 2/2, including server-side token revocation and serving the web package |
| Additional AppKit smoke test against a disposable local fixture server | Native app displayed its fixture session |
| NSH native macOS packaging | Built an ad-hoc signed `.app`; strict, deep `codesign` verification passed |
| NSH web packaging | Built successfully; this does **not** mean it works in a browser |
| Terminal CLI build | Built successfully |

The fixture model is deterministic, not an LLM. Its macOS fixture host is unsandboxed: approving its shell commands
can run them as the local user. No production session, repository change or model invocation was needed.
The full repository test suite was not tested.

## Native GitHub OAuth: not passing end-to-end

The live `https://pikibun.com/api/health` endpoint reported GitHub OAuth configured. Its native sign-in endpoint
redirected to GitHub's authorization flow with the callback `https://pikibun.com/api/auth/github/callback`.

The first native attempt displayed a blank GitHub sign-in sheet. Minimal WebView probes could subsequently render
inline HTML, an HTTPS page and GitHub's login form, both inside and outside a dialog. Repeating the original app
without source changes also rendered GitHub's login form. The first blank view's cause was not established; successful
retries are not a confirmed fix for it.

The later interactive attempt reached the custom-scheme callback, but NSH emitted warnings of this form:

```text
web view navigation to pikibun://auth?[redacted] is not granted
```

The authenticated session list was never observed, and the test ended when the host exited. Reaching GitHub or
receiving a redirect therefore must not be reported as a successful native sign-in. This is consistent with the PR's
known, unverified custom-scheme callback handling. The runtime warning can contain an OAuth code and state, so raw
logs must not be published. The reusable smoke runner redacts URL queries before forwarding runtime output.

The flow uses an embedded web view, not a system authentication session, and requests the server's OAuth scopes,
including `repo` and `workflow`. Users must complete and approve it themselves. Tokens still use NSH's plain storage,
not the Keychain. These prototype limitations remain unchanged.

## NSH web: builds, but does not work in Chrome

The production web package served at `/nsh/` failed to start in real Chrome:

- The response's Content-Security-Policy blocks NSH 0.4's dynamically inserted inline import map.
- The page then reports `Failed to resolve module specifier "nsh"`.
- The runtime also creates blob modules, which the PR's `script-src` does not allow.

A diagnostic, loopback-only reverse proxy that relaxed `script-src` got past the import-map failure. It still left
the app on `Loading...`, although `/api/health` and `/api/me` both returned HTTP 200. This was not a production fix;
neither the original CSP nor the application source was changed for the final tested revision.

All 12 existing app tests also failed with empty view trees under `nsh test --target web`. Those tests were written
for the native/developer-token path; their failure alone does not identify a web application regression.

## Reproduce the native smoke tests

Install the repository dependencies (scripts/nsh.mjs fetches the pinned NSH), then run from the repository root:

```sh
pnpm test:client-macos
pnpm test:client-macos --live --display 1
# For another server or a shorter interactive wait:
pnpm test:client-macos --live --server https://your-server.example --timeout-ms 120000
```

The default run uses stubbed API fixtures and requires no account. It creates `apps/nsh/.nsh/screenshots` and writes
only fixture screenshots there. This fixes the earlier workflow's missing output directory and screenshot path outside
the app's ignored `.nsh` directory. When invoking the screenshot tests directly from `apps/nsh`, create
`.nsh/screenshots` first.

The opt-in live test opens the actual app on AppKit with a live network and isolated storage, for you to sign in with
a code made on the web. It records no live screenshots and supplies no credentials. It waits for the authenticated
session list. Its isolated app closes when the test ends. `NSH_BIN` overrides
the pinned `nsh`; `--help` lists the runner's options.

No credentials, raw authentication logs, screenshots, SDK binaries, local proxy or machine-specific launchers are
included in this report or the reusable tests.
