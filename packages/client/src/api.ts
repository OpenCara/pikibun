export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export type Api = <T>(path: string, options?: RequestOptions) => Promise<T>;

export interface ApiOptions {
  baseUrl?: string;
  auth: "cookie" | (() => string | null);
  fetch?: typeof fetch;
}

const statusNames: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout",
  409: "Conflict", 413: "Payload Too Large", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout", 520: "Unknown Error", 521: "Web Server Is Down", 522: "Connection Timed Out",
  523: "Origin Is Unreachable", 524: "A Timeout Occurred",
};

const DETAIL_LIMIT = 200;

const stripTags = (html: string) => html.replace(/<\/?[a-z!][^>]*>/gi, " ");

const decodeEntities = (text: string) => text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function plainDetail(raw: string): string {
  const looksLikeMarkup = (value: string) => /<[a-z!/]/i.test(value);
  const toText = (value: string) => {
    const decoded = decodeEntities(value);
    return looksLikeMarkup(decoded) ? stripTags(decoded.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")) : decoded;
  };
  let source = raw;
  if (looksLikeMarkup(raw)) {
    const pick = (tag: string) => {
      const inner = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(raw)?.[1];
      return inner !== undefined && toText(inner).trim() ? inner : undefined;
    };
    source = pick("title") ?? pick("h1") ?? raw;
  }
  let text = toText(source).replace(/[<>]/g, "");
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text;
}

function foreignJsonDetail(body: unknown): string {
  if (typeof body === "string") return plainDetail(body);
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const record = body as Record<string, unknown>;
  for (const key of ["message", "detail", "error_description", "title", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return plainDetail(value);
  }
  return "";
}

function upstreamError(response: Response, detail: string): ApiError {
  const status = response.status;
  const name = response.statusText || statusNames[status] || "";
  const said = detail && detail.toLowerCase() !== name.toLowerCase() && detail !== String(status) ? `: "${detail}"` : "";
  const answer = `HTTP ${status}${name ? ` ${name}` : ""}${said}`;
  if (status === 429) {
    return new ApiError(429, "RATE_LIMITED", `Pikibun is over its request limit right now (${answer}). Try again later.`);
  }
  if (status === 408 || status === 504 || status === 522 || status === 524) {
    return new ApiError(status, "UPSTREAM_TIMEOUT", `The proxy in front of Pikibun stopped waiting for the server (${answer}). `
      + "The request took too long, but the server may have accepted it and still be working on it: check the result before retrying.");
  }
  if (status === 502 || status === 503 || status === 520 || status === 521 || status === 523) {
    return new ApiError(status, "BACKEND_UNAVAILABLE", `The proxy in front of Pikibun got no valid answer from the server (${answer}). `
      + "The server may have restarted, crashed or taken too long while handling this request; if it changes something, check the result before retrying.");
  }
  if (response.ok) {
    return new ApiError(status, "BACKEND_UNAVAILABLE", `The Pikibun API answered with something other than JSON (${answer}). Try again later.`);
  }
  return new ApiError(status, "REQUEST_FAILED", `The request failed before reaching Pikibun's API (${answer}).`);
}

async function decode(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const raw = await response.text().catch(() => "");
    throw upstreamError(response, plainDetail(raw));
  }
  if (response.ok) {
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(response.status, "BACKEND_UNAVAILABLE", `The Pikibun API's answer arrived incomplete or garbled (HTTP ${response.status}). `
        + "The connection may have dropped; if the request changes something, check the result before retrying.");
    }
  }
  const raw = await response.text().catch(() => "");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw upstreamError(response, plainDetail(raw)); }
  const shaped = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown };
  const error = shaped.error;
  const message = typeof error === "string" ? error
    : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : undefined;
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code
    : typeof shaped.code === "string" ? shaped.code : undefined;
  if (!message) throw upstreamError(response, foreignJsonDetail(body));
  throw new ApiError(response.status, code ?? "REQUEST_FAILED", message);
}

export function createApi(options: ApiOptions): Api {
  const base = options.baseUrl ?? "";
  const call = (input: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(input, init);
  return async function api<T>(path: string, request: RequestOptions = {}): Promise<T> {
    const method = request.method ?? "GET";
    const headers: Record<string, string> = { ...request.headers, Accept: "application/json" };
    const init: RequestInit = { method, headers, signal: request.signal };
    if (options.auth === "cookie") {
      init.credentials = "same-origin";
      if (method !== "GET") {
        const token = await decode(await call(`${base}/api/auth/csrf`, { credentials: "same-origin", signal: request.signal })) as { csrfToken: string };
        headers["x-csrf-token"] = token.csrfToken;
      }
    } else {
      init.credentials = "omit";
      const token = options.auth();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    const response = await call(`${base}${path}`, init);
    if (response.status === 204 && response.ok) return undefined as T;
    return await decode(response) as T;
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Could not reach Pikibun. Check your connection and try again.";
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export const segment = (value: string) => encodeURIComponent(value);
