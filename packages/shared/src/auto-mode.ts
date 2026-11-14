import type { ConnectorInfo, LocalModelSummary } from "./connector.js";
import { thinkingLevels, type ThinkingLevel } from "./types.js";

export const AUTO_MODE_SOURCE = "piki:auto-mode";
export const AUTO_TASK_LIMIT = 32_000;

export function autoModeOn(extensions: readonly { source: string; enabled: boolean }[]): boolean {
  return extensions.some(item => item.source === AUTO_MODE_SOURCE && item.enabled);
}

export const taskComplexities = ["simple", "moderate", "complex"] as const;
export type TaskComplexity = (typeof taskComplexities)[number];

export interface TaskAssessment {
  complexity: TaskComplexity;
  score: number;
  signals: string[];
  gpu: boolean;
}

interface Term { pattern: RegExp; weight: number; signal: string }

const terms: readonly Term[] = [
  { pattern: /\barchitect/i, weight: 2, signal: "architecture" },
  { pattern: /\b(re)?design(s|ing)?\b/i, weight: 2, signal: "design" },
  { pattern: /\brefactor/i, weight: 2, signal: "a refactor" },
  { pattern: /\bmigrat/i, weight: 2, signal: "a migration" },
  { pattern: /\brewrit/i, weight: 2, signal: "a rewrite" },
  { pattern: /\bfrom scratch\b/i, weight: 2, signal: "from scratch" },
  { pattern: /\bimplement/i, weight: 1, signal: "an implementation" },
  { pattern: /\b(concurren|race condition|deadlock|thread[- ]safe)/i, weight: 2, signal: "concurrency" },
  { pattern: /\b(security|vulnerab|exploit|authenticat|authoriz|encrypt)/i, weight: 2, signal: "security" },
  { pattern: /\b(performance|optimi[sz]|latency|memory leak|profil)/i, weight: 2, signal: "performance" },
  { pattern: /\b(debug|investigat|root cause|diagnos)/i, weight: 2, signal: "an investigation" },
  { pattern: /\b(distributed|scalab|scaling|cluster)/i, weight: 2, signal: "scale" },
  { pattern: /\b(algorithm|protocol|compiler|parser)/i, weight: 2, signal: "algorithms" },
  { pattern: /\b(end[- ]to[- ]end|integrat)/i, weight: 1, signal: "integration" },
  { pattern: /\b(across|throughout|entire|whole)\b[^.\n]{0,200}\b(codebase|repo|repository|repositories|project|files|modules|services)\b/i, weight: 2, signal: "the whole codebase" },
  { pattern: /\b(multiple|several|many)\b/i, weight: 1, signal: "several parts" },
  { pattern: /\b(complex|hard|difficult|large|big|major|deep|thorough|comprehensive|carefully)\b/i, weight: 2, signal: "asks for depth" },
  { pattern: /\b(add|create|build|support|feature|endpoint|extension|plugin)\b/i, weight: 1, signal: "a feature" },
  { pattern: /\b(dropdown|button|screen|form|page|ui|component|dialog)\b/i, weight: 1, signal: "interface work" },
  { pattern: /\b(fix|bug|error|fails?|failing|broken|crash)/i, weight: 1, signal: "a fix" },
  { pattern: /\b(tests?|testing|spec)\b/i, weight: 1, signal: "tests" },
  { pattern: /\b(typo|spelling|grammar)/i, weight: -2, signal: "a typo" },
  { pattern: /\brename\b/i, weight: -1, signal: "a rename" },
  { pattern: /\b(explain|summari[sz]e|describe|list|show me|tell me|look up|translate)\b/i, weight: -2, signal: "a question" },
  { pattern: /\b(readme|changelog|comment|bump)\b/i, weight: -1, signal: "docs" },
  { pattern: /\b(quick|small|simple|tiny|minor|trivial|one[- ]line)\b/i, weight: -2, signal: "says it is small" },
];

const QUESTION = /^\s*(what|why|how|where|who|when|which|is|are|does|do|can|could|should)\b[^\n]*\?\s*$/i;
const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/;
const FILE_NAME = /^[\w./-]{0,200}\.(ts|tsx|js|jsx|mjs|py|rs|go|java|kt|swift|cs|cpp|cc|c|h|rb|php|sql|ya?ml|json|toml|md)$/i;
const TOKEN_EDGES = /^[^\w./-]+|[^\w./-]+$/g;

function fileNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const word of text.split(/\s+/)) {
    if (word.length > 256) continue;
    const token = word.replace(TOKEN_EDGES, "").replace(/[.]+$/, "");
    if (FILE_NAME.test(token)) names.add(token.toLowerCase());
  }
  return names;
}
const GPU = /\b(gpus?|cuda|nvidia|rocm|tpu|pytorch|tensorflow|jax|fine[- ]?tun\w*|train(ing)?\s+(a\s+|the\s+)?models?|inference)\b/i;

export function assessTask(task: string): TaskAssessment {
  const text = task.slice(0, AUTO_TASK_LIMIT).trim();
  if (!text) return { complexity: "moderate", score: 2, signals: ["no task yet"], gpu: false };
  const signals: string[] = [];
  let score = 1;
  const words = text.split(/\s+/).filter(Boolean).length;
  const length = words > 200 ? 3 : words > 80 ? 2 : words > 35 ? 1 : 0;
  if (length) { score += length; signals.push(words > 80 ? "a long description" : "a detailed description"); }
  const items = text.split("\n").filter(line => LIST_ITEM.test(line)).length;
  if (items >= 3) { score += items >= 8 ? 2 : 1; signals.push(`${items} listed points`); }
  const ands = text.match(/\band\b/gi)?.length ?? 0;
  if (ands >= 3) { score += 1; signals.push("several requirements"); }
  if (text.includes("```")) { score += 1; signals.push("code"); }
  const files = fileNames(text);
  if (files.size >= 3) { score += 1; signals.push(`${files.size} files`); }
  if (QUESTION.test(text) && words <= 30) { score -= 1; signals.push("a short question"); }
  for (const term of terms) {
    if (!term.pattern.test(text)) continue;
    score += term.weight;
    signals.push(term.signal);
  }
  const complexity: TaskComplexity = score <= 0 ? "simple" : score >= 5 ? "complex" : "moderate";
  return { complexity, score, signals, gpu: GPU.test(text) };
}

export type ModelTier = 1 | 2 | 3;
export const modelTierLabels: Record<ModelTier, string> = { 1: "light", 2: "standard", 3: "frontier" };

const LIGHT = /\b(mini|nano|haiku|lite|small|tiny|micro|instant|flash-lite)\b/;
const FRONTIER = /\b(opus|pro|ultra|o1|o3|o4|gpt-5|grok-4|r1|reasoner|large|max|deep-?think)\b/;
const PARAMETERS = /\b(\d+(?:\.\d+)?)b\b/;

export function modelTier(model: Pick<LocalModelSummary, "modelId" | "name">): ModelTier {
  const text = `${model.modelId} ${model.name}`.toLowerCase();
  if (LIGHT.test(text)) return 1;
  const parameters = PARAMETERS.exec(text);
  if (parameters) {
    const billions = Number(parameters[1]);
    if (billions <= 14) return 1;
    if (billions >= 100) return 3;
  }
  return FRONTIER.test(text) ? 3 : 2;
}

export function modelVersion(model: Pick<LocalModelSummary, "modelId">): number {
  const match = /(\d+(?:\.\d+)?)/.exec(model.modelId);
  return match ? Math.min(Number(match[1]), 100) : 0;
}

const reasons = (model: LocalModelSummary) => (model.thinkingLevels ?? []).some(level => level !== "off");

const targetTier: Record<TaskComplexity, ModelTier> = { simple: 1, moderate: 2, complex: 3 };
const targetLevel: Record<TaskComplexity, ThinkingLevel> = { simple: "low", moderate: "medium", complex: "high" };

function tierCost(tier: ModelTier, complexity: TaskComplexity): number {
  const target = targetTier[complexity];
  return tier < target ? (target - tier) * 3 : tier - target;
}

export function autoThinkingLevel(model: LocalModelSummary, complexity: TaskComplexity): ThinkingLevel | undefined {
  const levels = model.thinkingLevels;
  if (!levels?.length) return undefined;
  const wanted = targetLevel[complexity];
  if (levels.includes(wanted)) return wanted;
  const rank = thinkingLevels.indexOf(wanted);
  const lower = levels.filter(level => level !== "off" && thinkingLevels.indexOf(level) <= rank)
    .sort((a, b) => thinkingLevels.indexOf(b) - thinkingLevels.indexOf(a))[0];
  if (lower) return lower;
  const higher = levels.filter(level => thinkingLevels.indexOf(level) > rank).sort((a, b) => thinkingLevels.indexOf(a) - thinkingLevels.indexOf(b))[0];
  return complexity === "simple" && levels.includes("off") ? "off" : higher ?? levels[0];
}

export function rankModels(models: readonly LocalModelSummary[], complexity: TaskComplexity): LocalModelSummary[] {
  return models.map((model, index) => ({ model, index, cost: tierCost(modelTier(model), complexity) }))
    .sort((a, b) => a.cost - b.cost
      || (complexity === "complex" ? Number(reasons(b.model)) - Number(reasons(a.model)) : 0)
      || modelVersion(b.model) - modelVersion(a.model)
      || a.index - b.index)
    .map(item => item.model);
}

export interface AutoChoiceInput {
  task: string;
  userId: string;
  workspaceId: string;
  hosts: readonly ConnectorInfo[];
  working?: Readonly<Record<string, number>>;
  usable?: (host: ConnectorInfo, model: LocalModelSummary) => boolean;
  connectorId?: string;
  model?: { provider: string; modelId: string };
}

export interface AutoChoice {
  connectorId: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  complexity: TaskComplexity;
  reasons: string[];
}

export interface AutoChoiceRequest {
  task: string;
  connectorId?: string;
  model?: { provider: string; modelId: string };
}

export interface AutoChoiceAnswer extends AutoChoice {
  id?: string;
}

const BUSY_PENALTY = 1.5;
const BUSY_CAP = 6;

function hostUsable(host: ConnectorInfo, input: AutoChoiceInput): boolean {
  return host.online && !host.revokedAt && (host.ownerId === input.userId || host.workspaceIds.includes(input.workspaceId));
}

export function autoChoice(input: AutoChoiceInput): AutoChoice | undefined {
  const assessment = assessTask(input.task);
  const { complexity } = assessment;
  const candidates = input.hosts.flatMap((host, index) => {
    if (input.connectorId !== undefined && host.id !== input.connectorId) return [];
    if (!hostUsable(host, input)) return [];
    const models = host.models.filter(model => (!input.model || (model.provider === input.model.provider && model.modelId === input.model.modelId))
      && (input.usable?.(host, model) ?? true));
    const model = rankModels(models, complexity)[0];
    if (!model) return [];
    const own = host.ownerId === input.userId;
    const working = Math.max(0, input.working?.[host.id] ?? 0);
    let score = -10 * tierCost(modelTier(model), complexity) + modelVersion(model) * 0.01;
    if (own) score += 3;
    if (host.capabilities.unsandboxed) score -= 2;
    else if (!host.capabilities.sandbox) score -= 1;
    if (assessment.gpu) score += host.capabilities.gpu ? 6 : -4;
    score -= BUSY_PENALTY * Math.min(working, BUSY_CAP);
    return [{ host, model, own, working, score, index }];
  });
  const best = candidates.sort((a, b) => b.score - a.score || a.index - b.index)[0];
  if (!best) return undefined;
  const thinkingLevel = autoThinkingLevel(best.model, complexity);
  const shown = assessment.signals.slice(0, 3);
  const hostParts = [best.own ? "your host" : `${best.host.ownerName}'s host, shared here`, best.working ? "busy" : "idle"];
  if (assessment.gpu && best.host.capabilities.gpu) hostParts.push("has a GPU");
  if (input.connectorId === undefined && candidates.length > 1) hostParts.push(`best of ${candidates.length} hosts`);
  return {
    connectorId: best.host.id,
    provider: best.model.provider,
    modelId: best.model.modelId,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    complexity,
    reasons: [
      `The task looks ${complexity}${shown.length ? ` (${shown.join(", ")})` : ""}.`,
      `${best.host.name}: ${hostParts.join(", ")}.`,
      `${best.model.name}: a ${modelTierLabels[modelTier(best.model)]} model${thinkingLevel ? `, with ${thinkingLevel} reasoning` : ""}.`,
    ],
  };
}
