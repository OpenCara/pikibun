export type LineOperation = '=' | '-' | '+';

const contextLines = 3;
const maxEdits = 2000;
export const maxPatchLines = 20_000;

interface Lines { text: string[]; keys: string[]; endsWithNewline: boolean }

function lines(content: string): Lines {
  if (!content) return { text: [], keys: [], endsWithNewline: true };
  const text = content.split('\n');
  const endsWithNewline = text.at(-1) === '';
  if (endsWithNewline) text.pop();
  const keys = text.map((line, index) => !endsWithNewline && index === text.length - 1 ? `${line}\0` : line);
  return { text, keys, endsWithNewline };
}

function myers(a: readonly string[], b: readonly string[]): LineOperation[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxEdits, n + m);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], edits: number, n: number, m: number): LineOperation[] {
  const operations: LineOperation[] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const previous = trace[d]!;
    const at = (k: number) => previous[k + d + 1]!;
    const k = x - y;
    const fromK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const fromX = at(fromK);
    const fromY = fromX - fromK;
    while (x > fromX && y > fromY) { operations.push('='); x--; y--; }
    if (x === fromX) { operations.push('+'); y--; } else { operations.push('-'); x--; }
  }
  while (x > 0 && y > 0) { operations.push('='); x--; y--; }
  return operations.reverse();
}

export function lineOperations(a: readonly string[], b: readonly string[]): LineOperation[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const middleA = a.slice(start, a.length - end);
  const middleB = b.slice(start, b.length - end);
  const middle = myers(middleA, middleB)
    ?? [...middleA.map((): LineOperation => '-'), ...middleB.map((): LineOperation => '+')];
  return [...Array<LineOperation>(start).fill('='), ...middle, ...Array<LineOperation>(end).fill('=')];
}

function range(start: number, count: number): string {
  const first = count === 0 ? start - 1 : start;
  return count === 1 ? `${first}` : `${first},${count}`;
}

export interface UnifiedPatch { patch: string; additions: number; deletions: number; truncated?: true }

export function unifiedPatch(before: string, after: string, lineLimit: number = maxPatchLines): UnifiedPatch {
  const old = lines(before);
  const now = lines(after);
  const operations = lineOperations(old.keys, now.keys);
  const entries: { operation: LineOperation; oldIndex: number; newIndex: number }[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let additions = 0;
  let deletions = 0;
  for (const operation of operations) {
    entries.push({ operation, oldIndex, newIndex });
    if (operation !== '+') oldIndex++;
    if (operation !== '-') newIndex++;
    if (operation === '+') additions++;
    if (operation === '-') deletions++;
  }
  const cut: UnifiedPatch = { patch: '', additions, deletions, truncated: true };
  if (additions + deletions > lineLimit) return cut;
  const changed: number[] = [];
  for (let index = 0; index < entries.length; index++) if (entries[index]!.operation !== '=') changed.push(index);
  const hunks: string[] = [];
  let at = 0;
  while (at < changed.length) {
    let last = at;
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= 2 * contextLines + 1) last++;
    const from = Math.max(0, changed[at]! - contextLines);
    const to = Math.min(entries.length - 1, changed[last]! + contextLines);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let index = from; index <= to; index++) {
      const entry = entries[index]!;
      if (entry.operation === '+') {
        newCount++;
        body.push(`+${now.text[entry.newIndex]}`);
        if (!now.endsWithNewline && entry.newIndex === now.text.length - 1) body.push('\\ No newline at end of file');
      } else {
        oldCount++;
        if (entry.operation === '=') newCount++;
        body.push(`${entry.operation === '=' ? ' ' : '-'}${old.text[entry.oldIndex]}`);
        if (!old.endsWithNewline && entry.oldIndex === old.text.length - 1) body.push('\\ No newline at end of file');
      }
    }
    const first = entries[from]!;
    if (hunks.length + 1 + body.length > lineLimit) return cut;
    hunks.push(`@@ -${range(first.oldIndex + 1, oldCount)} +${range(first.newIndex + 1, newCount)} @@`);
    for (const line of body) hunks.push(line);
    at = last + 1;
  }
  return { patch: hunks.join('\n'), additions, deletions };
}
