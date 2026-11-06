# Putting a session's server online: session services and piki:tunnel

A session that builds a web app had no way to show it to people: the browser tool sees it from inside the sandbox, for
one call, and nothing else could reach it ([#203](https://github.com/OpenCara/pikibun/issues/203)). Doing it by hand
showed why: `cloudflared` can't reach Cloudflare's edge from the sandbox (port 7844, its own DNS), a sandboxed command's
processes end with it, and moving the session to the host gives up the sandbox. `piki:tunnel` turns on the `tunnel`
tool, which runs the session's server in its sandbox as a **session service** and puts it online through a Cloudflare
quick tunnel that the connector runs on the host.

## Decisions

1. **A session service.** A process a session starts in its sandbox whose lifetime is the session's, not one tool
   call's (`SessionService`, `session-service.ts`; `Sandbox.startService`). It is one sandboxed command of its own, with
   the session's mounts, network (its egress proxy) and environment, run beside the session's queue of operations rather
   than in it, so the session's other tools go on while it runs. It is stopped by whatever comes first: its tool's
   `stop` (or the panel's **Stop**), a newer start, stopping the session's work, the session closing (a restart, a
   backup, the connector stopping) or being archived, its program exiting, or the host's **service lifetime**
   (`HostConfig.serviceLifetimeSeconds`, from 5 minutes to a day, 4 hours by default), which is the command's time limit
   it runs with. The first reason stands, and is what is reported. One per session.
2. **Under the session's limits.** Its processes get a long command's per-process limits for the whole lifetime
   (`serviceLimits`). With provisioned resources (`--resources`) it runs in a resource domain of its own, with the same
   configuration as the session's commands: a command's start ends what its domain still runs, which would end the
   service, and the supervisor's lock would make each command wait for it. Without them it runs unbounded, as an
   extension's command does: its start was decided as a host command is (rule 6), which is what lets a command run
   without limits the host lacks. Like every sandboxed command it ends with the connector (`--die-with-parent`, and the
   supervisor's liveness pipe).
3. **Its output, kept.** The service's last 40 lines (each cut to 500 characters) stay in the connector's memory for the
   tool's `status`; the driver's own notices (`ready`, `error`, `exited`) are lines it marks, which the program's lines
   can't imitate. Nothing is written to the worktree.
4. **The driver.** `sandbox-python/service.py`, standard-library Python embedded like the browser's driver, starts the
   server exactly as the browser's `serve` does: one of the `node` and `python` tools' programs, checked by those tools'
   own requests before any card (`serveRequest`), without a shell, in a process group of its own, with their environment
   (the connector's own Node.js first, a virtual environment's `bin`). It waits for the port (or the program's exit, with
   its output), then listens on a Unix socket in a directory of the session's own, which the Linux sandbox mounts
   writable at `/run/pikibun-service` for the service alone, and relays each connection to the declared port on the
   sandbox's loopback: nothing else of the sandbox is reachable through it. Up to 256 connections at once; once the
   connector has sent all of a request, the server has a minute to finish its answer before both ends are shut.
5. **cloudflared in the connector, on the host.** It is the one part that must reach Cloudflare's edge (port 7844) and
   resolve its names, which the sandbox's egress never allows, and it holds the tunnel, which nothing in the sandbox
   should ([egress](egress.md#tunnels-stay-out-of-the-sandbox)). `HostTunnels.open` listens on a loopback port of the
   host's, forwards each connection to the service's socket, and runs `cloudflared tunnel --no-autoupdate --config <empty>
   --url http://127.0.0.1:<port>`: an empty configuration so neither `~/.cloudflared` nor `/etc/cloudflared` applies, a
   home of its own, and nothing of the connector's environment but `PATH` and certificate settings. The connector never
   connects by the shared directory's path, which the session can write: it could put a link to a host socket (Docker's,
   say) in the socket's place, and the connector would follow it and put that online. Once the driver says it listens,
   the connector hard-links the socket into a directory of its own beside the shared one (`pinServiceSocket`), which
   names what is there and not what a link points to, refuses anything but a socket of its own user, and connects only
   there; nothing the session does in the shared directory afterwards changes where the connector goes. The address is read
   from its output (`quickTunnelUrl`), never `https://api.trycloudflare.com`, which its errors name; it counts as
   connected once it registers a connection with the edge. Its output goes to the connector's log; a call is told only
   that it got no address and what the host needs (`NO_ADDRESS`). Its process is recorded in the connector's state while
   it runs, so a connector that died without ending it ends it as it starts again (Linux, by `/proc/<pid>/exe`).
6. **Each start is a decision.** It publishes from the host owner's network, so `start` is an `extension.tool` card of
   `piki:tunnel`'s, with the call as its arguments: decided like a host command, by the host's owner or a member granted
   host commands (`decidedAsHostCommand`), on the runner, the control plane and the apps alike, and accepted by the
   control plane only while the workspace has `piki:tunnel` on (`sessionExtensionSources`). Unlike other extension tool
   cards it never runs automatically: not under the session owner's **Auto-approve** with automatic host commands, nor
   where the workspace runs extension tools **Automatic** (`createApproval`). A **Read only** message refuses it before any
   card. `status` and `stop` ask nobody: stopping only narrows what the session exposes.
7. **Off by default.** `piki:tunnel` is the first **opt-in** session-tool extension (`optIn`): its tools are off unless
   the workspace lists it enabled (`sessionToolsOff`), so a workspace that never chose, a control plane that predates it
   and a connector that can't read the workspace's choice all leave it off. The workspace page turns it on with an
   enabled entry, and off by removing it. A host's owner refuses it on their host with `HostConfig.tunnel` **Off**.
8. **Offered only where it runs, and said why where it doesn't**, as the browser is: sessions in the Linux sandbox, on a
   connector whose cloudflared is ready (`HostTunnelSource`: found, at a path, downloaded or off, applied without a
   restart and reported with the extensions as `HostTunnelStatus`). Elsewhere the view's `extensions.unavailable` names a
   fixed reason (`tunnelUnavailableReasons`) and the agent is told in a sentence.
9. **Downloading cloudflared.** `download` takes Cloudflare's latest release on GitHub (`cloudflared-linux-amd64` or
   `-arm64`, a lone executable), only from `github.com/cloudflare/cloudflared/releases/download/`, and refuses it unless
   it matches the SHA-256 the release's notes list for it; it is written beside its place and moved there whole, under
   the connector's state (`cloudflared/<version>`), and checked once a day for a newer one, as Chromium is.
10. **Visible.** While it is online the session's view carries `tunnel` (`SessionTunnelView`: the address, who started
    it, until when, the command and port, whether it is connected), which the panel shows with a **Stop** button for
    whoever may write to the session (`POST /api/sessions/:id/tunnel/stop`, the runner's `tunnel` action). The connector
    reports each start and stop (`POST /api/connectors/self/tunnel`, `SessionTunnelReport`): the control plane records
    `session.tunnel.started` and `session.tunnel.stopped` in the audit log with the address, the person (where the host
    names one in the workspace) and the reason, and marks the session online in lists (`SessionRecord.tunnel`) until a
    stop names that address or the reported lifetime is over, so a host that died without saying so leaves no mark past
    it. Archiving a session online asks its host to stop it first, as the archiver; where that fails, the host finds the
    session archived within a minute, as it checks the starter's write access every minute (`revoked`). An archived
    session is never marked online: archiving clears its mark, and a start reported after it marks nothing.
11. **A stop wins over a start.** A stop or the session closing cancels every start asked for before it: one under way,
    one waiting for the one it replaces to go offline, and one waiting its turn behind another. Nothing goes online after
    a stop has returned.

## Where things are

| Part | Where |
|---|---|
| The tool's request, reasons, reports, status and views | `packages/shared/src/tunnel.ts`; `apps/runner/src/tunnel-command.ts` |
| Session services: lifetime, output, the driver's command | `apps/runner/src/session-service.ts`; `sandbox.ts` (`startService`); `sandbox-python/service.py` (`SERVICE_DRIVER`) |
| A session's tunnel: start, replace, stop, reports | `apps/runner/src/session/tunnel.ts`; `session.ts` (the `tunnel` tool, `tunnelAction`, `stop`, `close`) |
| cloudflared: found, at a path, downloaded; quick tunnels and forwarding | `apps/runner/src/cloudflared.ts`, `tunnel-host.ts`; `connector.ts` |
| Host configuration | `packages/shared/src/host-config.ts` (`serviceLifetimeSeconds`, `tunnel`); `apps/server/src/host-config.ts`; migrations `0053` (SQLite) and `0046` (Postgres) |
| Reports, audit, the session list's mark, Stop | `apps/server/src/session-tunnels.ts`; `sessions.ts` (archive) |
| The apps | `apps/web/src/session-panel.tsx` (`TunnelSection`), `tunnel-tag.tsx`, `settings/HostExtensions.tsx` (`TunnelSetup`), `settings/HostConfig.tsx`, `settings/WorkspaceExtensions.tsx` |
| Tests | `tests/tunnel.test.ts` (with a stand-in cloudflared, `tests/helpers/fake-cloudflared.ts`), `runner-tunnel.test.ts`, `session-tunnels.test.ts` |

## Later

- **Named tunnels**: the host's owner (or the workspace, as a secret never sent to sandboxes) stores a tunnel token and a
  hostname pattern such as `*.preview.example.com`, and each session gets `<session-slug>.preview.example.com`, a stable
  address. The token stays in the connector, as cloudflared does.
- **An access gate**: the address behind a shared secret, or Cloudflare Access for named tunnels, for previews that
  shouldn't be public.
- **The browser's `serve` as a service**, so a browser that lives across calls can test an app that does too.
- Services on the macOS and Windows sandboxes, and on sessions that run on the host.
