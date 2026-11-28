export interface OrderedWorkspace {
  id: string;
  personal?: boolean;
}

export interface HeaderPlace {
  id: string;
  top: number;
  height: number;
}

export function orderWorkspaces<T extends OrderedWorkspace>(list: readonly T[], ids: readonly string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  const place = (item: T, index: number) => (item.personal ? -1 : rank.get(item.id) ?? ids.length + index);
  return list.map((item, index) => ({ item, at: place(item, index) })).sort((a, b) => a.at - b.at).map(({ item }) => item);
}

export function movableIds(list: readonly OrderedWorkspace[]): string[] {
  return list.filter(item => !item.personal).map(item => item.id);
}

export function moveBy(ids: readonly string[], id: string, step: number): string[] | null {
  const from = ids.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length || step === 0) return null;
  const next = ids.filter(item => item !== id);
  next.splice(to, 0, id);
  return next;
}

export function dropIndex(ids: readonly string[], dragged: string, places: readonly HeaderPlace[], pointerY: number): number {
  const others = ids.filter(id => id !== dragged);
  const where = new Map(places.map(place => [place.id, place]));
  let lastSeen = -1;
  for (const [index, id] of others.entries()) {
    const place = where.get(id);
    if (!place) continue;
    if (place.top + place.height / 2 > pointerY) return index;
    lastSeen = index;
  }
  return lastSeen < 0 ? ids.indexOf(dragged) : lastSeen + 1;
}

export function dropAt(ids: readonly string[], dragged: string, index: number): string[] | null {
  if (!ids.includes(dragged)) return null;
  const next = ids.filter(id => id !== dragged);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, dragged);
  return next.every((id, at) => id === ids[at]) ? null : next;
}
