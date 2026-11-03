import type { HostInspection, Prerequisite } from "../../../runner/src/desktop-protocol.js";

// What a host's window and a server's Settings page list of its prerequisites. Pure, with no Electron or DOM, so the
// app's renderer, the web app and tests share it.

export interface ListedPrerequisite {
  entry: Prerequisite;
  /** Needed only by the sandbox the host would run in once ready (it runs unsandboxed until then). */
  sandbox: boolean;
}

/**
 * The prerequisites of how the host runs now, then what its sandbox still lacks: a host that runs unsandboxed because
 * its sandbox isn't ready lists only the unsandboxed mode's, and the sandbox's (with their fixes) would stay hidden.
 */
export function listedPrerequisites(inspection: HostInspection | undefined): ListedPrerequisite[] {
  const required = inspection?.prerequisites ?? [];
  const forSandbox = (inspection?.sandboxPrerequisites ?? []).filter(entry => !entry.ok && !required.some(other => other.name === entry.name));
  return [...required.map(entry => ({ entry, sandbox: false })), ...forSandbox.map(entry => ({ entry, sandbox: true }))];
}
