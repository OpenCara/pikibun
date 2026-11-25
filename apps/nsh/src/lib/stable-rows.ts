export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => sameValue(item, other[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

export function stableRows<T extends { key: string }>(): (next: readonly T[]) => T[] {
  let kept = new Map<string, T>();
  return next => {
    const rows = next.map(row => {
      const before = kept.get(row.key);
      return before && sameValue(before, row) ? before : row;
    });
    kept = new Map(rows.map(row => [row.key, row]));
    return rows;
  };
}
