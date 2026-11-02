import type { HostsView, LocalView } from "../shared/bridge.js";
import type { DesktopView } from "../shared/remote-bridge.js";

// What a server's own web page sees of the app's settings (remote-bridge.ts): every connection and Pikibun on this
// computer, as This Mac and Settings show them, but the activity logs only of its own server, since they name other
// servers' work. Pure, so tests run it without Electron.

export function remoteView(input: { title: string; origin: string; primaryServer: string; defaultServer: string; hosts: HostsView; local: LocalView }): DesktopView {
  const { origin, hosts, local } = input;
  const here = hosts.connections.find(connection => connection.server === origin);
  return {
    title: input.title, origin, primaryServer: input.primaryServer, defaultServer: input.defaultServer,
    ...(here ? { connectionHere: here.id } : {}),
    hosts: { ...hosts, connections: hosts.connections.map(connection => connection.server === origin ? connection : { ...connection, logs: [] }) },
    local: local.status.origin === origin ? local : { ...local, logs: [] },
  };
}
