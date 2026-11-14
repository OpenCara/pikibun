export type Holdable = { ref?(): unknown; unref?(): unknown; destroyed?: boolean };

// A closed socket or pipe has no handle left, so net.Socket's ref() and unref() wait for a "connect" that never comes:
// each call would leave one more listener on it. A closed stream holds nothing open, so it is skipped.
export function holdHandles(handles: readonly (Holdable | null | undefined)[], held: boolean): void {
  for (const handle of handles) {
    if (!handle || handle.destroyed) continue;
    if (held) handle.ref?.();
    else handle.unref?.();
  }
}
