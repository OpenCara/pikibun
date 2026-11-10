import type { EntryView } from "../shared";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return seconds % 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds / 60} min`;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function dateLabel(date: Date): string {
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

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

export function modelFailure({ provider, modelId, status }: NonNullable<EntryView["error"]>, { advice = true }: { advice?: boolean } = {}): string {
  const name = provider ?? "the provider";
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

export const randomId = (): string => crypto.randomUUID();
