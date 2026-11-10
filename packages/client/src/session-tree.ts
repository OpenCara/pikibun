export function nestSessions<T extends { id: string; parentSessionId?: string }>(sessions: readonly T[]): { session: T; depth: number }[] {
  const present = new Set(sessions.map(session => session.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const session of sessions) {
    const parent = session.parentSessionId;
    if (parent && present.has(parent) && parent !== session.id) {
      const list = children.get(parent);
      if (list) list.push(session);
      else children.set(parent, [session]);
    } else roots.push(session);
  }
  const nested: { session: T; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (session: T, depth: number) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    nested.push({ session, depth });
    for (const child of children.get(session.id) ?? []) visit(child, Math.min(depth + 1, 3));
  };
  for (const root of roots) visit(root, 0);
  for (const session of sessions) if (!seen.has(session.id)) visit(session, 0);
  return nested;
}
