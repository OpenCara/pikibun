export const PRIVATE_SESSIONS_VERSION = 1;
export const PRIVATE_FORWARD_HEADER = "x-pikibun-forward";
export const PRIVATE_FORWARD_PATH = "/v1/private";
export const PRIVATE_TICKET_SESSION = "private";
export const PRIVATE_REPORT_LIMIT = 500;

export type PrivateForwardMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface PrivateForwardRequest {
  method: PrivateForwardMethod;
  path: string;
  body?: string;
}

export interface PrivateForwardResponse {
  status: number;
  contentType: string;
  data: string;
}

const SESSION = "([A-Za-z0-9][A-Za-z0-9_-]{0,127})";
const SCHEDULE = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const routes: readonly { method: PrivateForwardMethod; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/api\/private-sessions$/ },
  { method: "POST", pattern: /^\/api\/private-sessions$/ },
  { method: "GET", pattern: new RegExp(`^/api/sessions/${SESSION}$`) },
  { method: "PATCH", pattern: new RegExp(`^/api/sessions/${SESSION}$`) },
  { method: "GET", pattern: new RegExp(`^/api/sessions/${SESSION}/(?:view|entries|events|files|changes|images|artifacts|resources|schedules|audit|pull-request|connections)$`) },
  { method: "POST", pattern: new RegExp(`^/api/sessions/${SESSION}/(?:archive|unarchive|submit|ask|stop|withdraw|revert|fork|restart|sudo|uploads|tunnel/stop|schedules)$`) },
  { method: "PATCH", pattern: new RegExp(`^/api/sessions/${SESSION}/schedules/${SCHEDULE}$`) },
  { method: "DELETE", pattern: new RegExp(`^/api/sessions/${SESSION}/schedules/${SCHEDULE}$`) },
  { method: "POST", pattern: new RegExp(`^/api/sessions/${SESSION}/schedules/${SCHEDULE}/run$`) },
];
const QUERY = /^[A-Za-z0-9_.~%=&+:-]{0,2048}$/;

export function privateRoute(method: string, path: string): { sessionId?: string } | null {
  if (typeof method !== "string" || typeof path !== "string" || path.length > 2600) return null;
  const mark = path.indexOf("?");
  const pathname = mark < 0 ? path : path.slice(0, mark);
  if (mark >= 0 && !QUERY.test(path.slice(mark + 1))) return null;
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return match[1] ? { sessionId: match[1] } : {};
  }
  return null;
}

export function parsePrivateForwardRequest(value: unknown): PrivateForwardRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "method" && key !== "path" && key !== "body")) return null;
  if (typeof input.method !== "string" || typeof input.path !== "string" || !privateRoute(input.method, input.path)) return null;
  if (input.body !== undefined && (typeof input.body !== "string" || input.method === "GET")) return null;
  return { method: input.method as PrivateForwardMethod, path: input.path, ...(input.body !== undefined ? { body: input.body as string } : {}) };
}

export function parsePrivateForwardResponse(value: unknown): PrivateForwardResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "status" && key !== "contentType" && key !== "data")) return null;
  if (typeof input.status !== "number" || !Number.isInteger(input.status) || input.status < 200 || input.status > 599) return null;
  if (typeof input.contentType !== "string" || input.contentType.length > 200 || /[\r\n]/.test(input.contentType)) return null;
  if (typeof input.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) return null;
  return { status: input.status, contentType: input.contentType, data: input.data };
}
