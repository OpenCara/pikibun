import { pairingCodePattern, pairingIdPattern } from "../../../runner/src/desktop-protocol.js";
import type { GitHubApp, LocalSharedSettings, LocalStartInput, ModelChoice, StartInput } from "../shared/bridge.js";
import { isConnectionId, isModelChoice, MAX_MODELS } from "./settings.js";

// Validation of every payload a local page sends the main process; pure, so tests run it without Electron.

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The package's one plain-object guard, for IPC payloads and the settings file; fields stay `unknown`. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

export function parseStartInput(value: unknown): Parsed<StartInput> {
  if (!isRecord(value) || !onlyKeys(value, ["pairing", "replacePairing"]) || typeof value.replacePairing !== "boolean") {
    return { ok: false, error: "Invalid start request." };
  }
  if (value.pairing === undefined) {
    return value.replacePairing ? { ok: false, error: "Enter a new pairing ID and code to replace this computer's pairing." } : { ok: true, value: { replacePairing: false } };
  }
  const pairing = value.pairing;
  if (!isRecord(pairing) || !onlyKeys(pairing, ["id", "code"]) || typeof pairing.id !== "string" || typeof pairing.code !== "string") {
    return { ok: false, error: "Invalid start request." };
  }
  const id = pairing.id.trim();
  const code = pairing.code.trim();
  if (!pairingIdPattern.test(id)) {
    // Same guard as the CLI: a pasted code in the ID field is no longer private.
    return { ok: false, error: /^[A-Za-z0-9_-]{43}$/.test(id)
      ? "That looks like the single-use pairing code, not the pairing ID. Create a new code in Pikibun (this one is no longer private) and enter its pairing ID, which looks like 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed."
      : "The pairing ID is shown in Pikibun next to the code and looks like 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed." };
  }
  if (!code) return { ok: false, error: "Enter the single-use pairing code shown in Pikibun." };
  if (!pairingCodePattern.test(code)) return { ok: false, error: "That pairing code is not valid. Copy the single-use code shown in Pikibun." };
  return { ok: true, value: { pairing: { id, code }, replacePairing: value.replacePairing } };
}

/** A GitHub OAuth app the page sent: both fields empty means none (keep the saved one). */
function parseGitHubApp(github: unknown): Parsed<GitHubApp | undefined> {
  if (github === undefined) return { ok: true, value: undefined };
  if (!isRecord(github) || !onlyKeys(github, ["clientId", "clientSecret"]) || typeof github.clientId !== "string" || typeof github.clientSecret !== "string") {
    return { ok: false, error: "Invalid request." };
  }
  const clientId = github.clientId.trim();
  const clientSecret = github.clientSecret.trim();
  if (!clientId && !clientSecret) return { ok: true, value: undefined };
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) return { ok: false, error: "Enter the client ID GitHub shows for your OAuth app." };
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(clientSecret)) return { ok: false, error: "Enter a client secret you generated for your OAuth app." };
  return { ok: true, value: { clientId, clientSecret } };
}

/** An administrator as the owner typed it: a user ID, or a GitHub login the app looks up (admins.ts). */
export const ADMIN_ENTRY = /^(?:github:[1-9][0-9]{0,19}|password:[a-z0-9][a-z0-9_-]{2,38}|@?[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/;

function parseShared(value: unknown): Parsed<LocalSharedSettings & { github?: GitHubApp }> {
  const invalid = { ok: false as const, error: "Invalid request." };
  if (!isRecord(value) || !onlyKeys(value, ["origin", "listen", "trustProxy", "signup", "passwordAuth", "admins", "github"])) return invalid;
  const { origin, listen, trustProxy, signup, passwordAuth, admins } = value;
  if (typeof origin !== "string" || origin.length > 2048 || typeof trustProxy !== "boolean" || typeof passwordAuth !== "boolean"
    || (listen !== "loopback" && listen !== "all") || (signup !== "open" && signup !== "invite" && signup !== "off")
    || !Array.isArray(admins) || admins.length > 20 || admins.some(item => typeof item !== "string" || item.length > 100)) return invalid;
  const url = URL.parse(origin.trim());
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return { ok: false, error: "Enter the public HTTPS address people open, such as https://pikibun.example.com: your TLS proxy or tunnel serves it." };
  }
  const entries = [...new Set((admins as string[]).map(item => item.trim()).filter(Boolean))];
  if (!entries.length) return { ok: false, error: "Name at least one administrator: a GitHub login, github:12345 or password:alice." };
  const wrong = entries.find(item => !ADMIN_ENTRY.test(item));
  if (wrong) return { ok: false, error: `"${wrong}" is not a GitHub login, github:12345 or password:alice.` };
  const github = parseGitHubApp(value.github);
  if (!github.ok) return github;
  return { ok: true, value: { origin: url.origin, listen, trustProxy, signup, passwordAuth, admins: entries, ...(github.value ? { github: github.value } : {}) } };
}

/** Settings' start of Pikibun on this computer: for the owner alone with their GitHub OAuth app, or shared with others. */
export function parseLocalStartInput(value: unknown): Parsed<LocalStartInput> {
  if (!isRecord(value)) return { ok: false, error: "Invalid request." };
  if (value.mode === "shared") {
    if (!onlyKeys(value, ["mode", "shared"])) return { ok: false, error: "Invalid request." };
    const shared = parseShared(value.shared);
    return shared.ok ? { ok: true, value: { mode: "shared", shared: shared.value } } : shared;
  }
  if (!onlyKeys(value, ["mode", "github"]) || (value.mode !== undefined && value.mode !== "local")) return { ok: false, error: "Invalid request." };
  const github = parseGitHubApp(value.github);
  if (!github.ok) return github;
  return { ok: true, value: { mode: "local", ...(github.value ? { github: github.value } : {}) } };
}

/** The web page's start of Pikibun on this computer: never with secrets, which only the app's own Settings window takes. */
export function parseRemoteLocalStart(value: unknown): Parsed<LocalStartInput> {
  if (isRecord(value) && (value.github !== undefined || (isRecord(value.shared) && value.shared.github !== undefined))) {
    return { ok: false, error: "Enter GitHub OAuth apps' secrets in Pikibun's own Settings window, not in a web page." };
  }
  return parseLocalStartInput(value);
}

/** "Pair this computer" from the web page: a pairing its server just created, and whether to replace the saved one. */
export function parsePairHere(value: unknown): Parsed<StartInput & { pairing: { id: string; code: string } }> {
  if (!isRecord(value) || !onlyKeys(value, ["pairing", "replacePairing"]) || value.pairing === undefined) return { ok: false, error: "Invalid request." };
  const parsed = parseStartInput(value);
  return parsed.ok && parsed.value.pairing ? { ok: true, value: { ...parsed.value, pairing: parsed.value.pairing } } : { ok: false, error: parsed.ok ? "Invalid request." : parsed.error };
}

export function parseCreateAdmin(value: unknown): Parsed<{ username: string; password: string }> {
  if (!isRecord(value) || !onlyKeys(value, ["username", "password"]) || typeof value.username !== "string" || typeof value.password !== "string"
    || value.username.length > 100 || value.password.length > 1024) return { ok: false, error: "Invalid request." };
  const username = value.username.trim().replace(/^password:/, "");
  if (!username) return { ok: false, error: "Enter the administrator's username." };
  if (!value.password) return { ok: false, error: "Enter a password for the administrator." };
  return { ok: true, value: { username, password: value.password } };
}

/** A call about one connection of the host page: `{ id }`, with the fields `extra` names. */
export function parseConnectionCall(value: unknown, extra: readonly string[] = []): Parsed<Record<string, unknown> & { id: string }> {
  if (!isRecord(value) || !onlyKeys(value, ["id", ...extra]) || !isConnectionId(value.id)) return { ok: false, error: "Invalid request." };
  return { ok: true, value: value as Record<string, unknown> & { id: string } };
}

export function parseModels(value: unknown): Parsed<ModelChoice[] | null> {
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || value.length > MAX_MODELS || !value.every(isModelChoice)) return { ok: false, error: "Invalid request." };
  if (!value.length) return { ok: false, error: "Offer at least one model, or let Pi choose." };
  const unique = new Map(value.map(model => [`${model.provider}/${model.modelId}`, { provider: model.provider, modelId: model.modelId }]));
  return { ok: true, value: [...unique.values()] };
}

export function parseBoolean(value: unknown): Parsed<boolean> {
  return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "Invalid request." };
}

export function parseString(value: unknown, maximum: number): Parsed<string> {
  return typeof value === "string" && value.length <= maximum ? { ok: true, value } : { ok: false, error: "Invalid request." };
}

/** Local pages are served by the app's own protocol; anything else (remote content, a navigated frame) is refused. */
export function isLocalPage(url: string, page: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST && parsed.pathname === `/${page}`;
}

export const APP_SCHEME = "pikibun-app";
export const APP_HOST = "local";
