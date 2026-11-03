// What a host's window in the desktop app and a server's Settings page list of its prerequisites (the connector's
// HostInspection). Generic over the entries, so it needs nothing of the connector: the web app, the desktop app's
// renderer and tests share it at runtime.

export interface ListedPrerequisite<T> {
  entry: T;
  /** Needed only by the sandbox the host would run in once ready (it runs unsandboxed until then). */
  sandbox: boolean;
}

/**
 * The prerequisites of how the host runs now, then what its sandbox still lacks: a host that runs unsandboxed because
 * its sandbox isn't ready lists only the unsandboxed mode's, and the sandbox's (with their fixes) would stay hidden.
 */
export function listedPrerequisites<T extends { name: string; ok: boolean }>(
  inspection: { prerequisites: readonly T[]; sandboxPrerequisites?: readonly T[] } | undefined,
): ListedPrerequisite<T>[] {
  const required = inspection?.prerequisites ?? [];
  const forSandbox = (inspection?.sandboxPrerequisites ?? []).filter(entry => !entry.ok && !required.some(other => other.name === entry.name));
  return [...required.map(entry => ({ entry, sandbox: false })), ...forSandbox.map(entry => ({ entry, sandbox: true }))];
}
