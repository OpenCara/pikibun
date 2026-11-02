import { join } from "node:path";
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { HostState } from "../../../runner/src/desktop-protocol.js";
import { stateLabels } from "../shared/bridge.js";
import type { AvailableUpdate } from "./updates.js";

/** A server the app can open: each connection's, and Pikibun on this computer while it runs. */
export interface ServerEntry { label: string; open(): void }

/** One connection's host, for the tray. */
export interface HostEntry { server: string; state: HostState; error?: string; start(): void; stop(): void }

export interface MenuActions {
  hostTitle: string;
  openMain(): void;
  /** Another window of the focused Pikibun window's server, else of the primary one. */
  newWindow(): void;
  openHost(): void;
  /** The app's own Settings window: secrets, and settings while no server shows. */
  openSettings(): void;
  /** Settings › This Mac in the server's own Settings page. */
  openDesktopSettings(): void;
  servers(): ServerEntry[];
  hosts(): HostEntry[];
  /** A newer desktop release, once a check has found one. */
  update(): AvailableUpdate | undefined;
  /** Opens its release page in the browser. */
  openUpdate(): void;
  /** Checks GitHub now and says what it found. */
  checkForUpdates(): void;
}

/** "Update to Pikibun 1.2.3…" while a newer release is out, else "Check for Updates…". */
export function updateItem(actions: Pick<MenuActions, "update" | "openUpdate" | "checkForUpdates">): MenuItemConstructorOptions {
  const update = actions.update();
  return update ? { label: `Update to ${app.name} ${update.version}…`, click: actions.openUpdate } : { label: "Check for Updates…", click: actions.checkForUpdates };
}

const host = (origin: string) => URL.parse(origin)?.host ?? origin;

/** Standard app, edit, view and window menus; macOS keeps app-level items in the app menu, others in File. */
export function installAppMenu(actions: MenuActions): void {
  const mac = process.platform === "darwin";
  const ellipsis = `${actions.hostTitle}…`;
  const appItems: MenuItemConstructorOptions[] = [
    { label: "Settings…", accelerator: "CommandOrControl+,", click: actions.openDesktopSettings },
    { label: "App Settings…", click: actions.openSettings },
    { label: ellipsis, click: actions.openHost },
  ];
  const servers = actions.servers();
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const, submenu: [
      { role: "about" as const }, updateItem(actions), { type: "separator" as const }, ...appItems, { type: "separator" as const },
      { role: "services" as const }, { type: "separator" as const },
      { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const },
    ] }] : []),
    { label: "File", submenu: [
      { label: "Open Pikibun", accelerator: "CommandOrControl+N", click: actions.openMain },
      { label: "New Window", accelerator: "CommandOrControl+Shift+N", click: actions.newWindow },
      ...(servers.length > 1 ? [{ label: "Open Server", submenu: servers.map(server => ({ label: server.label, click: server.open })) }] : []),
      ...(mac ? [] : [{ type: "separator" as const }, ...appItems, updateItem(actions)]),
      { type: "separator" }, mac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** What the tray says of every host: the one's state, or how many are online. */
export function hostSummary(hosts: readonly Pick<HostEntry, "state" | "error">[]): string {
  if (hosts.length === 1) {
    const [only] = hosts;
    return `Host: ${only!.error && only!.state === "stopped" ? "Stopped (error)" : stateLabels[only!.state]}`;
  }
  const online = hosts.filter(entry => entry.state === "connected").length;
  const failed = hosts.some(entry => entry.error && entry.state === "stopped");
  return `Hosts: ${online} of ${hosts.length} online${failed ? " (error)" : ""}`;
}

/** The menu bar (macOS) or notification-area item: host status and the few actions that need no window. */
export class HostTray {
  private readonly tray: Tray;

  constructor(private readonly actions: MenuActions, assets: string) {
    // macOS tints "Template" images for light and dark menu bars; elsewhere the full-color mark reads on any panel.
    const image = nativeImage.createFromPath(join(assets, process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
    if (process.platform === "darwin") image.setTemplateImage(true);
    this.tray = new Tray(image);
    // Windows opens a tray item's menu on right-click only; a left click should too.
    if (process.platform === "win32") this.tray.on("click", () => this.tray.popUpContextMenu());
  }

  update(): void {
    const hosts = this.actions.hosts();
    const status = hostSummary(hosts);
    const control = (entry: HostEntry, label: string): MenuItemConstructorOptions => entry.state === "stopped"
      ? { label: `Start ${label}`, click: entry.start }
      : { label: `Stop ${label}`, enabled: entry.state !== "stopping", click: entry.stop };
    const controls: MenuItemConstructorOptions[] = hosts.length === 1
      ? [control(hosts[0]!, "Host")]
      : hosts.map(entry => ({ label: `${host(entry.server)} — ${entry.error && entry.state === "stopped" ? "Stopped (error)" : stateLabels[entry.state]}`,
        submenu: [control(entry, "Host")] }));
    const servers = this.actions.servers();
    const update = this.actions.update();
    this.tray.setToolTip(`Pikibun — ${status}${update ? ` (${update.version} available)` : ""}`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: "separator" },
      { label: "Open Pikibun", click: this.actions.openMain },
      ...(servers.length > 1 ? [{ label: "Open Server", submenu: servers.map(server => ({ label: server.label, click: server.open })) }] : []),
      { label: `${this.actions.hostTitle}…`, click: this.actions.openHost },
      ...controls,
      { type: "separator" },
      ...(update ? [updateItem(this.actions)] : []),
      { label: `Quit ${app.name}`, role: "quit" },
    ]));
  }
}
