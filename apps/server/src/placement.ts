import { parseCapabilities, type LocalModelSummary } from '../../../packages/shared/src/connector.js';
import {
  hardwareFresh, loadScore, modelPatternMatches, placementTarget, readReportedHardware, unmetConditions,
  type PlacementCondition, type PlacementRequirements, type ReportedHardware,
} from '../../../packages/shared/src/hardware.js';
import type { PlacementHostSummary, PlacementResult } from '../../../packages/shared/src/cross-session.js';
import type { ThinkingLevel } from '../../../packages/shared/src/types.js';
import { hostCapabilities } from './authority/hosts.js';
import { fail } from './http.js';
import { connectorHostConfig } from './host-config.js';
import type { Env, ModelRow, SessionRow } from './types.js';

const GiB = 1024 ** 3;
const busyActivities = ['working', 'waiting'];
const STARTING_MS = 2 * 60_000;

export interface PlacementHost {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  online: boolean;
  agentMayStart: boolean;
  sandbox: 'sandbox' | 'unsandboxed' | 'unverified';
  gpuUsable: boolean;
  chatOptions: boolean;
  activeSessions: number;
  score: number;
  hardware?: ReportedHardware;
  models: LocalModelSummary[];
}

type HostRow = { id: string; name: string; owner_id: string; owner_name: string | null; capabilities_json: string; models_json: string;
  hardware_json: string | null; hardware_at: string | null };

export function agentMayStartOn(origin: Pick<SessionRow, 'connector_id' | 'owner_id'>, actorId: string, model: Pick<ModelRow, 'connector_id' | 'connector_owner_id'>): boolean {
  return !!model.connector_id && (model.connector_owner_id === actorId || (model.connector_id === origin.connector_id && actorId === origin.owner_id));
}

export async function hostUnsandboxed(env: Env, connectorId: string | null | undefined): Promise<boolean> {
  return (await hostCapabilities(env, connectorId))?.unsandboxed === true;
}

export async function sessionSandboxed(env: Env, session: Pick<SessionRow, 'connector_id' | 'host_environment'>): Promise<boolean> {
  return Number(session.host_environment ?? 0) !== 1 && !await hostUnsandboxed(env, session.connector_id);
}

export function sandboxRequired(what: string, host: string, instead: string): never {
  fail(403, 'sandbox_required', `This session runs in a sandbox, and ${host} runs sessions without one, so its agent doesn't ${what} on its own. ${instead}`);
}

async function online(env: Env, connectorId: string): Promise<boolean> {
  if (!env.CONNECTOR_HUB) return false;
  try { return await env.CONNECTOR_HUB.status(connectorId, 2000); } catch { return false; }
}

export async function placementHosts(env: Env, origin: SessionRow, actorId: string, usable: ModelRow[], now = Date.now()): Promise<Map<string, PlacementHost>> {
  const ids = [...new Set(usable.map(model => model.connector_id).filter((id): id is string => !!id))];
  const hosts = new Map<string, PlacementHost>();
  if (!ids.length) return hosts;
  const marks = ids.map(() => '?').join(',');
  const [rows, active] = await Promise.all([
    env.DB.query<HostRow>(`SELECT c.id, c.name, c.owner_id, u.display_name AS owner_name, c.capabilities_json, c.models_json, c.hardware_json, c.hardware_at
      FROM connectors c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id IN (${marks}) AND c.revoked_at IS NULL`).bind(...ids).all(),
    env.DB.query<{ connector_id: string; n: number }>(`SELECT connector_id, COUNT(*) AS n FROM sessions WHERE connector_id IN (${marks})
      AND (activity IN (${busyActivities.map(() => '?').join(',')}) OR (activity IS NULL AND created_at >= ?)) AND status <> 'archived' GROUP BY connector_id`)
      .bind(...ids, ...busyActivities, new Date(now - STARTING_MS).toISOString()).all(),
  ]);
  const counts = new Map(active.map(row => [row.connector_id, Number(row.n)]));
  await Promise.all(rows.map(async row => {
    const capabilities = parseCapabilities(row.capabilities_json);
    const hardware = readReportedHardware(row.hardware_json, row.hardware_at);
    let models: LocalModelSummary[] = [];
    try { const parsed: unknown = JSON.parse(row.models_json); if (Array.isArray(parsed)) models = parsed as LocalModelSummary[]; } catch { }
    const [isOnline, config] = await Promise.all([online(env, row.id), capabilities.gpu && !capabilities.unsandboxed ? connectorHostConfig(env, row.id) : undefined]);
    const gpuUsable = capabilities.unsandboxed ? (hardware?.gpus.length ?? 0) > 0 : !!capabilities.gpu && config?.gpu === true;
    const activeSessions = counts.get(row.id) ?? 0;
    const sample = usable.find(model => model.connector_id === row.id)!;
    hosts.set(row.id, {
      id: row.id, name: row.name, ownerId: row.owner_id, ownerName: row.owner_name ?? '', online: isOnline, agentMayStart: agentMayStartOn(origin, actorId, sample),
      sandbox: capabilities.unsandboxed ? 'unsandboxed' : capabilities.sandbox ? 'sandbox' : 'unverified', gpuUsable, chatOptions: capabilities.chatOptions === true,
      activeSessions, score: loadScore({ ...(hardware ? { hardware } : {}) }, activeSessions, now), ...(hardware ? { hardware } : {}), models,
    });
  }));
  return hosts;
}

function gb(bytes: number): number {
  return Math.round(bytes / GiB * 10) / 10;
}

export function hostSummary(host: PlacementHost, actorId: string, now = Date.now()): PlacementHostSummary {
  const hardware = host.hardware;
  const fresh = hardwareFresh(hardware, now);
  return {
    id: host.id, name: host.name, owner: host.ownerName || host.ownerId, ...(host.ownerId === actorId ? { yours: true as const } : {}), online: host.online,
    agentMayStart: host.agentMayStart, sandbox: host.sandbox, gpu: host.gpuUsable, activeSessions: host.activeSessions, load: host.score,
    ...(hardware ? { hardware: {
      platform: hardware.platform, arch: hardware.arch, ...(hardware.wsl ? { wsl: true as const } : {}), cpus: hardware.cpus, ...(hardware.cpuModel ? { cpuModel: hardware.cpuModel } : {}),
      memoryGb: gb(hardware.memoryBytes), ...(fresh ? { freeMemoryGb: gb(hardware.freeMemoryBytes) } : {}),
      ...(fresh && hardware.freeDiskBytes !== undefined ? { freeDiskGb: gb(hardware.freeDiskBytes) } : {}), ...(fresh && hardware.load ? { load1: hardware.load[0] } : {}),
      gpus: hardware.gpus.map(gpu => ({ vendor: gpu.vendor, ...(gpu.name ? { name: gpu.name } : {}), ...(gpu.memoryBytes ? { memoryGb: gb(gpu.memoryBytes) } : {}) })),
      reportedAt: hardware.reportedAt,
    } } : {}),
  };
}

const conditionNames: Record<PlacementCondition, string> = {
  gpu: 'gpu', gpuVendor: 'gpu_vendor', gpuMemoryGb: 'gpu_memory_gb', minCpus: 'min_cpus', minMemoryGb: 'min_memory_gb',
  minFreeMemoryGb: 'min_free_memory_gb', minFreeDiskGb: 'min_free_disk_gb', platform: 'platform', arch: 'arch',
};

export const unsandboxedPath = 'Where a person\'s message asks for a host without a sandbox, create with host_environment: true and placement {hosts: [its id]}, as list returns it.';

function supportsThinking(host: PlacementHost, model: ModelRow, level: ThinkingLevel): boolean {
  if (!host.chatOptions) return false;
  const offered = host.models.find(item => item.provider === model.provider && item.modelId === model.model_id);
  return !offered?.thinkingLevels?.length || offered.thinkingLevels.includes(level);
}

export async function placeChild(env: Env, origin: SessionRow, actorId: string, usable: ModelRow[], input: {
  requirements: PlacementRequirements; model?: Pick<ModelRow, 'provider' | 'model_id'>; thinkingLevel?: ThinkingLevel; sandboxedOnly?: boolean; now?: number;
}): Promise<{ model: ModelRow; host: PlacementHost; result: PlacementResult }> {
  const { requirements } = input;
  const now = input.now ?? Date.now();
  const patterns = requirements.models;
  const matching = usable.filter(model => model.connector_id && (patterns
    ? patterns.some(pattern => modelPatternMatches(pattern, { id: model.id, provider: model.provider, modelId: model.model_id }))
    : !input.model || (model.provider === input.model.provider && model.model_id === input.model.model_id)));
  const conditions = placementTarget(requirements);
  if (!matching.length) {
    fail(409, 'placement_unsatisfied', patterns
      ? `No model you may use matches ${patterns.join(', ')}. list returns the models and their hosts.`
      : `No host offers ${input.model ? `${input.model.provider}/${input.model.model_id}` : 'this session\'s model'} to you. Name models in placement, or a model list returns.`);
  }
  const hosts = await placementHosts(env, origin, actorId, matching, now);
  const ruledOut = { hosts: 0, offline: 0, notStartable: 0, unsandboxed: 0, thinking: 0, conditions: new Map<string, number>() };
  const qualified: { model: ModelRow; host: PlacementHost; rank: number }[] = [];
  const seen = new Set<string>();
  for (const model of matching) {
    const host = hosts.get(model.connector_id!);
    if (!host) continue;
    const first = !seen.has(host.id);
    seen.add(host.id);
    const count = (key: 'hosts' | 'offline' | 'notStartable' | 'unsandboxed' | 'thinking') => { if (first) ruledOut[key]++; };
    if (requirements.hosts && !requirements.hosts.includes(host.id)) { count('hosts'); continue; }
    if (!host.online) { count('offline'); continue; }
    if (!host.agentMayStart) { count('notStartable'); continue; }
    if (input.sandboxedOnly && host.sandbox === 'unsandboxed') { count('unsandboxed'); continue; }
    const unmet = unmetConditions({ id: host.id, gpuUsable: host.gpuUsable, ...(host.hardware ? { hardware: host.hardware } : {}) }, requirements, now);
    if (unmet.length) {
      if (first) for (const condition of unmet) ruledOut.conditions.set(conditionNames[condition], (ruledOut.conditions.get(conditionNames[condition]) ?? 0) + 1);
      continue;
    }
    if (input.thinkingLevel && !supportsThinking(host, model, input.thinkingLevel)) { count('thinking'); continue; }
    const rank = patterns ? patterns.findIndex(pattern => modelPatternMatches(pattern, { id: model.id, provider: model.provider, modelId: model.model_id })) : 0;
    qualified.push({ model, host, rank });
  }
  if (!qualified.length) {
    const reasons = [
      ruledOut.hosts ? `${ruledOut.hosts} not among placement hosts` : '',
      ruledOut.offline ? `${ruledOut.offline} offline` : '',
      ruledOut.notStartable ? `${ruledOut.notStartable} another member's host, where only a person can start a session` : '',
      ruledOut.unsandboxed ? `${ruledOut.unsandboxed} running sessions without a sandbox, where this sandboxed session's agent starts none on its own` : '',
      ...[...ruledOut.conditions].map(([name, n]) => `${n} failing ${name}`),
      ruledOut.thinking ? `${ruledOut.thinking} not offering the model at thinking ${input.thinkingLevel}` : '',
    ].filter(Boolean);
    fail(409, 'placement_unsatisfied', `No host qualifies for placement (${conditions}): of ${seen.size} host${seen.size === 1 ? '' : 's'} offering a matching model, `
      + `${reasons.join('; ') || 'none answered'}. Relax the conditions, or ask the person to start the session where it should run.`
      + (ruledOut.unsandboxed ? ` ${unsandboxedPath}` : ''));
  }
  qualified.sort((a, b) => a.host.score - b.host.score
    || Number(b.host.id === origin.connector_id) - Number(a.host.id === origin.connector_id)
    || a.rank - b.rank
    || (a.host.id < b.host.id ? -1 : a.host.id > b.host.id ? 1 : 0)
    || (a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0));
  const chosen = qualified[0]!;
  return { model: chosen.model, host: chosen.host, result: {
    host: { id: chosen.host.id, name: chosen.host.name }, conditions, load: chosen.host.score, activeSessions: chosen.host.activeSessions,
    qualified: new Set(qualified.map(item => item.host.id)).size, considered: seen.size,
  } };
}
