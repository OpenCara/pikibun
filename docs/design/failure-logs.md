# Failure logs

Issues #171 to #174 came from one production case: after a host was rebuilt, every older sandboxed session on it showed **Unavailable**, and nothing on either side said why. The connector wrote nothing, the server wrote nothing after `listening on`, and Cloudflare replaced the server's JSON answer with its own error page. This note records what each side now logs, what it leaves out, and why.

## On the host

- `RunnerService` has a `FailureLog` (`apps/runner/src/failure-log.ts`). The runner's `onError` reports every error that isn't a `RunnerError` below 500, with the session and the action (`Session <id>: view failed: <error and stack>`). The client still gets only `Runner operation failed`, as before: stacks and host paths stay on the host, which is its owner's own machine.
- A session that fails to open or to reopen gets its own line (`Session <id> couldn't open: …`). That is where a broken host shows first: a missing namespace, files copied back without their permissions, a damaged binding. `onError` then skips the same error, so it isn't written twice.
- The same first line is written at most once a minute. A session the app keeps open asks for its view every few seconds, and would otherwise fill the terminal with one failure.
- `RelayFrames` logs a relayed request the runtime threw on, which used to become a bare 502 too.
- A sandboxed connector checks that bubblewrap can make the sandbox before it starts (see [security-rationale.md](security-rationale.md#linux-sandbox)), and `assertPrerequisites` now prints each missing prerequisite's fix, such as the `sysctl` command.

## On the server

- `failedRequests` (`apps/server/src/log.ts`) writes one line for each answer with a 5xx status: method, route template, status, error code, time, the session where the route names one, and the message the client got. It logs the route template, not the path, so that no path segment a client sent ends up in the log. Bodies, query strings, headers and cookies never do. An error the server didn't expect also gets its stack, from `c.error`.
- `connectorRequest` and the test runner write what a host answered when it failed with a 5xx, before the answer becomes `runner_error`.
- `ConnectorRelay` writes each connect, replacement, disconnect (with the WebSocket close code and reason, or the frame or protocol error) and expired request. These are rare, and they are the only record of a host that keeps dropping.
- A failed automatic backup is written with its session and the error's code and message. `automatic_backups.error` still keeps only the code.
- Lines go through `Env.LOG`, which is standard error in production and a list in tests.

## 500, not 502

An unexpected status from a host or runner used to become 502 `runner_error`. Cloudflare, the documented deployment, replaces the body of any 502 or 504 from the origin with its own HTML page. The app then saw a proxy error and no `code`, and a connector's callback couldn't decode the answer (`Invalid control-plane response`). Such failures are now 500, whose body Cloudflare passes through. The statuses a host answers on purpose (400, 403, 404, 409, 413, 422, 429, 503, 504) still pass through as they are. The 502s the server makes for answers it couldn't read from GitHub, a document source or a host's malformed reply are unchanged: they are rarer, and changing them is a separate decision.

On its side, the connector asks for JSON (`Accept: application/json`), and an answer that isn't JSON is reported with its status and content type (`Invalid control-plane response (502 text/html)`). A broker callback whose error isn't JSON fails with that status instead of a decoding error.
