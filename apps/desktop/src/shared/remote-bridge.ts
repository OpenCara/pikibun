import type { AvailableUpdate } from "../main/updates.js";
import type { HostsView, LocalSharedSettings, LocalView, ModelChoice, Outcome } from "./bridge.js";

// What the desktop app offers the web app it shows, as `window.pikibunDesktop`: the app's settings, inside the server's
// own Settings page (Settings › This Mac). The main process honors calls only from the main frame of its Pikibun
// windows while they show a server the owner chose (a connection, or Pikibun on this computer); calls that change which
// servers this computer serves or runs ask the owner in a native dialog first. Secrets (GitHub OAuth apps' secrets,
// administrators' passwords) are never entered here: the app's own Settings window takes them. Types only, so the web
// app's bundle imports nothing from the desktop app.

export type { AvailableUpdate, HostsView, LocalSharedSettings, LocalView, ModelChoice, Outcome };

export const remoteChannels = {
  view: "desktop:view",
  update: "desktop:update",
  hostRefresh: "desktop:host-refresh",
  hostStart: "desktop:host-start",
  hostStop: "desktop:host-stop",
  hostPairHere: "desktop:host-pair-here",
  hostAdd: "desktop:host-add",
  hostRemove: "desktop:host-remove",
  hostOpen: "desktop:host-open",
  hostModels: "desktop:host-models",
  openAtLogin: "desktop:open-at-login",
  server: "desktop:server",
  localStart: "desktop:local-start",
  localStop: "desktop:local-stop",
  openWindow: "desktop:open-window",
  upload: "desktop:upload",
  openUpdate: "desktop:open-update",
} as const;

/**
 * A chunk the page handed a host on this computer: the runner's reply, as the relay would have carried it; or why it
 * couldn't, with `local` false when the host isn't this computer's (the page then sends the file through its server).
 */
export type UploadOutcome = { ok: true; status: number; body: string } | { ok: false; error: string; local: boolean };

export interface DesktopView {
  /** "This Mac" on macOS, "This Computer" elsewhere. */
  title: string;
  /** The server this page belongs to. */
  origin: string;
  /** The connection whose server is this page's, if any: "Pair this computer" pairs it. */
  connectionHere?: string;
  primaryServer: string;
  defaultServer: string;
  /** Each connection's host; activity logs only for this page's own server's. */
  hosts: HostsView;
  /** Pikibun on this computer; its activity log only on its own pages. */
  local: LocalView;
  /** The app's version; absent from apps older than update checks. */
  version?: string;
  /** A newer desktop release on GitHub, once a check has found one. */
  update?: AvailableUpdate;
}

/** Starting Pikibun on this computer from the web page: with the saved GitHub OAuth apps only. */
export type RemoteLocalStartInput = { mode: "local" } | { mode: "shared"; shared: LocalSharedSettings };

export interface DesktopBridge {
  version: 1;
  view(): Promise<DesktopView>;
  onUpdate(listener: (view: DesktopView) => void): () => void;
  host: {
    refresh(id: string): Promise<void>;
    /** Starts a paired host; pairing goes through pairHere. */
    start(id: string): Promise<Outcome>;
    stop(id: string): Promise<Outcome>;
    /**
     * Pairs this computer with this page's server using a pairing the page just created for its signed-in user, and
     * starts it: the server is added to the list first (asking the owner) when it isn't there yet.
     */
    pairHere(pairing: { id: string; code: string }, replacePairing: boolean): Promise<Outcome>;
    add(server: string): Promise<Outcome>;
    remove(id: string): Promise<Outcome>;
    open(id: string): Promise<Outcome>;
    setModels(id: string, models: ModelChoice[] | null): Promise<Outcome>;
  };
  setOpenAtLogin(enabled: boolean): Promise<Outcome>;
  /** The primary server: what the main Pikibun window opens. */
  setServer(origin: string): Promise<Outcome>;
  local: {
    start(input: RemoteLocalStartInput): Promise<Outcome>;
    stop(): Promise<Outcome>;
  };
  /** The app's own windows: This Mac, or Settings (where secrets are entered). */
  openWindow(which: "host" | "settings"): Promise<Outcome>;
  /**
   * Hands this computer's host `connectorId` one chunk of a file attached to a message, with the grant this page's
   * server made for it (`POST /api/sessions/:id/uploads/direct`), so the file's bytes stay on this computer. Absent
   * from apps that predate it.
   */
  upload?(input: { connectorId: string; grant: string; body: string }): Promise<UploadOutcome>;
  /** Opens the newer release's page (DesktopView.update) in the browser. Absent from apps older than update checks. */
  openUpdate?(): Promise<Outcome>;
}
