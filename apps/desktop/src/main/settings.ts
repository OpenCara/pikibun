import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SERVER, parseServerOrigin } from "./origin.js";
import { isRecord } from "./requests.js";
import { WSL_DISTRO } from "./wsl.js";

export interface Bounds { x: number; y: number; width: number; height: number }

export interface ModelChoice { provider: string; modelId: string }

/** Where a Windows host's sessions run (bridge.ts SandboxChoice): WSL2, in a distribution or WSL's default, or natively. */
export type SandboxChoice = { sandbox: "wsl2"; distro?: string } | { sandbox: "native" };

/**
 * A Pikibun server this computer connects to: its window, and the connector (`pikibun connect`) that makes this computer
 * one of its hosts. The primary connection (`PRIMARY_CONNECTION`, always first) uses the CLI's own connector state, so
 * a computer paired with `pikibun connect` is adopted as is; every other one has its own state directory, as
 * `pikibun connect --state-dir` gives a second connection.
 */
export interface ConnectionSettings {
  id: string;
  server: string;
  /**
   * Present while the owner wants this host running: set when they start it, cleared when they stop it. The app resumes
   * hosting when it opens, with the unsandboxed consent they gave in the dialog at that start.
   */
  resumeHost?: { unsandboxedConsent: boolean };
  /** The models this host offers, like `pikibun connect --model`; absent, Pi's enabledModels or every configured one. */
  models?: ModelChoice[];
  /**
   * Windows only: where this host's sessions run; absent, WSL2 in WSL's default distribution. Each choice has its own
   * connector state, and so its own pairing: WSL2's is inside the distribution, native Windows' in the user's profile.
   */
  windows?: SandboxChoice;
}

export interface Settings {
  /** At least one; the first is the primary connection, whose server the Pikibun window opens. */
  connections: ConnectionSettings[];
  windowBounds?: Bounds;
  /**
   * Present while the owner wants Pikibun running on this computer (local-server.ts): the Pikibun window then shows it
   * instead of the primary server, and it starts again at launch, for its owner alone or shared as it was, with the
   * unsandboxed consent given at its start.
   */
  localServer?: { unsandboxedConsent: boolean; mode?: "shared" };
}

export const PRIMARY_CONNECTION = "default";
export const MAX_CONNECTIONS = 10;
export const MAX_MODELS = 200;
const CONNECTION_ID = /^[0-9a-f]{8,32}$/;

export const isConnectionId = (value: unknown): value is string => value === PRIMARY_CONNECTION || (typeof value === "string" && CONNECTION_ID.test(value));

const isBounds = (value: unknown): value is Bounds => isRecord(value)
  && [value.x, value.y, value.width, value.height].every(item => typeof item === "number" && Number.isSafeInteger(item))
  && Number(value.width) >= 200 && Number(value.height) >= 200;

export const isModelChoice = (value: unknown): value is ModelChoice => isRecord(value) && Object.keys(value).length === 2
  && typeof value.provider === "string" && value.provider.length >= 1 && value.provider.length <= 128
  && typeof value.modelId === "string" && value.modelId.length >= 1 && value.modelId.length <= 256;

export function parseSandboxChoice(value: unknown): SandboxChoice | undefined {
  if (!isRecord(value)) return undefined;
  if (value.sandbox === "native" && Object.keys(value).length === 1) return { sandbox: "native" };
  if (value.sandbox !== "wsl2" || !Object.keys(value).every(key => key === "sandbox" || key === "distro")) return undefined;
  if (value.distro === undefined) return { sandbox: "wsl2" };
  return typeof value.distro === "string" && WSL_DISTRO.test(value.distro) ? { sandbox: "wsl2", distro: value.distro } : undefined;
}

const parseResume = (value: unknown) => isRecord(value) && typeof value.unsandboxedConsent === "boolean" ? { unsandboxedConsent: value.unsandboxedConsent } : undefined;

function parseConnection(value: unknown): ConnectionSettings | undefined {
  if (!isRecord(value) || !isConnectionId(value.id) || typeof value.server !== "string") return undefined;
  const server = parseServerOrigin(value.server);
  if (!server.ok) return undefined;
  const connection: ConnectionSettings = { id: value.id, server: server.origin };
  const resume = parseResume(value.resumeHost);
  if (resume) connection.resumeHost = resume;
  if (Array.isArray(value.models) && value.models.length >= 1 && value.models.length <= MAX_MODELS && value.models.every(isModelChoice)) {
    connection.models = value.models.map(model => ({ provider: model.provider, modelId: model.modelId }));
  }
  const windows = parseSandboxChoice(value.windows);
  if (windows) connection.windows = windows;
  return connection;
}

/**
 * Unknown or invalid fields fall back to defaults: a damaged file never stops the app from opening. A `gitCredentials`
 * left by older versions is dropped: the host's owner turns Git credentials on in Pikibun now. Older versions' single
 * `server` and `resumeHost` become the primary connection.
 */
export function parseSettings(value: unknown): Settings {
  const source = isRecord(value) ? value : {};
  const connections: ConnectionSettings[] = [];
  if (Array.isArray(source.connections)) {
    for (const item of source.connections.slice(0, MAX_CONNECTIONS)) {
      const connection = parseConnection(item);
      if (connection && !connections.some(other => other.id === connection.id || other.server === connection.server)) connections.push(connection);
    }
  } else if (typeof source.server === "string") {
    const legacy = parseConnection({ id: PRIMARY_CONNECTION, server: source.server, resumeHost: source.resumeHost });
    if (legacy) connections.push(legacy);
  }
  // The primary connection comes first, always: it owns the CLI's connector state.
  const primary = connections.findIndex(connection => connection.id === PRIMARY_CONNECTION);
  if (primary > 0) connections.unshift(...connections.splice(primary, 1));
  if (primary < 0) {
    const taken = connections.findIndex(connection => connection.server === DEFAULT_SERVER);
    if (taken >= 0) connections.splice(taken, 1);
    connections.unshift({ id: PRIMARY_CONNECTION, server: DEFAULT_SERVER });
  }
  const settings: Settings = { connections };
  if (isBounds(source.windowBounds)) settings.windowBounds = source.windowBounds;
  const local = source.localServer;
  if (isRecord(local) && typeof local.unsandboxedConsent === "boolean") {
    settings.localServer = { unsandboxedConsent: local.unsandboxedConsent, ...(local.mode === "shared" ? { mode: "shared" as const } : {}) };
  }
  return settings;
}

/** settings.json under userData, replaced atomically on every change. */
export class SettingsStore {
  private current: Settings;

  constructor(private readonly path: string) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { raw = undefined; }
    this.current = parseSettings(raw);
  }

  get(): Readonly<Settings> { return this.current; }

  /** The primary connection's server: what the Pikibun window opens while Pikibun doesn't run on this computer. */
  get server(): string { return this.current.connections[0]!.server; }

  connection(id: string): Readonly<ConnectionSettings> | undefined {
    return this.current.connections.find(connection => connection.id === id);
  }

  update(patch: Partial<Settings>): void {
    const next: Settings = { ...this.current, ...patch };
    for (const key of Object.keys(patch) as (keyof Settings)[]) if (patch[key] === undefined) delete next[key];
    this.current = next;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.settings-${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /** Changes one connection; fields set to undefined are removed. A connection that is gone is left alone. */
  updateConnection(id: string, patch: Partial<Omit<ConnectionSettings, "id">>): void {
    const connections = this.current.connections.map(connection => {
      if (connection.id !== id) return connection;
      const next: ConnectionSettings = { ...connection, ...patch };
      for (const key of Object.keys(patch) as (keyof ConnectionSettings)[]) if (patch[key as keyof typeof patch] === undefined) delete next[key];
      return next;
    });
    this.update({ connections });
  }

  /** Adds a server; refused when it is already there or there are too many. */
  addConnection(server: string, id: string): { ok: true } | { ok: false; error: string } {
    if (!CONNECTION_ID.test(id)) return { ok: false, error: "Invalid connection." };
    if (this.current.connections.some(connection => connection.server === server)) return { ok: false, error: `${server} is already in the list.` };
    if (this.current.connections.length >= MAX_CONNECTIONS) return { ok: false, error: `Pikibun connects to at most ${MAX_CONNECTIONS} servers.` };
    this.update({ connections: [...this.current.connections, { id, server }] });
    return { ok: true };
  }

  removeConnection(id: string): void {
    if (id === PRIMARY_CONNECTION) return;
    this.update({ connections: this.current.connections.filter(connection => connection.id !== id) });
  }
}
