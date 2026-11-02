import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, dialog, ipcMain, net, shell, type IpcMainInvokeEvent } from "electron";
import { channels, type HostsView, type LocalStartInput, type Outcome, type SettingsView } from "../shared/bridge.js";
import { remoteChannels, type DesktopView, type UploadOutcome } from "../shared/remote-bridge.js";
import { githubLookup, resolveAdmins } from "./admins.js";
import { connectCommand } from "./connect-command.js";
import { HostController } from "./host-controller.js";
import { HostLaunchError, HostProcess, stdioHost } from "./host-process.js";
import { LocalServerController } from "./local-server.js";
import { HostTray, installAppMenu, type MenuActions } from "./menu.js";
import { DEFAULT_SERVER, parseServerOrigin } from "./origin.js";
import { isLocalPage, parseBoolean, parseConnectionCall, parseCreateAdmin, parseLocalStartInput, parseModels, parsePairHere, parseRemoteLocalStart, parseSandbox, parseStartInput, parseString, parseUpload } from "./requests.js";
import { remoteView } from "./remote-view.js";
import { PRIMARY_CONNECTION, SettingsStore, type SandboxChoice } from "./settings.js";
import { UpdateChecker } from "./updates.js";
import { utilityHost } from "./utility-host.js";
import { createLocalWindow, createRemoteWindow, hardenRemoteSession, registerLocalScheme, serveLocalPages } from "./windows.js";
import { chooseDistro, wslExe, wslHostArgs, wslStateDir, wslStatus } from "./wsl.js";
import type { WslStatus } from "../shared/bridge.js";

const mac = process.platform === "darwin";
/** Windows hosts choose their sandbox: WSL2 (the default) or native Windows. */
const windowsHost = process.platform === "win32";
const hostTitle = mac ? "This Mac" : "This Computer";
// Development switches, honored only when the app runs unpackaged: a separate userData and connector state (so a
// developer's real pairing is untouched) and fixture models instead of Pi's.
const development = !app.isPackaged;
const developmentEnv = (name: string) => development ? process.env[name] || undefined : undefined;
const fixtureModels = developmentEnv("PIKIBUN_DESKTOP_ALLOW_FAUX") === "1";
const stateDir = developmentEnv("PIKIBUN_DESKTOP_STATE_DIR");
const serverStateDir = developmentEnv("PIKIBUN_DESKTOP_SERVER_STATE_DIR");
const userData = developmentEnv("PIKIBUN_DESKTOP_USER_DATA");
/** Packaged apps look for newer releases on GitHub; an unpackaged one only with this switch (or from the menu). */
const checkUpdates = !development || developmentEnv("PIKIBUN_DESKTOP_CHECK_UPDATES") === "1";
/** Writes PNGs of the windows into this directory, then quits: launch verification for any build. */
const smokeDirectory = process.env.PIKIBUN_DESKTOP_SMOKE || undefined;

/**
 * Each connection's connector state: the primary one is the CLI's own (`pikibun connect` with no --state-dir), so a
 * computer paired from a terminal is adopted as is; every other one has a directory of its own beside it, which
 * `pikibun connect --state-dir` can use as well.
 */
const connectionsDirectory = stateDir ? join(dirname(stateDir), "connections") : join(homedir(), ".local", "share", "pikibun", "connections");
const connectorStateDir = (id: string): string | undefined => id === PRIMARY_CONNECTION ? stateDir : join(connectionsDirectory, id);
/** A connection's sandbox on Windows, WSL2 unless the owner chose native Windows; undefined elsewhere. */
const sandboxOf = (choice: SandboxChoice | undefined): SandboxChoice | undefined => windowsHost ? choice ?? { sandbox: "wsl2" } : undefined;
const connectCommandFor = (id: string, server: string, sandbox: SandboxChoice | undefined) => connectCommand({
  server, sandbox, stateDir: connectorStateDir(id), wslStateDir: wslStateDir(id, id === PRIMARY_CONNECTION), home: homedir(), windows: windowsHost,
});
const hostLabel = (origin: string) => URL.parse(origin)?.host ?? origin;

app.setName("Pikibun");
if (userData) app.setPath("userData", userData);
registerLocalScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(main);
}

interface Host { controller: HostController; process: HostProcess }

function main(): void {
  const appRoot = app.getAppPath();
  const assets = join(appRoot, "assets");
  const icon = mac ? undefined : join(assets, "icon.png");
  const preload = join(__dirname, "preload.js");
  const remotePreload = join(__dirname, "remote-preload.js");
  const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
  serveLocalPages(join(__dirname, "renderer"));

  let mainWindow: BrowserWindow | undefined;
  let hostWindow: BrowserWindow | undefined;
  let settingsWindow: BrowserWindow | undefined;
  /** Pikibun windows besides the main one, each kept on its server. */
  const serverWindows = new Map<BrowserWindow, string>();

  const loginItemSupported = process.platform === "darwin" || process.platform === "win32";
  const confirm = async (parent: BrowserWindow | undefined, options: Electron.MessageBoxOptions) => {
    const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === 1;
  };

  // Packaged: the connector staged into Resources with its production dependencies. Unpackaged: the app's own build of
  // the host, whose dependencies resolve from the workspace's node_modules.
  const hostEntry = app.isPackaged
    ? join(process.resourcesPath, "connector", "dist", "desktop-host.mjs")
    : join(appRoot, "dist", "host", "desktop-host.mjs");
  // WSL2 hosts copy the staged connector into WSL2 (wsl-host.sh): the packaged one, or, unpackaged, what
  // scripts/stage-connector.mjs staged, since the workspace's node_modules are Windows links WSL2 can't follow.
  const wslConnector = app.isPackaged ? join(process.resourcesPath, "connector") : join(appRoot, "dist", "connector");
  /** Names the connector's copy inside WSL2: a release's version, or a development build's own stamp. */
  const wslBuild = () => app.isPackaged ? app.getVersion() : `${app.getVersion()}-dev.${Math.floor(statSync(join(wslConnector, "dist", "desktop-host.mjs")).mtimeMs)}`;
  // Native Windows hosts share one MXC SDK install, beside the primary connection's state, unless the owner set one.
  const nativeEnv: NodeJS.ProcessEnv | undefined = windowsHost
    ? { ...process.env, PIKIBUN_MXC_RUNTIME: process.env.PIKIBUN_MXC_RUNTIME || join(stateDir ?? join(homedir(), ".local", "share", "pikibun", "connector"), "mxc") }
    : undefined;
  /** WSL's distributions, as last listed: shown on Windows, refreshed whenever a WSL2 host launches or the owner looks. */
  let wsl: WslStatus | undefined;
  const refreshWsl = async () => {
    wsl = await wslStatus();
    publish();
    return wsl;
  };
  // Pikibun on this computer: the local server, staged beside the connector host (it shares its dependencies).
  const serverEntry = app.isPackaged
    ? join(process.resourcesPath, "connector", "dist", "desktop-server.mjs")
    : join(appRoot, "dist", "host", "desktop-server.mjs");
  const localServer = new LocalServerController({
    entry: serverEntry, args: serverStateDir ? ["--state-dir", serverStateDir] : [], settings, testMode: fixtureModels,
    confirmUnsandboxed: warning => confirm(settingsWindow, {
      type: "warning", buttons: ["Cancel", "Run Unsandboxed"], defaultId: 0, cancelId: 0, noLink: true,
      title: "Run sessions without a sandbox?",
      message: mac ? "This Mac has no isolated sandbox. Run your sessions directly on it?" : "This computer has no isolated sandbox. Run your sessions directly on it?",
      detail: `${warning.trim()}\n\nWithout your consent, Pikibun still runs here, and you can pair another machine to run sessions.`,
    }),
  });
  // Pikibun on this computer while it runs, else the primary server: what the main Pikibun window shows.
  const activeServer = () => localServer.origin ?? settings.server;
  const knownServers = () => new Set([activeServer(), ...settings.get().connections.map(connection => connection.server), ...serverWindows.values()]);
  hardenRemoteSession(origin => knownServers().has(origin));
  /** Windows name their server once there is more than one to tell apart. */
  const label = (server: () => string) => () => knownServers().size > 1 ? hostLabel(server()) : undefined;

  // This computer as a host of each server it connects to: one connector process per connection.
  const hosts = new Map<string, Host>();
  let publish = () => {};
  const createHost = (id: string): Host => {
    const directory = connectorStateDir(id);
    const sandbox = () => sandboxOf(settings.connection(id)?.windows);
    const controller = new HostController({
      id, settings, fixtureModels, command: server => connectCommandFor(id, server, sandbox()),
      ...(windowsHost ? { sandbox } : {}),
      confirmUnsandboxed: (warning, server, missing) => confirm(hostWindow, {
        type: "warning", buttons: ["Cancel", "Run Unsandboxed"], defaultId: 0, cancelId: 0, noLink: true,
        title: "Run without a sandbox?",
        message: missing.length
          ? `${mac ? "This Mac" : "This computer"}'s sandbox isn't ready. Run ${hostLabel(server)}'s agent work directly on it?`
          : `${mac ? "This Mac" : "This computer"} has no isolated sandbox. Run ${hostLabel(server)}'s agent work directly on it?`,
        detail: `${missing.length ? `The sandbox needs: ${missing.join("; ")}.\n\n` : ""}${warning.trim()}`,
      }),
    });
    /** A utility process here, or, for a Windows host in WSL2, the host inside the chosen distribution. */
    const launch = async () => {
      const choice = sandbox();
      if (choice?.sandbox !== "wsl2") return utilityHost(hostEntry, directory ? ["--state-dir", directory] : [], nativeEnv);
      const distro = chooseDistro(await refreshWsl(), choice.distro);
      if (!distro.ok) throw new HostLaunchError(distro.error);
      if (!existsSync(join(wslConnector, "dist", "desktop-host.mjs")) || !existsSync(join(wslConnector, "node_modules"))) {
        throw new HostLaunchError(app.isPackaged ? "Pikibun's connector is missing from this installation: reinstall Pikibun." : "WSL2 hosts run the staged connector: run `pnpm build`, then `node scripts/stage-connector.mjs` in apps/desktop.");
      }
      const stateDirectory = wslStateDir(id, id === PRIMARY_CONNECTION);
      return stdioHost(wslExe(), wslHostArgs({ distro: distro.name, connector: wslConnector, build: wslBuild(), ...(stateDirectory ? { stateDir: stateDirectory } : {}) }));
    };
    const process = new HostProcess({
      launch,
      onEvent: event => {
        if (event.type === "status") controller.handleStatus(event.state, event);
        else if (event.type === "log") controller.log(event.level, event.message);
        else controller.handleFailure(event.error.message);
      },
      onOutput: line => controller.log("warning", line),
      onExit: (code, expected) => controller.handleExit(code, expected),
    });
    controller.attach(process);
    controller.onChange(() => publish());
    const host = { controller, process };
    hosts.set(id, host);
    return host;
  };
  for (const connection of settings.get().connections) createHost(connection.id);
  const primaryHost = () => hosts.get(PRIMARY_CONNECTION)!.controller;

  const showWindow = (window: BrowserWindow) => {
    if (mac) void app.dock?.show();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  /** Another Pikibun window on `server`: at `url` (a session, say), else the server's start page. */
  const newServerWindow = (server: string, url?: string) => {
    if (mac) void app.dock?.show();
    const window = createRemoteWindow({ icon, preload: remotePreload, server: () => server, start: url ?? server, label: label(() => server), openWindow: next => newServerWindow(server, next) });
    serverWindows.set(window, server);
    window.on("closed", () => { serverWindows.delete(window); });
    return window;
  };
  const openMain = () => {
    if (mainWindow && !mainWindow.isDestroyed()) { showWindow(mainWindow); return; }
    if (mac) void app.dock?.show();
    mainWindow = createRemoteWindow({
      settings, icon, preload: remotePreload, server: activeServer, start: localServer.claimUrl ?? activeServer(), label: label(activeServer),
      openWindow: url => newServerWindow(activeServer(), url),
    });
    mainWindow.on("closed", () => { mainWindow = undefined; });
  };
  /** A server's window: the main one for the server it shows, else the first one open on it, else a new one. */
  const openServer = (server: string) => {
    if (server === activeServer()) { openMain(); return; }
    const open = [...serverWindows].find(([window, origin]) => origin === server && !window.isDestroyed());
    if (open) showWindow(open[0]); else newServerWindow(server);
  };
  const newWindow = () => {
    const focused = BrowserWindow.getFocusedWindow();
    const server = focused ? serverWindows.get(focused) : undefined;
    newServerWindow(server ?? activeServer());
  };
  const openHost = () => {
    if (hostWindow && !hostWindow.isDestroyed()) { showWindow(hostWindow); return; }
    if (mac) void app.dock?.show();
    hostWindow = createLocalWindow("host.html", { title: hostTitle, width: 720, height: 860, preload, icon });
    hostWindow.on("closed", () => { hostWindow = undefined; });
    if (windowsHost) void refreshWsl();
    for (const { controller } of hosts.values()) void controller.refresh();
  };
  const openSettings = () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) { showWindow(settingsWindow); return; }
    if (mac) void app.dock?.show();
    settingsWindow = createLocalWindow("settings.html", { title: "Settings", width: 620, height: 820, preload, icon });
    settingsWindow.on("closed", () => { settingsWindow = undefined; });
    void localServer.inspect();
  };
  /** Settings › This Mac in the main window's own Settings page; the app's Settings window while it shows no server. */
  const openDesktopSettings = () => {
    openMain();
    const window = mainWindow;
    const shown = window && URL.parse(window.webContents.getURL())?.origin;
    if (!window || shown !== activeServer()) { openSettings(); return; }
    void window.loadURL(`${activeServer()}/#/settings/desktop`).catch(() => {});
  };
  // Newer desktop releases on GitHub: offered in the menus, the tray and the web app's sidebar; updating opens the
  // release page in the browser.
  const updates = new UpdateChecker({ current: app.getVersion(), fetch: (url, init) => net.fetch(url, init), onChange: () => publish() });
  const openUpdate = (): Outcome => {
    const update = updates.available;
    if (!update) return { ok: false, error: "No newer version of Pikibun is known." };
    void shell.openExternal(update.url);
    return { ok: true };
  };
  const checkForUpdates = async () => {
    const reached = await updates.check();
    const parent = BrowserWindow.getFocusedWindow() ?? undefined;
    const update = updates.available;
    if (reached && update) {
      if (await confirm(parent, { type: "info", buttons: ["Later", "Download"], defaultId: 1, cancelId: 0, noLink: true, title: "Pikibun",
        message: `Pikibun ${update.version} is available.`, detail: `You have ${app.getVersion()}. Download it from its GitHub release page, then ${mac ? "replace Pikibun in your Applications folder" : "install it over this one"}.` })) openUpdate();
      return;
    }
    const options: Electron.MessageBoxOptions = reached
      ? { type: "info", title: "Pikibun", message: "Pikibun is up to date.", detail: `${app.getVersion()} is the newest version.` }
      : { type: "warning", title: "Pikibun", message: "Couldn't check for updates.", detail: "GitHub didn't answer. Try again later." };
    if (parent) await dialog.showMessageBox(parent, options); else await dialog.showMessageBox(options);
  };
  const actions: MenuActions = {
    hostTitle, openMain, newWindow, openHost, openSettings, openDesktopSettings,
    update: () => updates.available, openUpdate: () => { openUpdate(); }, checkForUpdates: () => void checkForUpdates(),
    servers: () => [
      ...(localServer.origin ? [{ label: `${hostLabel(localServer.origin)} (${localServer.shared ? "shared from" : "on"} this computer)`, open: openMain }] : []),
      ...settings.get().connections.map(connection => ({ label: hostLabel(connection.server), open: () => openServer(connection.server) })),
    ],
    hosts: () => settings.get().connections.flatMap(connection => {
      const host = hosts.get(connection.id);
      if (!host) return [];
      const view = host.controller.view();
      return [{ server: connection.server, state: view.state, ...(view.error ? { error: view.error } : {}),
        start: () => void host.controller.start({ replacePairing: false }).then(outcome => { if (!outcome.ok) openHost(); }),
        stop: () => void host.controller.stop() }];
    }),
  };
  const tray = new HostTray(actions, assets);

  const hostsView = (): HostsView => ({
    title: hostTitle, fixtureModels, ...(wsl ? { wsl } : {}),
    connections: settings.get().connections.flatMap(connection => { const host = hosts.get(connection.id); return host ? [host.controller.view()] : []; }),
    ...(loginItemSupported ? { openAtLogin: app.getLoginItemSettings().openAtLogin } : {}),
  });
  // Menus list the servers; rebuilt only when that list changes.
  let menuKey = "";
  publish = () => {
    tray.update();
    const key = JSON.stringify([actions.servers().map(server => server.label), updates.available?.version]);
    if (key !== menuKey) { menuKey = key; installAppMenu(actions); }
    if (hostWindow && !hostWindow.isDestroyed()) hostWindow.webContents.send(channels.hostUpdate, hostsView());
    // Every Pikibun window showing one of the owner's servers keeps its Settings › This Mac current.
    for (const window of [mainWindow, ...serverWindows.keys()]) {
      if (!window || window.isDestroyed()) continue;
      const origin = URL.parse(window.webContents.getURL())?.origin;
      if (origin && knownServers().has(origin)) window.webContents.send(remoteChannels.update, desktopView(origin));
    }
  };
  const desktopView = (origin: string): DesktopView => remoteView({
    title: hostTitle, origin, primaryServer: settings.server, defaultServer: DEFAULT_SERVER, hosts: hostsView(), local: localServer.view(),
    version: app.getVersion(), update: updates.available,
  });
  publish();
  if (windowsHost) void refreshWsl();

  const settingsView = (): SettingsView => ({ server: settings.server, defaultServer: DEFAULT_SERVER, local: localServer.view() });
  // The main Pikibun window follows Pikibun on this computer: there once it runs (its sign-in link while nobody has
  // claimed it), and back to the primary server once it stops.
  let shown = activeServer();
  localServer.onChange(() => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(channels.settingsUpdate, settingsView());
    publish();
    const next = activeServer();
    if (next === shown) return;
    shown = next;
    if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(localServer.claimUrl ?? next).catch(() => {});
  });

  /** Every call must come from the main frame of the named local window, still showing its bundled page. */
  const handle = <T>(channel: string, page: string, window: () => BrowserWindow | undefined, run: (payload: unknown) => T) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
      const target = window();
      const frame = event.senderFrame;
      if (!target || target.isDestroyed() || event.sender !== target.webContents || !frame || frame !== event.sender.mainFrame || !isLocalPage(frame.url, page)) {
        throw new Error("Refused: not the app's own page");
      }
      return run(payload);
    });
  };
  const host = () => hostWindow;
  const refused = { ok: false as const, error: "Invalid request." };
  const gone = { ok: false as const, error: "That server is no longer in the list." };
  /** A host-page call about one connection: `run` gets its host and the call's other fields. */
  const forConnection = <T>(extra: readonly string[], run: (target: Host, call: Record<string, unknown>) => T | Outcome) => (payload: unknown) => {
    const call = parseConnectionCall(payload, extra);
    if (!call.ok) return refused;
    const target = hosts.get(call.value.id);
    return target ? run(target, call.value) : gone;
  };
  handle(channels.hostView, "host.html", host, hostsView);
  handle(channels.hostRefresh, "host.html", host, forConnection([], async target => {
    if (windowsHost) await refreshWsl();
    await target.controller.refresh();
  }));
  handle(channels.hostStart, "host.html", host, forConnection(["input"], (target, call) => {
    const input = parseStartInput(call.input);
    return input.ok ? target.controller.start(input.value) : { ok: false, error: input.error };
  }));
  handle(channels.hostStop, "host.html", host, forConnection([], target => target.controller.stop()));
  handle(channels.hostOpen, "host.html", host, forConnection([], target => { openServer(target.controller.server); return { ok: true as const }; }));
  handle(channels.hostModels, "host.html", host, forConnection(["models"], (target, call) => {
    const models = parseModels(call.models);
    return models.ok ? target.controller.setModels(models.value) : models;
  }));
  handle(channels.hostSandbox, "host.html", host, forConnection(["choice"], (target, call) => {
    const choice = parseSandbox(call.choice);
    return choice.ok ? target.controller.setSandbox(choice.value) : choice;
  }));
  // The changes both the app's own pages and the servers' Settings pages make.
  /** Adds a server; `confirm` asks the owner first (a web page's request). */
  const addServer = async (payload: unknown, confirm?: (origin: string) => Promise<boolean>): Promise<Outcome & { id?: string }> => {
    const input = parseString(payload, 2048);
    if (!input.ok) return refused;
    const origin = parseServerOrigin(input.value);
    if (!origin.ok) return origin;
    if (settings.get().connections.some(connection => connection.server === origin.origin)) return { ok: false, error: `${origin.origin} is already in the list.` };
    if (confirm && !await confirm(origin.origin)) return { ok: false, error: "Not added." };
    const id = randomBytes(6).toString("hex");
    const added = settings.addConnection(origin.origin, id);
    if (!added.ok) return added;
    const created = createHost(id);
    void created.controller.refresh();
    publish();
    return { ok: true, id };
  };
  const removeServer = async (target: Host): Promise<Outcome> => {
    if (target.controller.id === PRIMARY_CONNECTION) return { ok: false, error: "The primary server stays: change it in Settings instead." };
    const stopped = await target.controller.stop();
    if (!stopped.ok) return stopped;
    await target.process.shutdown(10_000);
    settings.removeConnection(target.controller.id);
    hosts.delete(target.controller.id);
    publish();
    return { ok: true };
  };
  const setOpenAtLogin = (payload: unknown): Outcome => {
    const enabled = parseBoolean(payload);
    if (!enabled.ok) return refused;
    if (!loginItemSupported) return { ok: false, error: "Open at login is not available on this system." };
    app.setLoginItemSettings({ openAtLogin: enabled.value });
    publish();
    return app.getLoginItemSettings().openAtLogin === enabled.value ? { ok: true } : { ok: false, error: "The system did not accept the login item. Check System Settings › General › Login Items." };
  };
  const startLocal = async (input: LocalStartInput): Promise<Outcome> => {
    if (input.mode === "local") return localServer.start(input);
    // GitHub logins become the user IDs the server lists, before anything starts.
    const admins = await resolveAdmins(input.shared.admins, githubLookup((url, init) => net.fetch(url, init)));
    if (!admins.ok) return admins;
    return localServer.start({ mode: "shared", shared: { ...input.shared, admins: admins.admins } });
  };
  /** The primary server, checked; `confirm` asks the owner first (a web page's request). */
  const setPrimaryServer = async (payload: unknown, confirm?: (origin: string) => Promise<boolean>): Promise<Outcome> => {
    const input = parseString(payload, 2048);
    if (!input.ok) return refused;
    const origin = parseServerOrigin(input.value);
    if (!origin.ok) return origin;
    if (origin.origin === settings.server) return { ok: true };
    if (settings.get().connections.some(connection => connection.server === origin.origin)) {
      return { ok: false, error: `${origin.origin} is already one of ${hostTitle}'s servers. Remove it there first.` };
    }
    if (confirm && !await confirm(origin.origin)) return { ok: false, error: "Not changed." };
    settings.updateConnection(PRIMARY_CONNECTION, { server: origin.origin });
    shown = activeServer();
    if (mainWindow && !mainWindow.isDestroyed() && !localServer.origin) void mainWindow.loadURL(origin.origin).catch(() => {});
    void primaryHost().refresh();
    publish();
    return { ok: true };
  };

  handle(channels.hostAdd, "host.html", host, payload => addServer(payload));
  handle(channels.hostRemove, "host.html", host, forConnection([], removeServer));
  handle(channels.hostOpenAtLogin, "host.html", host, setOpenAtLogin);

  const settingsPage = () => settingsWindow;
  handle(channels.settingsView, "settings.html", settingsPage, settingsView);
  handle(channels.localStart, "settings.html", settingsPage, async (payload): Promise<Outcome> => {
    const input = parseLocalStartInput(payload);
    return input.ok ? startLocal(input.value) : { ok: false, error: input.error };
  });
  handle(channels.localStop, "settings.html", settingsPage, () => localServer.stop());
  handle(channels.localCreateAdmin, "settings.html", settingsPage, payload => {
    const input = parseCreateAdmin(payload);
    return input.ok ? localServer.createAdmin(input.value.username, input.value.password) : { ok: false, error: input.error };
  });
  handle(channels.localOpen, "settings.html", settingsPage, (): Outcome => {
    if (!localServer.origin) return { ok: false, error: "Pikibun isn't running on this computer." };
    openMain();
    return { ok: true };
  });
  handle(channels.settingsServer, "settings.html", settingsPage, payload => setPrimaryServer(payload));

  // Settings › This Mac in the servers' own web app (remote-bridge.ts). Calls are honored only from the main frame of a
  // Pikibun window while it shows one of the owner's servers; changes to which servers this computer serves or runs
  // ask the owner in a native dialog naming the page's server first. Secrets never come this way.
  const handleRemote = <T>(channel: string, run: (origin: string, window: BrowserWindow, payload: unknown) => T) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const frame = event.senderFrame;
      const origin = frame ? URL.parse(frame.url)?.origin : undefined;
      if (!window || window.isDestroyed() || (window !== mainWindow && !serverWindows.has(window)) || !frame || frame !== event.sender.mainFrame
        || !origin || !knownServers().has(origin)) {
        throw new Error("Refused: not one of Pikibun's servers");
      }
      return run(origin, window, payload);
    });
  };
  const ask = (window: BrowserWindow, origin: string, message: string, detail: string, allow: string) => confirm(window, {
    type: "question", buttons: ["Cancel", allow], defaultId: 0, cancelId: 0, noLink: true,
    title: "Pikibun", message, detail: `Asked by Settings › ${hostTitle} at ${hostLabel(origin)}. ${detail}`,
  });
  handleRemote(remoteChannels.view, origin => desktopView(origin));
  handleRemote(remoteChannels.hostRefresh, (_origin, _window, payload) => forConnection([], async target => {
    if (windowsHost) await refreshWsl();
    await target.controller.refresh();
  })(payload));
  handleRemote(remoteChannels.hostStart, (_origin, _window, payload) => forConnection([], target => target.controller.start({ replacePairing: false }))(payload));
  handleRemote(remoteChannels.hostStop, (_origin, _window, payload) => forConnection([], target => target.controller.stop())(payload));
  handleRemote(remoteChannels.hostOpen, (_origin, _window, payload) => forConnection([], target => { openServer(target.controller.server); return { ok: true as const }; })(payload));
  handleRemote(remoteChannels.hostModels, (_origin, _window, payload) => forConnection(["models"], (target, call) => {
    const models = parseModels(call.models);
    return models.ok ? target.controller.setModels(models.value) : models;
  })(payload));
  // Where a Windows host's sessions run: the page's choice, once the owner agrees in a native dialog.
  handleRemote(remoteChannels.hostSandbox, (origin, window, payload) => forConnection(["choice"], async (target, call) => {
    const choice = parseSandbox(call.choice);
    if (!choice.ok) return choice;
    const refusal = target.controller.sandboxRefusal();
    if (refusal) return { ok: false as const, error: refusal };
    const current = target.controller.view().windows;
    if (current?.sandbox === choice.value.sandbox && (choice.value.sandbox !== "wsl2" || current.distro === choice.value.distro)) return { ok: true as const };
    const where = choice.value.sandbox === "native" ? "natively on Windows" : `in WSL2${choice.value.distro ? ` (${choice.value.distro})` : ""}`;
    if (!await ask(window, origin, `Run ${hostLabel(target.controller.server)}'s sessions ${where}?`,
      choice.value.sandbox === "native"
        ? "From the host's next start, sessions run in Windows' own sandbox, which is experimental, or without one if it isn't ready, after your consent. Native Windows has its own pairing."
        : "From the host's next start, sessions run in WSL2's bubblewrap sandbox, with WSL2's Pi configuration and its own pairing.", "Change")) {
      return { ok: false as const, error: "Not changed." };
    }
    return target.controller.setSandbox(choice.value);
  })(payload));
  // A page pairs only the connection to its own server, with a pairing it just made for its signed-in user.
  handleRemote(remoteChannels.hostPairHere, async (origin, window, payload): Promise<Outcome> => {
    const input = parsePairHere(payload);
    if (!input.ok) return { ok: false, error: input.error };
    if (localServer.origin === origin) return { ok: false, error: `Pikibun on this computer pairs ${mac ? "this Mac" : "this computer"} by itself once you have signed in.` };
    let connection = settings.get().connections.find(entry => entry.server === origin);
    if (!connection) {
      const added = await addServer(origin, server => ask(window, origin, `Run sessions for ${hostLabel(server)} on ${mac ? "this Mac" : "this computer"}?`,
        `${server} is added to ${hostTitle}'s servers, and this computer becomes one of its hosts.`, "Add and Pair"));
      if (!added.ok) return added;
      connection = settings.connection(added.id!);
    }
    const target = connection && hosts.get(connection.id);
    return target ? target.controller.start(input.value) : gone;
  });
  handleRemote(remoteChannels.hostAdd, (origin, window, payload) => addServer(payload, server => ask(window, origin, `Add ${hostLabel(server)} to ${hostTitle}'s servers?`,
    `${mac ? "This Mac" : "This computer"} can then pair with ${server} and run sessions for it.`, "Add Server")));
  handleRemote(remoteChannels.hostRemove, (origin, window, payload) => forConnection([], async target => {
    if (!await ask(window, origin, `Remove ${hostLabel(target.controller.server)} from ${hostTitle}'s servers?`,
      "Its host stops, and this computer stays paired in its state directory until you remove the host in that Pikibun.", "Remove")) return { ok: false as const, error: "Not removed." };
    return removeServer(target);
  })(payload));
  handleRemote(remoteChannels.openAtLogin, (_origin, _window, payload) => setOpenAtLogin(payload));
  handleRemote(remoteChannels.server, (origin, window, payload) => setPrimaryServer(payload, server => ask(window, origin, `Open ${hostLabel(server)} in the Pikibun window?`,
    `${server} becomes the primary server: the Pikibun window opens it, and ${mac ? "this Mac" : "this computer"}'s primary host pairs with it.`, "Change Server")));
  handleRemote(remoteChannels.localStart, async (origin, window, payload): Promise<Outcome> => {
    const input = parseRemoteLocalStart(payload);
    if (!input.ok) return { ok: false, error: input.error };
    const shared = input.value.mode === "shared";
    const allowed = await ask(window, origin, shared ? `Share Pikibun from ${mac ? "this Mac" : "this computer"}?` : `Run Pikibun on ${mac ? "this Mac" : "this computer"}?`,
      shared ? `It serves others at ${input.value.mode === "shared" ? input.value.shared.origin : ""}, listening ${input.value.mode === "shared" && input.value.shared.listen === "all" ? "on every network interface" : "on this computer"}.`
        : "It runs for you alone, and the Pikibun window shows it instead of this server.", shared ? "Share" : "Run");
    return allowed ? startLocal(input.value) : { ok: false, error: "Not started." };
  });
  handleRemote(remoteChannels.localStop, async (origin, window): Promise<Outcome> => {
    if (!await ask(window, origin, `Stop Pikibun on ${mac ? "this Mac" : "this computer"}?`, localServer.shared ? "Everyone signed in to it loses it until it runs again." : "The Pikibun window goes back to the primary server.", "Stop")) {
      return { ok: false, error: "Not stopped." };
    }
    return localServer.stop();
  });
  // A file attached to a message, a chunk at a time, straight to this computer's host of the page's own server, when the
  // session runs there: the page's server granted each chunk, and the host has it check that grant before taking it.
  handleRemote(remoteChannels.upload, async (origin, _window, payload): Promise<UploadOutcome> => {
    const input = parseUpload(payload);
    if (!input.ok) return { ok: false, error: input.error, local: false };
    const target = [...hosts.values()].find(({ controller }) => controller.server === origin && controller.view().running?.connectorId === input.value.connectorId);
    if (!target) return { ok: false, error: "That session's host isn't running on this computer.", local: false };
    return target.controller.upload(input.value.connectorId, input.value.grant, input.value.body);
  });
  handleRemote(remoteChannels.openWindow, (_origin, _window, payload): Outcome => {
    if (payload === "host") openHost();
    else if (payload === "settings") openSettings();
    else return refused;
    return { ok: true };
  });
  handleRemote(remoteChannels.openUpdate, () => openUpdate());

  app.on("second-instance", openMain);
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().some(window => window.isVisible())) openMain(); });
  const anyHostRunning = () => [...hosts.values()].some(({ controller }) => controller.hostState !== "stopped");
  app.on("window-all-closed", () => {
    // A running host, or Pikibun running on this computer, keeps the app alive in the menu bar (macOS keeps it anyway).
    if (anyHostRunning() || localServer.running) { if (mac) app.dock?.hide(); return; }
    if (!mac) app.quit();
  });
  let quitting = false;
  app.on("before-quit", event => {
    const processes = [...hosts.values()].map(entry => entry.process).filter(process => process.running);
    if (quitting || (!processes.length && !localServer.running)) return;
    event.preventDefault();
    quitting = true;
    void Promise.all([...processes.map(process => process.shutdown(10_000)), localServer.shutdown(10_000)]).finally(() => app.quit());
  });

  openMain();
  if (smokeDirectory) {
    const windows = { main: () => mainWindow, host: () => { openHost(); return hostWindow; }, settings: () => { openSettings(); return settingsWindow; } };
    void smoke(smokeDirectory, windows, primaryHost());
    return;
  }
  for (const { controller } of hosts.values()) void controller.resume();
  void localServer.resume();
  if (checkUpdates) updates.start();
}

/** Captures the Pikibun, host and Settings windows once they have rendered, then quits. */
async function smoke(directory: string, windows: Record<"main" | "host" | "settings", () => BrowserWindow | undefined>, controller: HostController): Promise<void> {
  mkdirSync(directory, { recursive: true });
  const capture = async (window: BrowserWindow | undefined, name: string) => {
    if (!window) throw new Error(`${name} window did not open`);
    if (window.webContents.isLoading()) {
      const loaded = Promise.withResolvers<void>();
      window.webContents.once("did-stop-loading", () => loaded.resolve());
      await loaded.promise;
    }
    // Let late layout and web fonts settle before the capture.
    await delay(1500);
    writeFileSync(join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await capture(windows.main(), "main");
    const host = windows.host();
    const inspected = Promise.withResolvers<void>();
    const check = () => { if (controller.view().inspection && !controller.view().inspecting) inspected.resolve(); };
    const unsubscribe = controller.onChange(check);
    check();
    await inspected.promise;
    unsubscribe();
    await capture(host, "host");
    await capture(windows.settings(), "settings");
  } catch (error) {
    process.stderr.write(`Smoke capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  app.quit();
}
