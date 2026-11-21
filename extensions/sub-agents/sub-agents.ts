import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export const subAgentsFlags = Object.freeze({
  placement: "Conditions every sub-agent's host must meet, unless the agent sets them itself: key=value pairs separated by commas or new lines, such as "
    + "\"min_free_memory_gb=4, platform=linux\". Keys: gpu (true or false), gpu_vendor, gpu_memory_gb, min_cpus, min_memory_gb, min_free_memory_gb, "
    + "min_free_disk_gb, platform, arch, hosts and models (lists separated by |)",
  models: "Model patterns for sub-agents that name no model, separated by commas: model ids, provider/model, or globs such as anthropic/*. "
    + "Any of them may run a sub-agent, and load decides among them (their order only breaks ties). Empty runs them on the session's own model, on whichever host offers it",
  balance: "Let Pikibun place every sub-agent on the least loaded host that meets its conditions, even when neither the agent nor the placement setting names any. "
    + "Off, a sub-agent with no conditions runs on the host of the model it names",
  "max-sub-agents": "How many sub-agents one message may start, 0 to 10. 0 lets the agent start none",
  notify: "Have each sub-agent's outcome sent back to the session that started it once it finishes",
  delegate: "When the agent hands work to sub-agents: when-useful (independent parts that can run at once, or that need hardware or models this host lacks) or when-asked (only when the person asks)",
});

export const DEFAULT_MAX_SUB_AGENTS = 5;
export const MAX_SUB_AGENTS = 10;

export type Delegate = "when-useful" | "when-asked";
export type Placement = Record<string, string | number | boolean | string[]>;

export interface SubAgentsSettings {
  placement: Placement;
  ignored: string[];
  models: string[];
  balance: boolean;
  maxSubAgents: number;
  notify: boolean;
  delegate: Delegate;
}

const numberKeys = new Set(["gpu_memory_gb", "min_cpus", "min_memory_gb", "min_free_memory_gb", "min_free_disk_gb"]);
const listKeys = new Set(["hosts", "models"]);
const textKeys = new Set(["gpu_vendor", "platform", "arch"]);
const gpuVendors = new Set(["nvidia", "amd", "intel", "apple", "microsoft", "other"]);

function flagOn(setting: unknown, fallback: boolean): boolean {
  if (typeof setting === "string") {
    const value = setting.trim().toLowerCase();
    if (["false", "off", "no", "0"].includes(value)) return false;
    if (["true", "on", "yes", "1"].includes(value)) return true;
    return fallback;
  }
  return typeof setting === "boolean" ? setting : fallback;
}

function names(text: string, separator: RegExp): string[] {
  return [...new Set(text.split(separator).map(item => item.trim()).filter(item => item && item.length <= 200 && !/[\x00-\x1f\x7f]/.test(item)))];
}

export function parsePlacementSetting(setting: unknown): { placement: Placement; ignored: string[] } {
  const placement: Placement = {};
  const ignored: string[] = [];
  const text = typeof setting === "string" ? setting : "";
  for (const entry of text.split(/[,;\n]+/).map(item => item.trim()).filter(Boolean)) {
    const match = /^([a-z_-]+)\s*[=:]\s*(.+)$/i.exec(entry);
    const key = match?.[1]!.toLowerCase().replace(/-/g, "_");
    const value = match?.[2]!.trim() ?? "";
    if (!match || !key) { ignored.push(entry); continue; }
    if (key === "gpu" && /^(true|yes|on|1|false|no|off|0)$/i.test(value)) placement.gpu = /^(true|yes|on|1)$/i.test(value);
    else if (numberKeys.has(key) && /^\d+(\.\d+)?$/.test(value) && (key !== "min_cpus" || (Number.isInteger(Number(value)) && Number(value) >= 1))) placement[key] = Number(value);
    else if (listKeys.has(key) && names(value, /\|/).length) placement[key] = names(value, /\|/).slice(0, key === "hosts" ? 50 : 20);
    else if (key === "gpu_vendor" && gpuVendors.has(value.toLowerCase())) placement[key] = value.toLowerCase();
    else if (textKeys.has(key) && key !== "gpu_vendor" && /^[A-Za-z0-9._-]{1,40}$/.test(value)) placement[key] = value;
    else ignored.push(entry);
  }
  if (placement.gpu === false) {
    for (const key of ["gpu_vendor", "gpu_memory_gb"]) if (key in placement) { delete placement[key]; ignored.push(key); }
  }
  return { placement, ignored };
}

export function maxSubAgents(setting: unknown): number {
  const text = typeof setting === "number" ? String(setting) : typeof setting === "string" ? setting.trim() : "";
  if (!/^\d+$/.test(text)) return DEFAULT_MAX_SUB_AGENTS;
  return Math.min(Number(text), MAX_SUB_AGENTS);
}

export function readSettings(flag: (name: string) => unknown): SubAgentsSettings {
  const { placement, ignored } = parsePlacementSetting(flag("placement"));
  const delegate = typeof flag("delegate") === "string" && String(flag("delegate")).trim().toLowerCase() === "when-asked" ? "when-asked" : "when-useful";
  return { placement, ignored, models: names(typeof flag("models") === "string" ? String(flag("models")) : "", /[,|\n]+/).slice(0, 20),
    balance: flagOn(flag("balance"), true), maxSubAgents: maxSubAgents(flag("max-sub-agents")), notify: flagOn(flag("notify"), true), delegate };
}

export function placementText(placement: Placement): string {
  return Object.entries(placement).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`).join(", ");
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class SubAgentsState {
  started = 0;
  placementUnsupported = false;
  modelsRefused = false;
  balanceRefused = false;
  readonly #pending = new Map<string, { balanced: boolean }>();

  newMessage(): void {
    this.started = 0;
    this.#pending.clear();
  }

  prepare(input: Record<string, unknown>, settings: SubAgentsSettings, callId = ""): { block?: string } {
    if (input.action !== "create") return {};
    if (settings.maxSubAgents === 0) return { block: "This workspace's sub-agents setting (max-sub-agents 0) lets no message start sub-agents: do the work in this session." };
    if (this.started + this.#pending.size >= settings.maxSubAgents) {
      return { block: `This message already started ${this.started} sub-agents${this.#pending.size ? ` and is starting ${this.#pending.size} more` : ""}, the most the workspace's max-sub-agents allows. `
        + "Collect their results (sessions wait or read), then do the rest in this session or in a later message." };
    }
    let balanced = false;
    if (!this.placementUnsupported) {
      const given = record(input.placement) ? { ...input.placement } : undefined;
      const namesModel = typeof input.model === "string" && input.model !== "";
      const defaults: Placement = { ...settings.placement };
      if (namesModel || this.modelsRefused || (given && "models" in given)) delete defaults.models;
      const merged: Record<string, unknown> = { ...defaults, ...given };
      if (!namesModel && !this.modelsRefused && !("models" in merged) && settings.models.length) merged.models = [...settings.models];
      balanced = !given && !Object.keys(merged).length;
      if (given || Object.keys(merged).length || (settings.balance && !this.balanceRefused)) input.placement = merged;
      else balanced = false;
    }
    if (settings.notify && typeof input.message === "string" && input.notify === undefined) input.notify = true;
    this.#pending.set(callId, { balanced });
    return {};
  }

  observe(call: { toolName: string; toolCallId?: string; input: Record<string, unknown>; content: readonly { type: string; text?: string }[]; isError: boolean },
    settings: SubAgentsSettings): string | undefined {
    if (call.toolName !== "sessions" || call.input.action !== "create") return undefined;
    const pending = this.#pending.get(call.toolCallId ?? "");
    this.#pending.delete(call.toolCallId ?? "");
    const text = call.content.map(item => item.type === "text" ? item.text ?? "" : "").join("\n");
    if (call.isError) {
      if (pending?.balanced && /No host offers/.test(text) && !this.balanceRefused) {
        this.balanceRefused = true;
        return "[sub-agents] Pikibun couldn't place this sub-agent by load: no host offers its model. The extension stops adding a placement of its own for this session: call create again.";
      }
      if (/takes no placement|Unexpected sessions tool field/.test(text) && !this.placementUnsupported) {
        this.placementUnsupported = true;
        return "[sub-agents] This Pikibun server can't place sessions by host conditions yet, so placement is left out from now on: "
          + "call create again, naming the model (a model list returns, which also names its host) for where the sub-agent should run.";
      }
      if (/placement models|child_models_disabled/.test(text) && !this.modelsRefused) {
        this.modelsRefused = true;
        return "[sub-agents] This workspace runs sub-agents on this session's own model, so models are left out of placement from now on: call create again.";
      }
      if (/No host qualifies|No model you may use matches|No host offers/.test(text)) {
        const defaults = placementText(settings.placement);
        return `[sub-agents] No host met this sub-agent's conditions${defaults ? ` (the workspace adds ${defaults} to every sub-agent)` : ""}. `
          + "Relax the conditions you set (sessions list shows each host's hardware and load), or do the work in this session, or tell the person what it needs.";
      }
      return undefined;
    }
    this.started++;
    let result: Record<string, unknown> = {};
    const first = call.content.find(item => item.type === "text")?.text ?? "";
    try { const parsed: unknown = JSON.parse(first); if (record(parsed)) result = parsed; } catch { }
    const session = record(result.session) ? result.session : {};
    const placement = record(result.placement) ? result.placement : undefined;
    const host = placement && record(placement.host) ? placement.host : undefined;
    const message = record(result.message) ? result.message : undefined;
    const where = host ? ` on host ${String(host.name ?? host.id)} (load ${String(placement!.load)}, the least loaded of ${String(placement!.qualified)} that qualified)` : "";
    const left = settings.maxSubAgents - this.started;
    const collect = message
      ? (call.input.notify === true ? `It reports back when it finishes; meanwhile carry on, and before you answer, collect its result with sessions wait {session: "${String(session.id ?? "")}", message_id: "${String(message.id ?? "")}"}.`
        : `Collect its result with sessions wait {session: "${String(session.id ?? "")}", message_id: "${String(message.id ?? "")}"} before you answer.`)
      : "It has no task yet: send it one with sessions send.";
    return `[sub-agents] Sub-agent ${String(session.id ?? "")} started${where}. ${collect} `
      + (left > 0 ? `${left} more may start in this message.` : "No more may start in this message.");
  }
}

export function subAgentsPrompt(settings: SubAgentsSettings, state: Pick<SubAgentsState, "placementUnsupported" | "modelsRefused"> & { balanceRefused?: boolean }): string {
  if (settings.maxSubAgents === 0) return "## Sub-agents\n\nThis workspace lets no message start sub-agent sessions: do the work in this session.";
  const defaults = placementText(state.modelsRefused ? Object.fromEntries(Object.entries(settings.placement).filter(([key]) => key !== "models")) : settings.placement);
  const models = !state.modelsRefused && settings.models.length ? settings.models.join(", ") : "";
  const lines = [
    "## Sub-agents",
    "",
    "With the sessions tool you can hand sub-tasks to sub-agents: new sessions you start with sessions create {title, message, placement?, model?, thinking?}, each on the host that suits its task. "
      + "Without the sessions tool (the workspace adds it as Other sessions), none of this applies.",
    whenLine(settings),
    state.placementUnsupported
      ? "- Where: this Pikibun server can't place by host conditions; name a model sessions list returns, which runs on that model's host."
      : `- Where: Pikibun places each sub-agent on the least loaded online host you may start sessions on that meets its placement: {gpu: true} for rendering, ML or CUDA work, min_cpus and min_memory_gb for heavy builds, min_free_disk_gb for large data, platform and arch for platform-specific work${state.modelsRefused ? "" : ", models for the models a task may run on (a strong one for hard work, a fast one for simple work; any match qualifies and load decides, so name one alone to insist on it)"}. sessions list shows each host's hardware, active sessions and load. The result names the host it chose.`,
    ...(defaults || models || (settings.balance && !state.placementUnsupported && !state.balanceRefused) ? [`- This workspace's defaults, added to each create that leaves them out (yours win): ${[
      defaults ? `conditions ${defaults}` : "", models ? `models ${models} for sub-agents that name no model` : "",
      settings.balance && !state.placementUnsupported && !state.balanceRefused ? "placement on the least loaded qualifying host for every sub-agent" : "",
    ].filter(Boolean).join("; ")}.`] : []),
    `- How many: at most ${settings.maxSubAgents} sub-agent${settings.maxSubAgents === 1 ? "" : "s"} per message.`,
    "- Each sub-agent starts knowing nothing of this conversation: its message carries the whole task: the goal, the repository and branch to work on, the files concerned, the constraints, what to report back and when it is done. Have each work on a branch of its own where several change one repository.",
    settings.notify
      ? "- Collecting: each reports back to this session when it finishes (notify). Carry on with your own part meanwhile; before you answer, collect every result with sessions wait {session, message_id} (or read), check it, and bring the results together. Stop sub-agents no longer needed."
      : "- Collecting: wait for each with sessions wait {session, message_id}, or read it, before you answer; check each result and bring them together. Stop sub-agents no longer needed.",
  ];
  return lines.join("\n");
}

function whenLine(settings: SubAgentsSettings): string {
  return settings.delegate === "when-asked"
    ? "- When: only when the person asks for work to be split up or run elsewhere."
    : "- When: split work into sub-agents where its parts are independent and can run at once (a module each, a test matrix, research on several questions), or where a part needs hardware or a model this session's host lacks (a GPU, more memory or CPUs, another platform, a stronger or cheaper model). Keep small or tightly coupled work in this session, and involve sub-agents only where the person would expect it.";
}

export const SUB_AGENTS_SKILL = "sub-agents";
export const SUB_AGENTS_SKILL_DESCRIPTION = "How this workspace hands sub-tasks to sub-agents, sessions started with the sessions tool: when to split work, where each one runs "
  + "(placement, models and the workspace's defaults), what its message must hold, and how to collect results. Read it before you call sessions create.";

type PromptState = Parameters<typeof subAgentsPrompt>[1];

export function subAgentsSkill(settings: SubAgentsSettings, state: PromptState): string {
  const body = subAgentsPrompt(settings, state).replace(/^## Sub-agents\n/, "# Sub-agents\n");
  return `---\nname: ${SUB_AGENTS_SKILL}\ndescription: ${JSON.stringify(SUB_AGENTS_SKILL_DESCRIPTION)}\n---\n\n${body}\n`;
}

export function subAgentsRule(settings: SubAgentsSettings, state: PromptState): string {
  if (settings.maxSubAgents === 0) return subAgentsPrompt(settings, state);
  return [
    "## Sub-agents",
    "",
    "With the sessions tool you can hand sub-tasks to sub-agents: new sessions you start with sessions create. "
      + "Without the sessions tool (the workspace adds it as Other sessions), none of this applies.",
    whenLine(settings),
    `- How many: at most ${settings.maxSubAgents} sub-agent${settings.maxSubAgents === 1 ? "" : "s"} per message.`,
    `- How: before you call sessions create, read the ${SUB_AGENTS_SKILL} skill (listed with the skills) for where each one runs, what its message must hold `
      + "and how to collect the results.",
  ].join("\n");
}

class SkillFolder {
  #directory: string | undefined;

  write(name: string, content: string): string {
    this.#directory ??= mkdtempSync(join(tmpdir(), "pi-sub-agents-"));
    const folder = join(this.#directory, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), content);
    return folder;
  }

  remove(): void {
    if (this.#directory) rmSync(this.#directory, { recursive: true, force: true });
    this.#directory = undefined;
  }
}

export const subAgentsExtension: ExtensionFactory = pi => {
  pi.registerFlag("placement", { type: "string", default: "", description: subAgentsFlags.placement });
  pi.registerFlag("models", { type: "string", default: "", description: subAgentsFlags.models });
  pi.registerFlag("balance", { type: "boolean", default: true, description: subAgentsFlags.balance });
  pi.registerFlag("max-sub-agents", { type: "string", default: String(DEFAULT_MAX_SUB_AGENTS), description: subAgentsFlags["max-sub-agents"] });
  pi.registerFlag("notify", { type: "boolean", default: true, description: subAgentsFlags.notify });
  pi.registerFlag("delegate", { type: "string", default: "when-useful", description: subAgentsFlags.delegate });
  const settings = () => readSettings(name => pi.getFlag(name));
  const state = new SubAgentsState();

  const skill = new SkillFolder();
  let offered = false;

  pi.on("resources_discover", () => {
    const current = settings();
    offered = false;
    if (current.maxSubAgents === 0) return undefined;
    try {
      const path = skill.write(SUB_AGENTS_SKILL, subAgentsSkill(current, state));
      offered = true;
      return { skillPaths: [path] };
    } catch { return undefined; }
  });

  pi.on("session_shutdown", () => { skill.remove(); });

  pi.on("before_agent_start", event => {
    state.newMessage();
    const current = settings();
    return { systemPrompt: `${event.systemPrompt}\n\n${offered ? subAgentsRule(current, state) : subAgentsPrompt(current, state)}` };
  });

  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName !== "sessions" || !record(event.input)) return undefined;
    const { block } = state.prepare(event.input as Record<string, unknown>, settings(), event.toolCallId);
    return block ? { block: true, reason: block } : undefined;
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    const note = state.observe({ toolName: event.toolName, toolCallId: event.toolCallId, input: (event.input ?? {}) as Record<string, unknown>, content: event.content ?? [],
      isError: event.isError === true }, settings());
    if (!note) return undefined;
    return { content: [...(event.content ?? []), { type: "text" as const, text: note }] };
  });
};
