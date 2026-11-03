import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createConnector, controlPlaneOrigin, type LocalConnector } from "./connector.js";
import { assertConnectorPlatform, assertPrerequisites, defaultStateDir, hostIsolation, loadConnectorModels, npmPrerequisite, savedPairing, unsandboxedWarning, type HostIsolation } from "./connect-setup.js";
import { parentTransport, stdioTransport } from "./desktop-transport.js";
import { pairingCodePattern, pairingIdPattern, uploadRequestLimits, type HostError, type HostErrorCode, type HostEvent, type HostInspection, type HostRequest, type HostState, type StartRequest } from "./desktop-protocol.js";
import { RunnerLeaseBusyError } from "./lease.js";
import { ConnectorSetupError } from "./protocol.js";
import { LoginError, LoginSession, loginProviders, piLogin, runLogin } from "./pi-login.js";
import { DEFAULT_WINDOWS_LIMITS, windowsRuntimeDirectory, type SandboxBackendConfig } from "./sandbox-backend.js";

// The connector, run by a desktop app instead of a terminal: requests arrive over the parent's IPC channel (Electron's
// utilityProcess parentPort, or Node's fork channel) and status, logs and failures go back the same way. With --stdio
// the channel is JSON lines on stdin and stdout instead: the Windows app runs this host inside WSL2 through wsl.exe.

class HostFailure extends ConnectorSetupError {
  constructor(readonly code: HostErrorCode, message: string) { super(message); }
}

const requestId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const developmentOptions = { allowFaux: z.boolean().optional(), allowInsecureLoopback: z.boolean().optional() };
const isolationOptions = { experimentalSandbox: z.boolean().optional() };
/** Strict: unknown request types and unknown fields are refused, never ignored. */
const hostRequestSchema: z.ZodType<HostRequest> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inspect"), id: requestId, ...isolationOptions, ...developmentOptions }).strict(),
  z.object({
    type: z.literal("start"), id: requestId, server: z.string().min(1).max(2048),
    pairing: z.object({ id: z.string().regex(pairingIdPattern), code: z.string().regex(pairingCodePattern) }).strict().optional(),
    replacePairing: z.boolean().optional(), unsandboxedConsent: z.boolean().optional(),
    models: z.array(z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict()).min(1).max(200).optional(),
    ...isolationOptions, ...developmentOptions,
  }).strict(),
  z.object({ type: z.literal("stop"), id: requestId }).strict(),
  z.object({ type: z.literal("upload"), id: requestId, grant: z.string().min(1).max(uploadRequestLimits.grant), body: z.string().max(uploadRequestLimits.body) }).strict(),
  z.object({ type: z.literal("providers"), id: requestId }).strict(),
  z.object({ type: z.literal("login"), id: requestId, provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), method: z.enum(["oauth", "api_key"]) }).strict(),
  z.object({ type: z.literal("login-answer"), id: requestId, login: requestId, prompt: requestId, value: z.string().max(8192) }).strict(),
  z.object({ type: z.literal("login-cancel"), id: requestId, login: requestId }).strict(),
]);

/** Only connector-authored text crosses to the app: SDK and HTTP errors can carry auth or configuration detail. */
function hostError(error: unknown, fallback: string): HostError {
  if (error instanceof HostFailure) return { code: error.code, message: error.message };
  if (error instanceof RunnerLeaseBusyError) return { code: "lease-busy", message: "Another Pikibun connector is already running with this computer's pairing, for example `pikibun connect` in a terminal. Stop it there, then start the host here." };
  if (error instanceof ConnectorSetupError) return { code: "setup", message: error.message };
  return { code: "failed", message: fallback };
}

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: { "state-dir": { type: "string" }, stdio: { type: "boolean" } } });
/** `~/` is this host's home: the Windows app names a state directory inside WSL2 without knowing where its home is. */
const givenStateDir = values["state-dir"];
const stateDir = givenStateDir === undefined ? defaultStateDir() : givenStateDir.startsWith("~/") ? join(homedir(), givenStateDir.slice(2)) : givenStateDir;
const transport = values.stdio ? stdioTransport<HostEvent>() : parentTransport<HostEvent>();
let running: { connector: LocalConnector; stopRequested: boolean } | undefined;
/** The sign-in under way, named by its request's id: one at a time. */
let signingIn: { id: number; session: LoginSession } | undefined;

function emit(event: HostEvent): void { transport.send(event); }
function log(level: "info" | "warning" | "error", message: string): void { emit({ type: "log", level, message }); }
function status(state: HostState, detail: { server?: string; unsandboxed?: boolean; sandbox?: HostInspection["sandbox"]; connectorId?: string } = {}): void { emit({ type: "status", state, ...detail }); }

/** The isolation `experimentalSandbox` asks for: the platform's own sandbox, where it has one, on macOS and native Windows. */
function isolation(experimentalSandbox = false): Promise<HostIsolation> {
  assertConnectorPlatform({ experimentalSandbox: experimentalSandbox && process.platform !== "linux" });
  return hostIsolation(experimentalSandbox ? { stateDir } : undefined);
}

/** The sandbox backend of an isolation that runs macOS's or Windows' own sandbox, with the CLI's default limits. */
function sandboxBackend(chosen: HostIsolation): SandboxBackendConfig | undefined {
  if (chosen.mode !== "sandboxed") return undefined;
  if (chosen.sandbox === "seatbelt") return { kind: "seatbelt" };
  if (chosen.sandbox === "windows") return { kind: "windows", runtime: windowsRuntimeDirectory(stateDir), limits: DEFAULT_WINDOWS_LIMITS };
  return undefined;
}

async function inspect(allowFaux = false, allowInsecureLoopback = false, experimentalSandbox = false): Promise<HostInspection> {
  let chosen: HostIsolation;
  try { chosen = await isolation(experimentalSandbox); }
  catch (error) {
    return { platform: process.platform, stateDir, unsupported: hostError(error, "This computer cannot run the Pikibun host.").message, mode: "unsandboxed", prerequisites: [], models: [] };
  }
  const { mode, sandbox, sandboxPrerequisites, prerequisites } = chosen;
  // Listed after what the host needs to start: npm only matters for installing extensions, so it is optional.
  const inspection: HostInspection = { platform: process.platform, stateDir, mode, prerequisites: [...prerequisites, npmPrerequisite()], models: [] };
  if (sandbox) inspection.sandbox = sandbox;
  if (sandboxPrerequisites) inspection.sandboxPrerequisites = sandboxPrerequisites;
  if (mode === "unsandboxed") inspection.unsandboxedWarning = unsandboxedWarning();
  try { assertPrerequisites(prerequisites, mode === "unsandboxed", ""); }
  catch (error) { inspection.prerequisitesError = hostError(error, "Prerequisites could not be checked.").message; }
  try { inspection.pairedServer = await savedPairing(stateDir, allowInsecureLoopback); }
  catch (error) { inspection.pairingError = hostError(error, "This computer's saved pairing could not be read.").message; }
  try { inspection.models = await (await loadConnectorModels({ allowFaux })).manifest(); }
  catch (error) { inspection.modelsError = hostError(error, "Pi's models could not be loaded. Check Pi's configuration on this computer; catalogs over 200 models need enabledModels in Pi's settings.json.").message; }
  return inspection;
}

/** Checks everything the CLI checks before it prompts, then starts the connector; progress arrives as events. */
async function start(request: StartRequest): Promise<void> {
  if (running) throw new HostFailure("already-running", "The host is already running.");
  let chosen: HostIsolation;
  try { chosen = await isolation(request.experimentalSandbox); }
  catch (error) { throw new HostFailure("unsupported", hostError(error, "This computer cannot run the Pikibun host.").message); }
  const { mode, prerequisites } = chosen;
  const unsandboxed = mode === "unsandboxed";
  const backend = sandboxBackend(chosen);
  const sandbox = unsandboxed ? undefined : chosen.sandbox;
  if (unsandboxed && request.unsandboxedConsent !== true) throw new HostFailure("consent-required", "This computer has no isolated sandbox: running the host needs your consent to run agent work directly on it.");
  assertPrerequisites(prerequisites, unsandboxed, "");
  let server: string;
  try { server = controlPlaneOrigin(request.server, request.allowInsecureLoopback); }
  catch { throw new HostFailure("setup", "The server must be an HTTPS origin such as https://pikibun.com."); }
  const localModels = await loadConnectorModels({ allowFaux: request.allowFaux, models: request.models });
  const replace = request.pairing !== undefined && request.replacePairing === true;
  // A replacement never reads the saved pairing: it may be revoked, unreadable or bound to another server.
  const paired = replace ? undefined : await savedPairing(stateDir, request.allowInsecureLoopback);
  if (!request.pairing && !paired) throw new HostFailure("not-paired", "This computer is not paired yet. In Pikibun, open Settings › Hosts, create a pairing code, then enter its pairing ID and code here.");
  if (request.pairing && paired) throw new HostFailure("already-paired", "This computer is already paired. Choose \"Replace existing pairing\" to pair it again, or start without a new code to keep using it.");
  if (paired && paired !== server) throw new HostFailure("server-mismatch", `This computer is paired with ${paired}, not ${server}. Pair it again with a code from ${server}, or switch the server back in Settings.`);
  // Another start may have won while this one awaited its checks.
  if (running) throw new HostFailure("already-running", "The host is already running.");
  const pairing = request.pairing && { id: request.pairing.id, code: request.pairing.code };
  const connector = createConnector({
    dataDir: stateDir, server, pairing, replacePairing: replace, localModels, unsandboxed, ...(backend ? { sandboxBackend: backend } : {}),
    allowInsecureLoopback: request.allowInsecureLoopback, allowFaux: request.allowFaux,
    // Binary presence cannot attest a working namespace or a per-session resource
    // domain. Advertise conservatively; each actual operation verifies isolation.
    capabilities: { platform: process.platform, sandbox: false, productionShell: false },
    // The app's pages hand this connector the files attached to their messages themselves (LocalConnector.direct).
    directUploads: true,
    onStatus: state => {
      if (running?.connector !== connector) return;
      if (state !== "stopped") {
        const connectorId = state === "connected" ? connector.connectorId : undefined;
        status(state, { server, unsandboxed, ...(sandbox ? { sandbox } : {}), ...(connectorId ? { connectorId } : {}) });
        return;
      }
      const expected = running.stopRequested;
      running = undefined;
      status("stopped");
      if (!expected) emit({ type: "failed", error: { code: "failed", message: "The host stopped unexpectedly: it lost its lock on this computer's pairing. Start it again." } });
    },
    onWarning: () => log("warning", "Some resource domains are unavailable; production bash remains fail-closed."),
  });
  const current = { connector, stopRequested: false };
  running = current;
  status("starting", { server, unsandboxed, ...(sandbox ? { sandbox } : {}) });
  log("info", unsandboxed
    ? "Running unsandboxed: approved commands execute directly on this machine."
    : backend ? `Experimental ${backend.kind === "seatbelt" ? "macOS (Seatbelt)" : "Windows (process container)"} sandbox: not yet verified; report what breaks.`
    : "Sandbox capability is verified per session; production shell stays disabled without provisioned, verified limits.");
  log("info", "Host configuration (command time limit, GPU, Git credentials, repository cache) is set in Pikibun: Settings › Hosts › this host.");
  void connector.start().then(
    () => log("info", `Connected to ${server}.`),
    async (error: unknown) => {
      if (current.stopRequested) return;
      current.stopRequested = true;
      emit({ type: "failed", error: hostError(error, "The host failed to start. Check this computer's pairing, Pi configuration and prerequisites.") });
      await connector.stop().catch(() => {});
    },
  ).finally(() => { if (pairing) pairing.code = ""; });
}

async function stop(): Promise<void> {
  const current = running;
  if (!current) return;
  current.stopRequested = true;
  status("stopping");
  await current.connector.stop();
}

/** Signs Pi in to a provider here (pi-login.ts); its events name this request, and its result ends it. */
async function login(id: number, provider: string, method: "oauth" | "api_key"): Promise<void> {
  if (signingIn) throw new HostFailure("busy", "Another sign-in is under way: finish or cancel it first.");
  const session = new LoginSession(event => emit({ type: "login", login: id, event }));
  signingIn = { id, session };
  try {
    const pi = await piLogin();
    await runLogin({ runtime: pi.runtime, provider, method, session, deviceId: pi.deviceId });
    log("info", "Pi signed in to a provider on this computer. Its models are offered from the host's next start.");
  } catch (error) {
    if (error instanceof LoginError) throw new HostFailure(error.cancelled ? "cancelled" : "failed", error.message);
    throw new HostFailure("failed", "Sign-in failed. Check this computer's network and Pi's configuration, then try again.");
  } finally {
    if (signingIn?.session === session) signingIn = undefined;
  }
}

async function handle(request: HostRequest): Promise<void> {
  try {
    if (request.type === "providers") {
      let providers;
      try { providers = await loginProviders((await piLogin()).runtime); }
      catch { throw new HostFailure("failed", "Pi's providers could not be read. Check Pi's configuration on this computer."); }
      emit({ type: "result", id: request.id, ok: true, providers });
    } else if (request.type === "login") {
      await login(request.id, request.provider, request.method);
      emit({ type: "result", id: request.id, ok: true });
    } else if (request.type === "login-answer" || request.type === "login-cancel") {
      const current = signingIn?.id === request.login ? signingIn.session : undefined;
      if (!current) throw new HostFailure("not-running", "That sign-in has ended.");
      if (request.type === "login-cancel") current.cancel();
      else if (!current.answer(request.prompt, request.value)) throw new HostFailure("not-running", "That question has been answered or has closed.");
      emit({ type: "result", id: request.id, ok: true });
    } else if (request.type === "upload") {
      if (!running) throw new HostFailure("not-running", "The host isn't running.");
      emit({ type: "result", id: request.id, ok: true, reply: await running.connector.direct({ grant: request.grant, body: request.body }) });
    } else if (request.type === "inspect") {
      emit({ type: "result", id: request.id, ok: true, inspection: await inspect(request.allowFaux, request.allowInsecureLoopback, request.experimentalSandbox) });
    } else {
      await (request.type === "start" ? start(request) : stop());
      emit({ type: "result", id: request.id, ok: true });
    }
  } catch (error) {
    emit({ type: "result", id: request.id, ok: false, error: hostError(error, request.type === "stop" ? "The host did not stop cleanly." : request.type === "upload" ? "The host could not take the file." : request.type.startsWith("login") || request.type === "providers" ? "Sign-in failed." : "The host could not start. Check this computer's pairing, Pi configuration and prerequisites.") });
  }
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  signingIn?.session.cancel();
  await stop().catch(() => {});
  process.exit(0);
}

transport.onMessage(value => {
  const request = hostRequestSchema.safeParse(value);
  if (request.success) { void handle(request.data); return; }
  // Unknown shapes are refused; the id, when usable, lets the app settle the request it is waiting on.
  const id = value && typeof value === "object" && "id" in value && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id >= 0 ? value.id : undefined;
  if (id === undefined) log("error", "Ignored a malformed host request.");
  else emit({ type: "result", id, ok: false, error: { code: "invalid-request", message: "The host refused a malformed request." } });
});
transport.onClose(() => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
emit({ type: "ready" });
