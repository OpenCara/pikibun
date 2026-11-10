import type { SourceReadAs } from "./workspace-connections.js";
export const sourceKinds = ["git", "notion", "google-drive", "feishu", "dropbox", "onedrive", "tencent-docs"] as const;
export type SourceKind = (typeof sourceKinds)[number];
export const documentKinds = ["notion", "google-drive", "feishu", "dropbox", "onedrive", "tencent-docs"] as const;
export type DocumentKind = (typeof documentKinds)[number];
export function documentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (documentKinds as readonly string[]).includes(value);
}
export const documentKindNames: Record<DocumentKind, string> = {
  notion: "Notion", "google-drive": "Google Drive", feishu: "Feishu / Lark", dropbox: "Dropbox", onedrive: "OneDrive / SharePoint", "tencent-docs": "Tencent Docs",
};
export const secretKinds: readonly DocumentKind[] = ["notion", "google-drive", "feishu"];
export const oauthKinds: readonly DocumentKind[] = ["notion", "google-drive", "dropbox", "onedrive", "tencent-docs"];

export const sourceLimits = {
  documents: 20,
  title: 300,
} as const;

export interface SourceAccount {
  provider: DocumentKind;
  method: "secret" | "oauth";
  name: string;
  createdAt: string;
}
export interface SourceAccountList {
  accounts: SourceAccount[];
  oauth: DocumentKind[];
}
export const feishuDomains = ["feishu", "lark"] as const;
export type FeishuDomain = (typeof feishuDomains)[number];
export type SourceAccountInput =
  | { provider: "notion"; token: string }
  | { provider: "google-drive"; key: string }
  | { provider: "feishu"; appId: string; appSecret: string; domain: FeishuDomain };

export const documentItemTypes = ["page", "database", "folder", "document", "spreadsheet", "presentation", "file", "wiki"] as const;
export type DocumentItemType = (typeof documentItemTypes)[number];

export interface WorkspaceDocumentSource {
  id: string;
  workspaceId: string;
  kind: DocumentKind;
  itemId: string;
  itemType: DocumentItemType;
  title: string;
  url: string;
  createdAt: string;
  readAs: SourceReadAs;
}
export interface WorkspaceSourceList {
  sources: WorkspaceDocumentSource[];
}

export interface GrantSource { id: string; kind: DocumentKind; type: DocumentItemType; title: string }

export interface SourceReadRequest {
  sessionId: string;
  actorId: string;
  admissionId: string;
  callId: string;
  source: string;
  item?: string;
}

export interface SourceReadEntry { id: string; type: DocumentItemType; title: string; url?: string; lastEdited?: string }
export interface SourceReadView {
  source: string;
  kind: DocumentKind;
  id: string;
  type: DocumentItemType;
  title: string;
  url: string;
  lastEdited: string;
  content?: string;
  entries?: SourceReadEntry[];
  note?: string;
  truncated: boolean;
}
export const sourceReadLimits = { bytes: 96 * 1024, entries: 200, ancestry: 16, item: 2048 } as const;
export function validSourceItem(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= sourceReadLimits.item && !/[\x00-\x1f\x7f]/.test(value);
}

export const notionReadLimits = { blocks: 1000, depth: 3 } as const;

export function notionId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  let candidate = text;
  let url = false;
  if (/^https:\/\//i.test(text)) {
    let parsed: URL;
    try { parsed = new URL(text); } catch { return null; }
    if (parsed.hostname !== "notion.so" && parsed.hostname !== "www.notion.so" && !parsed.hostname.endsWith(".notion.site")) return null;
    candidate = parsed.searchParams.get("p") ?? parsed.pathname.split("/").at(-1) ?? "";
    url = true;
  }
  const pattern = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;
  const match = candidate.match(pattern);
  if (!match || (!url && match[0] !== candidate) || (url && match.index! > 0 && candidate[match.index! - 1] !== "-")) return null;
  return match.slice(1).join("-").toLowerCase();
}

const driveIdPattern = /^[A-Za-z0-9_-]{10,200}$/;
export function googleDriveId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  if (!/^https:\/\//i.test(text)) return driveIdPattern.test(text) ? text : null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.hostname !== "drive.google.com" && url.hostname !== "docs.google.com") return null;
  const path = url.pathname.match(/\/(?:folders|d)\/([A-Za-z0-9_-]+)/);
  const id = path?.[1] ?? url.searchParams.get("id");
  return id && driveIdPattern.test(id) ? id : null;
}

const feishuTokenPattern = /^[A-Za-z0-9]{10,64}$/;
export type FeishuItem = { type: "folder" | "document" | "wiki"; token: string };
export function feishuItem(value: unknown): FeishuItem | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  const prefixed = text.match(/^(folder|docx|wiki):([A-Za-z0-9]+)$/);
  if (prefixed) return feishuTokenPattern.test(prefixed[2]!) ? { type: prefixed[1] === "docx" ? "document" : prefixed[1] as "folder" | "wiki", token: prefixed[2]! } : null;
  if (!/^https:\/\//i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  const host = url.hostname;
  if (!(host === "feishu.cn" || host.endsWith(".feishu.cn") || host === "larksuite.com" || host.endsWith(".larksuite.com"))) return null;
  const path = url.pathname.match(/\/(drive\/folder|docx|wiki)\/([A-Za-z0-9]+)/);
  if (!path || !feishuTokenPattern.test(path[2]!)) return null;
  return { type: path[1] === "docx" ? "document" : path[1] === "wiki" ? "wiki" : "folder", token: path[2]! };
}

const dropboxIdPattern = /^id:[A-Za-z0-9_-]{8,64}$/;
export function dropboxItem(value: unknown): { path: string } | { url: string } | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  if (dropboxIdPattern.test(text)) return { path: text };
  if (text.startsWith("/") && text.length > 1 && !/[\x00-\x1f\x7f]/.test(text) && !text.split("/").some(part => part === "." || part === "..")) return { path: text.replace(/\/+$/, "") };
  if (!/^https:\/\//i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.hostname !== "www.dropbox.com" && url.hostname !== "dropbox.com") return null;
  if (url.pathname.startsWith("/home/")) return { path: decodeURIComponent(url.pathname.slice("/home".length)).replace(/\/+$/, "") };
  return /^\/(s|sh|scl)\//.test(url.pathname) ? { url: url.href } : null;
}

export function onedriveItem(value: unknown): { driveId: string; itemId: string } | { url: string } | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  const id = text.match(/^([A-Za-z0-9!_-]{1,100})~([A-Za-z0-9!_-]{1,100})$/);
  if (id) return { driveId: id[1]!, itemId: id[2]! };
  if (!/^https:\/\//i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  const host = url.hostname;
  return host === "onedrive.live.com" || host === "1drv.ms" || host.endsWith(".sharepoint.com") || host === "onedrive.cloud.microsoft" ? { url: url.href } : null;
}

const tencentIdPattern = /^[A-Za-z0-9_-]{6,80}$/;
export function tencentDocsItem(value: unknown): { type: "folder" | "file"; id: string } | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  const prefixed = text.match(/^(file|folder):(.+)$/);
  if (prefixed) return tencentIdPattern.test(prefixed[2]!) ? { type: prefixed[1] as "file" | "folder", id: prefixed[2]! } : null;
  if (!/^https:\/\//i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.hostname !== "docs.qq.com") return null;
  const folder = url.pathname.match(/\/folder\/([A-Za-z0-9_-]+)/);
  if (folder) return tencentIdPattern.test(folder[1]!) ? { type: "folder", id: folder[1]! } : null;
  const file = url.pathname.match(/^\/(doc|sheet|slide|mind|form|pdf|flowchart|smartsheet)\/([A-Za-z0-9_-]+)/);
  return file && tencentIdPattern.test(file[2]!) ? { type: "file", id: file[2]! } : null;
}
