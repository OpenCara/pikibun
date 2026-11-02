import { contextBridge, ipcRenderer } from "electron";
import { channels, type HostsView, type PikibunBridge, type SettingsView } from "../shared/bridge.js";

// Loaded only into the app's local pages. Each function forwards one typed call; the main process checks the sender
// and validates every payload, so nothing here is trusted.

const bridge: PikibunBridge = {
  host: {
    view: () => ipcRenderer.invoke(channels.hostView),
    refresh: id => ipcRenderer.invoke(channels.hostRefresh, { id }),
    start: (id, input) => ipcRenderer.invoke(channels.hostStart, { id, input }),
    stop: id => ipcRenderer.invoke(channels.hostStop, { id }),
    add: server => ipcRenderer.invoke(channels.hostAdd, server),
    remove: id => ipcRenderer.invoke(channels.hostRemove, { id }),
    open: id => ipcRenderer.invoke(channels.hostOpen, { id }),
    setModels: (id, models) => ipcRenderer.invoke(channels.hostModels, { id, models }),
    setOpenAtLogin: enabled => ipcRenderer.invoke(channels.hostOpenAtLogin, enabled),
    onUpdate: listener => {
      const forward = (_event: unknown, view: HostsView) => listener(view);
      ipcRenderer.on(channels.hostUpdate, forward);
      return () => { ipcRenderer.off(channels.hostUpdate, forward); };
    },
  },
  settings: {
    view: () => ipcRenderer.invoke(channels.settingsView),
    setServer: origin => ipcRenderer.invoke(channels.settingsServer, origin),
    startLocal: input => ipcRenderer.invoke(channels.localStart, input),
    stopLocal: () => ipcRenderer.invoke(channels.localStop),
    createAdmin: input => ipcRenderer.invoke(channels.localCreateAdmin, input),
    openLocal: () => ipcRenderer.invoke(channels.localOpen),
    onUpdate: listener => {
      const forward = (_event: unknown, view: SettingsView) => listener(view);
      ipcRenderer.on(channels.settingsUpdate, forward);
      return () => { ipcRenderer.off(channels.settingsUpdate, forward); };
    },
  },
};

contextBridge.exposeInMainWorld("pikibun", bridge);
