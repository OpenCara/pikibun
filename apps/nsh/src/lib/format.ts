import type { EntryView } from "../shared";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  // Round first, so 9 951 ms is "10 s" like 10 000 ms rather than "10.0 s".
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return seconds % 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds / 60} min`;
}

const tokenUnits: readonly [number, string][] = [[1e3, "K"], [1e6, "M"], [1e9, "B"]];

/** A count of tokens, short: "850", "84.2K", "200K", "1M". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "?";
  if (tokens < 1000) return String(Math.round(tokens));
  for (const [size, unit] of tokenUnits) {
    const value = tokens / size;
    // A count that rounds to 1000 of a unit is 1 of the next: 999,600 is "1M", not "1000K".
    if (value >= 999.5 && unit !== "B") continue;
    // One decimal under 100, as "84.2K"; rounded first, so 99,960 is "100K" rather than "100.0K".
    const tenths = Math.round(value * 10);
    return `${tenths < 1000 ? tenths / 10 : Math.round(value)}${unit}`;
  }
  return String(tokens);
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** A date as "6 Nov 2026": QuickJS's Intl is minimal, so dates are formatted by hand on every platform alike. */
export function dateLabel(date: Date): string {
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/** Compact age of a past moment; older than a week shows the date. */
export function relativeTime(value: string, now = Date.now()): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 10_080) return `${Math.floor(minutes / 1440)} d ago`;
  return dateLabel(new Date(time));
}

export function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${dateLabel(date)}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Why a model request failed, from the only details that cross the host boundary: provider, model, HTTP status and the
 * fixed cause Pi's own message gave. `advice: false` (a share link, whose readers can't act on it) gives the cause alone.
 */
export function modelFailure({ provider, modelId, status, cause, compacting }: NonNullable<EntryView["error"]>, { advice = true }: { advice?: boolean } = {}): string {
  const name = provider ?? "the provider";
  if (cause === "incomplete_stream") {
    const model = [provider, modelId].filter(Boolean).join("/") || "the model";
    const cut = `The response from ${model} stopped before it finished: the connection closed without an error.`;
    if (!advice) return compacting ? `${cut} The host started compacting the conversation's context.` : cut;
    const why = " A gateway or proxy between the host and the provider usually does this, and a very long conversation makes it more likely.";
    return compacting
      ? `${cut}${why} The host started compacting this conversation's context so the next request is smaller: send the message again once a summary of the conversation appears. If none does, or the message fails again, continue in a new session.`
      : `${cut}${why} Send the message again to retry. If it keeps failing, continue in a new session.`;
  }
  if (!advice) {
    if (status === 401 || status === 403) return `The host's Pi credentials for ${name} were rejected.`;
    if (status === 429) return `Rate limited by ${name}.`;
    if (status !== undefined && status >= 500 && status < 600) return `${name} was unavailable.`;
  }
  if (status === 401 || status === 403) return `The host's Pi credentials for ${name} were rejected. The host owner should check Pi's login or API key, then restart the connector.`;
  if (status === 429) return `Rate limited by ${name}. Try again shortly.`;
  if (status !== undefined && status >= 500 && status < 600) return `${name} is unavailable. Try again shortly.`;
  return `The request to ${[provider, modelId].filter(Boolean).join("/") || "the model"} failed${status ? ` (HTTP ${status})` : ""}`;
}

/** A random UUID (v4) for idempotency keys. */
export const randomId = (): string => crypto.randomUUID();
