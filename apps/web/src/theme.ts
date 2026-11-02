import { useEffect, useState } from "react";

/** "pikibun" is the night theme in the character's colors: lavender ears, cream belly, night sky. */
export type ThemePreference = "system" | "light" | "dark" | "pikibun";
const KEY = "pikibun.theme";

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" || value === "pikibun" ? value : "system";
  } catch {
    return "system";
  }
}

/** Applies the preference to <html data-theme>; "system" follows prefers-color-scheme. */
export function applyTheme(preference: ThemePreference = stored()): void {
  if (preference === "pikibun") {
    document.documentElement.dataset.theme = "pikibun";
    return;
  }
  const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function useTheme(): [ThemePreference, (value: ThemePreference) => void] {
  const [preference, setPreference] = useState(stored);
  useEffect(() => {
    applyTheme(preference);
    // Re-read storage: another hook instance (Settings -> Appearance) may have changed the choice.
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => applyTheme();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [preference]);
  return [preference, value => {
    try { localStorage.setItem(KEY, value); } catch { /* Private mode keeps the in-memory choice. */ }
    setPreference(value);
  }];
}
