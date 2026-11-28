import { locale, localeSettings } from "nsh";
import { t } from "nsh/i18n";
import type { SessionView } from "../../../../packages/shared/src/types";
import { cacheHitRate } from "../../../../packages/shared/src/usage";
import type { EntryView } from "../shared";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return seconds % 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds / 60} min`;
}

const tokenUnits: readonly [number, string][] = [[1e3, "K"], [1e6, "M"], [1e9, "B"]];

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "?";
  if (tokens < 1000) return String(Math.round(tokens));
  for (const [size, unit] of tokenUnits) {
    const value = tokens / size;
    if (value >= 999.5 && unit !== "B") continue;
    const tenths = Math.round(value * 10);
    return `${tenths < 1000 ? tenths / 10 : Math.round(value)}${unit}`;
  }
  return String(tokens);
}

export function formatCost(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars < 0) return "?";
  if (dollars > 0 && dollars < 0.01) return "<$0.01";
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatRate(rate: number | undefined): string {
  return rate === undefined || !Number.isFinite(rate) ? "?" : `${Math.round(rate * 100)}%`;
}

export function usageStatus(view: Pick<SessionView, "context" | "usage"> | undefined): { text: string; label: string } | undefined {
  const context = view?.context, usage = view?.usage;
  const text: string[] = [], label: string[] = [];
  if (context?.window) {
    const percent = Math.round(context.tokens / context.window * 100);
    text.push(`${percent}% of ${formatTokens(context.window)}`);
    label.push(`context ${percent}% full`);
  }
  if (usage) {
    text.push(formatCost(usage.total.cost));
    label.push(`${formatCost(usage.total.cost)} spent`);
    const last = cacheHitRate(usage.last);
    const hit = last ?? cacheHitRate(usage.total);
    if (hit !== undefined) {
      text.push(`cache ${formatRate(hit)}`);
      label.push(`${formatRate(hit)} of the ${last !== undefined ? "last request's" : "session's"} prompt from the cache`);
    }
  }
  return text.length ? { text: text.join(" · "), label: `Session: ${label.join(", ")}` } : undefined;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
export function dateTimeFormat(kind: "date" | "time", tag: string, hourCycle: string, timeZone: string): Intl.DateTimeFormat {
  const key = `${kind} ${tag} ${hourCycle} ${timeZone}`;
  let format = formatters.get(key);
  if (!format) {
    const options: Intl.DateTimeFormatOptions = kind === "date"
      ? { year: "numeric", month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: hourCycle as Intl.DateTimeFormatOptions["hourCycle"] };
    try {
      format = new Intl.DateTimeFormat(tag, { ...options, timeZone });
    } catch {
      format = new Intl.DateTimeFormat(tag, options);
    }
    formatters.set(key, format);
  }
  return format;
}

function dateFormat(kind: "date" | "time"): Intl.DateTimeFormat {
  const { hourCycle, timeZone } = localeSettings();
  return dateTimeFormat(kind, locale(), hourCycle, timeZone);
}

export function dateLabel(date: Date): string {
  return dateFormat("date").format(date);
}

export function relativeTime(value: string, now = Date.now()): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return t("time.just_now");
  if (minutes < 60) return t("time.minutes_ago", { n: minutes });
  if (minutes < 1440) return t("time.hours_ago", { n: Math.floor(minutes / 60) });
  if (minutes < 10_080) return t("time.days_ago", { n: Math.floor(minutes / 1440) });
  return dateLabel(new Date(time));
}

export function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormat("time").format(date);
}

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

export const randomId = (): string => crypto.randomUUID();
