import type { HostsView, LocalView } from "../shared/bridge.js";
import type { DesktopView } from "../shared/remote-bridge.js";

// What a server's own web page sees of the app's settings (remote-bridge.ts): every connection and Pikibun on this
// computer, as This Mac and Settings show them, but the activity logs (and connected host id) only of its own server, since they name other
// servers' work. Pikibun on this computer's status goes field by field, by an allowlist: its sign-in link carries the
// claim secret, and only its own pages, which can claim it anyway, may see it. Pure, so tests run it without Electron.

/** The local server's status any of the owner's servers may see. */
function publicStatus(status: LocalView["status"]): LocalView["status"] {
  return { state: status.state, host: status.host, ...(status.mode ? { mode: status.mode } : {}), ...(status.origin ? { origin: status.origin } : {}),
    ...(status.address ? { address: status.address } : {}) };
}

export function remoteView(input: { title: string; origin: string; primaryServer: string; defaultServer: string; hosts: HostsView; local: LocalView }): DesktopView {
  const { origin, hosts, local } = input;
  const here = hosts.connections.find(connection => connection.server === origin);
  return {
    title: input.title, origin, primaryServer: input.primaryServer, defaultServer: input.defaultServer,
    ...(here ? { connectionHere: here.id } : {}),
    // Another server's host id, which only that server's pages hand uploads to, is left out with its logs.
    hosts: { ...hosts, connections: hosts.connections.map(connection => connection.server === origin ? connection
      : { ...connection, logs: [], ...(connection.running ? { running: { server: connection.running.server, unsandboxed: connection.running.unsandboxed } } : {}) }) },
    local: local.status.origin === origin ? local : { ...local, status: publicStatus(local.status), logs: [] },
  };
}
