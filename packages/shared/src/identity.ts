const encoder = new TextEncoder();

export const IDENTITY_KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SETTINGS_BYTES = 16 * 1024;

export interface PortableSettings {
  name?: string;
  toolOutput?: "full" | "brief";
  paging?: boolean;
}

export interface DelegationStatement { kind: "delegation"; key: string; server: string; connector: string; issuedAt: string }
export interface SessionMarkStatement { kind: "session"; key: string; session: string; issuedAt: string }
export interface RotationStatement { kind: "rotation"; key: string; next: string; issuedAt: string }
export interface SettingsStatement { kind: "settings"; key: string; version: number; settings: PortableSettings; issuedAt: string }
export type IdentityStatement = DelegationStatement | SessionMarkStatement | RotationStatement | SettingsStatement;
export type IdentityStatementKind = IdentityStatement["kind"];
export type StatementOf<K extends IdentityStatementKind> = Extract<IdentityStatement, { kind: K }>;

export interface Signed<T extends IdentityStatement = IdentityStatement> { statement: T; signature: string }

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid number in a statement");
    if (value === undefined) throw new Error("Undefined in a statement");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid encoding");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error("Noncanonical encoding");
  return bytes;
}

function message(statement: IdentityStatement): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(`pikibun identity v1\n${canonicalJson(statement)}`);
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
  bytes.set(encoded);
  return bytes;
}

export async function publicKeyOf(key: CryptoKey): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export async function signStatement<T extends IdentityStatement>(privateKey: CryptoKey, statement: T): Promise<Signed<T>> {
  const checked = parseStatement(statement, statement.kind) as T;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message(checked)));
  return { statement: checked, signature: base64url(signature) };
}

export async function verifyStatement(signed: Signed): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64url(signed.statement.key), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64url(signed.signature), message(signed.statement));
  } catch {
    return false;
  }
}

function text(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);
}

export function parseSettings(value: unknown): PortableSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid portable settings");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["name", "toolOutput", "paging"].includes(key))) throw new Error("Invalid portable settings");
  const settings: PortableSettings = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f\x7f]/.test(input.name)) throw new Error("Invalid portable settings");
    settings.name = input.name;
  }
  if (input.toolOutput !== undefined) {
    if (input.toolOutput !== "full" && input.toolOutput !== "brief") throw new Error("Invalid portable settings");
    settings.toolOutput = input.toolOutput;
  }
  if (input.paging !== undefined) {
    if (typeof input.paging !== "boolean") throw new Error("Invalid portable settings");
    settings.paging = input.paging;
  }
  if (encoder.encode(canonicalJson(settings)).length > SETTINGS_BYTES) throw new Error("Portable settings are too large");
  return settings;
}

export function parseStatement<K extends IdentityStatementKind>(value: unknown, kind: K): StatementOf<K> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid identity statement");
  const input = value as Record<string, unknown>;
  if (input.kind !== kind || !text(input.key, IDENTITY_KEY) || !text(input.issuedAt, TIMESTAMP)) throw new Error("Invalid identity statement");
  if (kind === "delegation") {
    if (!exactKeys(input, ["kind", "key", "server", "connector", "issuedAt"]) || !text(input.connector, IDENTIFIER)
      || typeof input.server !== "string" || input.server.length > 300 || !validOrigin(input.server)) throw new Error("Invalid identity statement");
  } else if (kind === "session") {
    if (!exactKeys(input, ["kind", "key", "session", "issuedAt"]) || !text(input.session, IDENTIFIER)) throw new Error("Invalid identity statement");
  } else if (kind === "rotation") {
    if (!exactKeys(input, ["kind", "key", "next", "issuedAt"]) || !text(input.next, IDENTITY_KEY) || input.next === input.key) throw new Error("Invalid identity statement");
  } else if (kind === "settings") {
    if (!exactKeys(input, ["kind", "key", "version", "settings", "issuedAt"]) || !Number.isSafeInteger(input.version) || (input.version as number) < 1) {
      throw new Error("Invalid identity statement");
    }
    return { kind, key: input.key, version: input.version, settings: parseSettings(input.settings), issuedAt: input.issuedAt } as StatementOf<K>;
  } else throw new Error("Invalid identity statement");
  return JSON.parse(canonicalJson(input)) as StatementOf<K>;
}

export function parseSigned<K extends IdentityStatementKind>(value: unknown, kind: K): Signed<StatementOf<K>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid signed statement");
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["statement", "signature"]) || !text(input.signature, SIGNATURE)) throw new Error("Invalid signed statement");
  return { statement: parseStatement(input.statement, kind), signature: input.signature as string };
}

export async function verifiedSigned<K extends IdentityStatementKind>(value: unknown, kind: K): Promise<Signed<StatementOf<K>>> {
  const signed = parseSigned(value, kind);
  if (!await verifyStatement(signed)) throw new Error("Invalid signature");
  return signed;
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}
