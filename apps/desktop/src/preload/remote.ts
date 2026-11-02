import { contextBridge, ipcRenderer } from "electron";
import { remoteChannels as channels, type DesktopBridge, type DesktopView } from "../shared/remote-bridge.js";

// Loaded into Pikibun windows, which show a server's web app: `window.pikibunDesktop` lets its Settings page show and
// change the app's settings. Each function forwards one call; the main process checks the sender's window, frame and
// origin, validates every payload and asks the owner before changes that matter, so nothing here is trusted.

const bridge: DesktopBridge = {
  version: 1,
  view: () => ipcRenderer.invoke(channels.view),
  onUpdate: listener => {
    const forward = (_event: unknown, view: DesktopView) => listener(view);
    ipcRenderer.on(channels.update, forward);
    return () => { ipcRenderer.off(channels.update, forward); };
  },
  host: {
    refresh: id => ipcRenderer.invoke(channels.hostRefresh, { id }),
    start: id => ipcRenderer.invoke(channels.hostStart, { id }),
    stop: id => ipcRenderer.invoke(channels.hostStop, { id }),
    pairHere: (pairing, replacePairing) => ipcRenderer.invoke(channels.hostPairHere, { pairing, replacePairing }),
    add: server => ipcRenderer.invoke(channels.hostAdd, server),
    remove: id => ipcRenderer.invoke(channels.hostRemove, { id }),
    open: id => ipcRenderer.invoke(channels.hostOpen, { id }),
    setModels: (id, models) => ipcRenderer.invoke(channels.hostModels, { id, models }),
  },
  setOpenAtLogin: enabled => ipcRenderer.invoke(channels.openAtLogin, enabled),
  setServer: origin => ipcRenderer.invoke(channels.server, origin),
  local: {
    start: input => ipcRenderer.invoke(channels.localStart, input),
    stop: () => ipcRenderer.invoke(channels.localStop),
  },
  openWindow: which => ipcRenderer.invoke(channels.openWindow, which),
};

contextBridge.exposeInMainWorld("pikibunDesktop", bridge);
