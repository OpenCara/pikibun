import type { SessionView } from "./types.js";

export type ListPatch<T> = (number | T)[];

const keyedLists = {
  entries: (item: { id: string }) => item.id,
  approvals: (item: { id: string }) => item.id,
  conversations: (item: { id: string }) => item.id,
  queue: (item: { submissionId: string }) => item.submissionId,
} as const;
type KeyedList = keyof typeof keyedLists;
const listNames = Object.keys(keyedLists) as KeyedList[];
const requiredLists: KeyedList[] = ["entries", "approvals", "conversations"];

export type ViewFields = Omit<SessionView, KeyedList>;
type ViewLists = { [K in KeyedList]?: ListPatch<NonNullable<SessionView[K]>[number]> };

export interface SessionViewPatch {
  base: string;
  revision: string;
  view?: ViewFields;
  lists?: ViewLists;
}

export const patchLimits = { items: 200_000 } as const;

const revisionPattern = /^[0-9a-f]{32}$/;

export function isRevision(value: unknown): value is string {
  return typeof value === "string" && revisionPattern.test(value);
}

export function newRevision(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

const encoded = new WeakMap<object, string>();

function json(value: unknown): string {
  if (!value || typeof value !== "object") return String(JSON.stringify(value));
  let text = encoded.get(value);
  if (text === undefined) {
    text = JSON.stringify(value);
    encoded.set(value, text);
  }
  return text;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || json(a) === json(b);
}

function split(view: SessionView): { fields: ViewFields; lists: { [K in KeyedList]?: readonly unknown[] } } {
  const { entries, approvals, conversations, queue, ...fields } = view;
  return { fields, lists: { entries, approvals, conversations, queue } };
}

export function diffList<T>(base: readonly T[], next: readonly T[], key: (item: T) => unknown): ListPatch<T> {
  const positions = new Map<unknown, number>();
  base.forEach((item, index) => {
    const name = key(item);
    if (!positions.has(name)) positions.set(name, index);
  });
  const patch: ListPatch<T> = [];
  const run = (count: number) => {
    const last = patch.at(-1);
    if (typeof last === "number" && Math.sign(last) === Math.sign(count)) patch[patch.length - 1] = last + count;
    else patch.push(count);
  };
  let at = 0;
  for (const item of next) {
    const index = positions.get(key(item));
    if (index !== undefined && index >= at && same(base[index], item)) {
      if (index > at) run(at - index);
      run(1);
      at = index + 1;
    } else patch.push(item);
  }
  return patch;
}

export function applyList<T>(base: readonly T[], patch: unknown): T[] {
  if (!Array.isArray(patch) || patch.length > patchLimits.items) throw new Error("Invalid list patch");
  const result: T[] = [];
  let at = 0;
  for (const operation of patch) {
    if (typeof operation === "number") {
      if (!Number.isSafeInteger(operation) || operation === 0 || at + Math.abs(operation) > base.length) throw new Error("Invalid list patch");
      if (operation > 0) for (const end = at + operation; at < end; at++) result.push(base[at]!);
      else at -= operation;
    } else if (operation && typeof operation === "object" && !Array.isArray(operation)) result.push(operation as T);
    else throw new Error("Invalid list patch");
    if (result.length > patchLimits.items) throw new Error("Invalid list patch");
  }
  return result;
}

export function sameView(a: SessionView, b: SessionView): boolean {
  if (a === b) return true;
  const left = split(a);
  const right = split(b);
  if (json(left.fields) !== json(right.fields)) return false;
  return listNames.every(name => {
    const x = left.lists[name];
    const y = right.lists[name];
    if (!x || !y) return x === y;
    return x.length === y.length && x.every((item, index) => same(item, y[index]));
  });
}

export function diffView(base: SessionView, next: SessionView, baseRevision: string, revision: string): SessionViewPatch {
  if (baseRevision === revision) return { base: baseRevision, revision };
  const before = split(base);
  const after = split(next);
  const lists: ViewLists = {};
  for (const name of listNames) {
    const items = after.lists[name];
    if (items) (lists as Record<string, unknown>)[name] = diffList(before.lists[name] ?? [], items, keyedLists[name] as (item: unknown) => unknown);
  }
  return { base: baseRevision, revision, view: after.fields, lists };
}

export function isViewPatch(value: unknown): value is SessionViewPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  if (!isRevision(patch.base) || !isRevision(patch.revision)) return false;
  if (patch.base === patch.revision) return patch.view === undefined && patch.lists === undefined;
  return !!patch.view && typeof patch.view === "object" && !Array.isArray(patch.view)
    && !!patch.lists && typeof patch.lists === "object" && !Array.isArray(patch.lists);
}

export function isPatchableView(value: unknown): value is SessionView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return listNames.every(name => {
    const items = view[name];
    if (items === undefined) return !requiredLists.includes(name);
    return Array.isArray(items) && items.every(item => !!item && typeof item === "object" && !Array.isArray(item));
  });
}

export function applyViewPatch(base: SessionView, patch: SessionViewPatch): SessionView {
  if (!isViewPatch(patch)) throw new Error("Invalid view patch");
  if (patch.base === patch.revision) return base;
  const lists = patch.lists as Record<string, unknown>;
  const fields = patch.view as Record<string, unknown>;
  if (listNames.some(name => Object.hasOwn(fields, name)) || Object.keys(lists).some(name => !listNames.includes(name as KeyedList))) {
    throw new Error("Invalid view patch");
  }
  const before = split(base);
  const view: Record<string, unknown> = { ...fields };
  for (const name of listNames) {
    if (lists[name] !== undefined) view[name] = applyList(before.lists[name] ?? [], lists[name]);
  }
  if (requiredLists.some(name => !Array.isArray(view[name]))) throw new Error("Invalid view patch");
  return view as unknown as SessionView;
}

export function reuseUnchanged(base: SessionView, next: SessionView): SessionView {
  return applyViewPatch(base, diffView(base, next, "0".repeat(32), "1".repeat(32)));
}

export class ViewRevisions {
  private readonly views: { revision: string; view: SessionView }[] = [];

  constructor(private readonly keep = 4) {}

  record(view: SessionView): { revision: string; view: SessionView } {
    const latest = this.views.at(-1);
    if (latest && sameView(latest.view, view)) return latest;
    const recorded = { revision: newRevision(), view: latest ? reuseUnchanged(latest.view, view) : view };
    this.views.push(recorded);
    if (this.views.length > this.keep) this.views.shift();
    return recorded;
  }

  since(since: string | undefined, current: { revision: string; view: SessionView }): SessionViewPatch | null {
    if (since === current.revision) return { base: since, revision: since };
    const base = since === undefined ? undefined : this.views.find(item => item.revision === since);
    return base ? diffView(base.view, current.view, base.revision, current.revision) : null;
  }
}
