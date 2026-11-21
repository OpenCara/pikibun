import { sessionCommandLimits } from "../../../../packages/shared/src/session-commands.js";

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const WORKTREE_OWNER = "worktree";
const RESERVED_OWNERS = new Set([WORKTREE_OWNER, "skill"]);

export function inPiOrder(paths: readonly string[]): string[] {
  return [...paths].map(path => path.replace(/\/+$/, "")).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

export function ownerOf(parts: readonly string[], at: number): string {
  return at === 1 ? parts[0]! : "";
}

export function qualifiedNames<T extends { name: string; owner: string }>(items: readonly T[], prefix = ""): Omit<T, "owner">[] {
  const found: T[] = [];
  const taken = new Set<string>();
  for (const item of items) {
    const key = `${item.owner}\n${item.name}`;
    if (!NAME.test(item.name) || taken.has(key)) continue;
    taken.add(key);
    found.push(item);
  }
  const owners = new Map<string, Set<string>>();
  for (const item of found) owners.set(item.name, (owners.get(item.name) ?? new Set()).add(item.owner));
  const named: Omit<T, "owner">[] = [];
  const names = new Set<string>();
  for (const { owner, ...rest } of found) {
    const shared = owners.get(rest.name)!.size > 1;
    const qualifier = owner || WORKTREE_OWNER;
    if (shared && (!NAME.test(qualifier) || (owner && RESERVED_OWNERS.has(owner)))) continue;
    const name = shared ? `${qualifier}:${rest.name}` : rest.name;
    if (prefix.length + name.length > sessionCommandLimits.name) continue;
    if (names.has(name) || named.length >= sessionCommandLimits.perKind) continue;
    names.add(name);
    named.push({ ...rest, name } as unknown as Omit<T, "owner">);
  }
  return named;
}
