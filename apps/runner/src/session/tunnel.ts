import type { BrowserServe } from "../../../../packages/shared/src/browser.js";
import type { SessionTunnelReport, SessionTunnelView, TunnelStopReason } from "../../../../packages/shared/src/tunnel.js";
import { SessionService, type ServiceProcess } from "../session-service.js";
import type { QuickTunnel } from "../tunnel-host.js";
import { serveCommand } from "../tunnel-command.js";

/*
 * A session's tunnel (piki:tunnel; docs/design/tunnel.md): its server, a session service in its sandbox, and the quick
 * tunnel the connector opens to it, which start and stop together. One at a time: a new start replaces the one online.
 * Whatever stops one side stops the other, and is reported once, with its reason, for the audit log and the session list.
 */

export interface SessionTunnelOptions {
  /** Starts `serve` as the session's service (Sandbox.startService), with its output going to `onOutput`. */
  startService: (serve: BrowserServe, onOutput: (chunk: Buffer) => void, signal: AbortSignal) => Promise<ServiceProcess>;
  /** Opens the connector's quick tunnel to the service's socket (HostTunnels.open). */
  openTunnel: (signal: AbortSignal) => Promise<QuickTunnel>;
  /** The host's service lifetime now, in milliseconds (HostConfig.serviceLifetimeSeconds). */
  lifetimeMs: () => Promise<number>;
  /** Tells the control plane it started or stopped; a report that fails is the connector's log's, never the tool's. */
  report: (report: Omit<SessionTunnelReport, "sessionId">) => Promise<void>;
  /**
   * Checks that the one who started it may still write to the session: an archived session, or a starter who lost the
   * session, refuses. Asked every `recheckMs`; a refusal stops it.
   */
  recheck: (actorId: string) => Promise<void>;
  recheckMs?: number;
  /** Something the view shows changed. */
  changed?: () => void;
  now?: () => number;
}

interface Online {
  service: SessionService;
  tunnel: QuickTunnel;
  serve: BrowserServe;
  startedBy: string;
  startedAt: number;
  ended?: Promise<void>;
}

/** What `start` answers, and `status` says while online. */
export interface TunnelState {
  online: boolean;
  url?: string;
  startedBy?: string;
  startedAt?: string;
  expiresAt?: string;
  uptimeSeconds?: number;
  connected?: boolean;
  command?: string;
  port?: number;
  /** The server's last lines of output. */
  output?: string[];
  /** Why the last one stopped, while none is online. */
  stopped?: { url: string; reason: TunnelStopReason; output: string[] };
}

export class SessionTunnel {
  #online: Online | undefined;
  #last: { url: string; reason: TunnelStopReason; output: string[] } | undefined;
  /** Starts and stops one at a time, in order. */
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #starting: AbortController | undefined;
  /** How many stops there have been: a start cancels itself when one comes after it was asked for. */
  #stops = 0;

  constructor(readonly options: SessionTunnelOptions) {}

  #turn<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Starts `serve` as the session's service and puts it online, replacing the one online, if any. Answers once
   * cloudflared has its address; throws why it couldn't, with the server's last lines where it stopped.
   */
  start(serve: BrowserServe, actorId: string, signal?: AbortSignal): Promise<TunnelState> {
    // A stop or close from now on cancels this start, whether it waits its turn behind another, waits for the one it
    // replaces to go offline, or is under way.
    const stops = this.#stops;
    return this.#turn(async () => {
      if (this.#closed) throw new Error("The session is closing");
      const now = this.options.now ?? Date.now;
      const controller = new AbortController();
      this.#starting = controller;
      const stop = () => controller.abort();
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) controller.abort();
      const cancelled = () => this.#closed || controller.signal.aborted || this.#stops !== stops;
      let service: SessionService | undefined;
      try {
        if (cancelled()) throw new Error("The start was stopped. Nothing is online.");
        if (this.#online) await this.#end(this.#online, "replaced");
        // Stopped, or the session closed, while the one it replaces went offline: nothing goes online.
        if (cancelled()) throw new Error("The start was stopped. Nothing is online.");
        service = await SessionService.start({ lifetimeMs: await this.options.lifetimeMs(), now,
          start: (onOutput, stopping) => this.options.startService(serve, onOutput, AbortSignal.any([stopping, controller.signal])) });
        const stopped = service.stopped.then(() => { throw new Error("stopped"); });
        void stopped.catch(() => {});
        try { await Promise.race([service.ready, stopped, aborted(controller.signal)]); }
        catch (error) {
          const lines = service.lines();
          await service.stop(controller.signal.aborted ? "stop" : "exited");
          const why = controller.signal.aborted ? "The start was stopped" : error instanceof Error && error.message !== "stopped" ? error.message : "The server stopped before its port answered";
          throw new Error(`${why}. Nothing is online.${lines.length ? `\nThe server's last output:\n${lines.join("\n")}` : ""}`);
        }
        let tunnel: QuickTunnel;
        try { tunnel = await this.options.openTunnel(controller.signal); }
        catch (error) {
          await service.stop("failed");
          throw new Error(`${error instanceof Error ? error.message : "The tunnel didn't open"}. Nothing is online; the server was stopped.`);
        }
        if (cancelled() || !service.running) {
          await tunnel.close();
          await service.stop("stop");
          throw new Error("The start was stopped. Nothing is online.");
        }
        const online: Online = { service, tunnel, serve, startedBy: actorId, startedAt: now() };
        this.#online = online;
        this.#last = undefined;
        this.#watch(online);
        await this.options.report({ event: "started", url: tunnel.url, actorId, expiresAt: new Date(service.expiresAt).toISOString() }).catch(() => {});
        this.options.changed?.();
        return this.status();
      } catch (error) {
        if (service?.running) await service.stop("failed");
        throw error;
      } finally {
        signal?.removeEventListener("abort", stop);
        if (this.#starting === controller) this.#starting = undefined;
      }
    });
  }

  /** Whatever ends one side ends the other: the service stopping (its lifetime, its program exiting), cloudflared exiting, or its starter losing the session. */
  #watch(online: Online): void {
    void online.service.stopped.then(stop => this.#end(online, stop.reason as TunnelStopReason));
    void online.tunnel.closed.then(() => this.#end(online, "failed"));
    const timer = setInterval(() => {
      void this.options.recheck(online.startedBy).catch(() => this.#end(online, "revoked"));
    }, this.options.recheckMs ?? 60_000);
    timer.unref?.();
    void online.service.stopped.then(() => clearInterval(timer));
  }

  /** Ends `online` for `reason`, once: the first reason stands, and it is reported once. */
  #end(online: Online, reason: TunnelStopReason, actorId?: string): Promise<void> {
    online.ended ??= (async () => {
      const output = online.service.lines();
      await online.tunnel.close().catch(() => {});
      const stop = await online.service.stop(reason);
      if (this.#online === online) {
        this.#online = undefined;
        this.#last = { url: online.tunnel.url, reason: stop.reason as TunnelStopReason, output: online.service.lines().length ? online.service.lines() : output };
      }
      await this.options.report({ event: "stopped", url: online.tunnel.url, reason: stop.reason as TunnelStopReason, ...(actorId ? { actorId } : {}) }).catch(() => {});
      this.options.changed?.();
    })();
    return online.ended;
  }

  /** Stops the one online, or starting, for `reason`; whether one was. `actorId`: who stopped it, where a person did. */
  async stop(reason: TunnelStopReason, actorId?: string): Promise<{ stopped: boolean; url?: string }> {
    // A start under way stops at once, and one waiting its turn never starts.
    this.#stops++;
    this.#starting?.abort();
    const online = this.#online;
    if (!online) return { stopped: false };
    await this.#end(online, reason, actorId);
    return { stopped: true, url: online.tunnel.url };
  }

  /** Stops it for good, as the session closes: no start after this. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.stop("closed");
    await this.#queue;
  }

  /** How it stands, for `status`. */
  status(): TunnelState {
    const online = this.#online;
    const now = (this.options.now ?? Date.now)();
    if (!online) return { online: false, ...(this.#last ? { stopped: this.#last } : {}) };
    return { online: true, url: online.tunnel.url, startedBy: online.startedBy, startedAt: new Date(online.startedAt).toISOString(),
      expiresAt: new Date(online.service.expiresAt).toISOString(), uptimeSeconds: Math.max(0, Math.round((now - online.startedAt) / 1000)),
      connected: online.tunnel.connected(), command: serveCommand(online.serve), port: online.serve.port, output: online.service.lines() };
  }

  /** What the session panel shows while it is online. */
  view(): SessionTunnelView | undefined {
    const online = this.#online;
    if (!online) return undefined;
    return { url: online.tunnel.url, startedBy: online.startedBy, startedAt: new Date(online.startedAt).toISOString(),
      expiresAt: new Date(online.service.expiresAt).toISOString(), command: serveCommand(online.serve), port: online.serve.port, connected: online.tunnel.connected() };
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("stopped"));
    signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  });
}
