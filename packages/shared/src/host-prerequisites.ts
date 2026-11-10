export interface ListedPrerequisite<T> {
  entry: T;
  sandbox: boolean;
}

export function listedPrerequisites<T extends { name: string; ok: boolean }>(
  inspection: { prerequisites: readonly T[]; sandboxPrerequisites?: readonly T[] } | undefined,
): ListedPrerequisite<T>[] {
  const required = inspection?.prerequisites ?? [];
  const forSandbox = (inspection?.sandboxPrerequisites ?? []).filter(entry => !entry.ok && !required.some(other => other.name === entry.name));
  return [...required.map(entry => ({ entry, sandbox: false })), ...forSandbox.map(entry => ({ entry, sandbox: true }))];
}
