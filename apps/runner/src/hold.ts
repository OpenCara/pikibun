export type Holdable = { ref?(): unknown; unref?(): unknown; destroyed?: boolean };

export function holdHandles(handles: readonly (Holdable | null | undefined)[], held: boolean): void {
  for (const handle of handles) {
    if (!handle || handle.destroyed) continue;
    if (held) handle.ref?.();
    else handle.unref?.();
  }
}
