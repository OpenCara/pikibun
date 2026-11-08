import { useCallback, useEffect, useState } from "react";
import type { DesktopBridge, DesktopView, Outcome } from "../../desktop/src/shared/remote-bridge";

// The Pikibun desktop app, when this page runs in one of its windows: `window.pikibunDesktop` (remote-bridge.ts), which
// Settings › This Mac uses to show and change the app's own settings. Absent in a browser.

declare global { interface Window { pikibunDesktop?: DesktopBridge } }

export type { DesktopBridge, DesktopView };

export function desktopBridge(): DesktopBridge | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.pikibunDesktop;
  return bridge && bridge.version === 1 ? bridge : undefined;
}

/** Throws a refused outcome's message, for useAction. */
export async function check(outcome: Promise<Outcome | void>): Promise<void> {
  const result = await outcome;
  if (result && !result.ok) throw new Error(result.error);
}

/** The app's settings as the main process reports them, kept current; null outside the app or before the first view. */
export function useDesktop(): { bridge: DesktopBridge | undefined; view: DesktopView | null; error: string; reload: () => void } {
  const bridge = desktopBridge();
  const [view, setView] = useState<DesktopView | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    if (!bridge) return;
    bridge.view().then(next => { setView(next); setError(""); }, () => setError("Pikibun's app settings are unavailable on this page."));
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    reload();
    return bridge.onUpdate(setView);
  }, [bridge, reload]);
  return { bridge, view, error, reload };
}
