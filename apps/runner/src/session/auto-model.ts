import type { AssistantMessage, Context, Message, Models } from "@earendil-works/pi-ai";
import {
  autoRunChoice, dispatchModel, evaluatorLimits, evaluatorPrompt, parseEvaluation, pickEvaluator, ruleEvaluation,
  type AutoEvaluation, type AutoRunChoice,
} from "../../../../packages/shared/src/auto-dispatch.js";
import { thinkingLevels, type AutoModelRequest, type ThinkingLevel } from "../../../../packages/shared/src/types.js";
import { connectorLimits } from "../../../../packages/shared/src/connector.js";

const isLevel = (value: unknown): value is ThinkingLevel => typeof value === "string" && thinkingLevels.includes(value as ThinkingLevel);

/** A message's auto option as the control plane sends it: the models it may run on, as the host advertised them. */
export function autoModelRequest(value: unknown, invalid: (message?: string) => Error): AutoModelRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "candidates")) throw invalid("Invalid Auto choice");
  const { candidates } = value as { candidates?: unknown };
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > connectorLimits.models) throw invalid("Invalid Auto choice");
  return { candidates: candidates.map(item => {
    const model = item as Record<string, unknown>;
    if (!model || typeof model !== "object" || Array.isArray(model)
      || Object.keys(model).some(key => !["provider", "modelId", "name", "thinkingLevels", "thinkingLevel"].includes(key))
      || typeof model.provider !== "string" || !model.provider || model.provider.length > 128
      || typeof model.modelId !== "string" || !model.modelId || model.modelId.length > 256
      || typeof model.name !== "string" || model.name.length > 256
      || (model.thinkingLevels !== undefined && (!Array.isArray(model.thinkingLevels) || !model.thinkingLevels.every(isLevel)))
      || (model.thinkingLevel !== undefined && !isLevel(model.thinkingLevel))) throw invalid("Invalid Auto choice");
    return { provider: model.provider, modelId: model.modelId, name: model.name || model.modelId,
      ...(model.thinkingLevels ? { thinkingLevels: [...model.thinkingLevels as ThinkingLevel[]] } : {}),
      ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel as ThinkingLevel } : {}) };
  }) };
}

export type AutoModels = Pick<Models, "getModel" | "completeSimple">;

export interface AutoInput {
  task: string;
  previous?: string;
  current?: { provider: string; modelId: string; name?: string; thinkingLevel?: ThinkingLevel };
}

export function messageText(content: Message["content"] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? []).flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}

function answerText(message: AssistantMessage): string {
  return message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}

/**
 * Auto mode for one message: the evaluator (the lightest candidate) classifies it by the guide's task kinds, and the
 * dispatch takes the guide's model and effort for that kind among the candidates. Where the evaluator fails, the rules
 * classify it instead; a message is never held back for Auto's sake. Undefined only where no candidate is on this host.
 */
export async function chooseAutoModel(models: AutoModels, request: AutoModelRequest, input: AutoInput,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AutoRunChoice | undefined> {
  const candidates = request.candidates.filter(model => models.getModel(model.provider, model.modelId));
  if (!candidates.length) return undefined;
  const followUpAllowed = input.previous !== undefined && input.current !== undefined;
  const current = followUpAllowed ? input.current : undefined;
  const judge = pickEvaluator(candidates)!;
  let evaluation: AutoEvaluation | undefined;
  let note: string | undefined;
  try {
    const timeoutMs = options.timeoutMs ?? evaluatorLimits.timeoutMs;
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const prompt = evaluatorPrompt({ task: input.task, ...(input.previous ? { previous: input.previous } : {}),
      ...(current ? { current: `${current.name ?? current.modelId}${current.thinkingLevel ? `, ${current.thinkingLevel} reasoning` : ""}` } : {}) });
    const context: Context = { systemPrompt: prompt.systemPrompt, messages: [{ role: "user", content: prompt.message, timestamp: Date.now() }] };
    const answer = await models.completeSimple(models.getModel(judge.model.provider, judge.model.modelId)!, context,
      { signal, timeoutMs, maxRetries: 0, ...(judge.thinkingLevel && judge.thinkingLevel !== "off" ? { reasoning: judge.thinkingLevel } : {}) });
    if (answer.stopReason === "error" || answer.stopReason === "aborted") note = signal.aborted ? "the evaluator didn't answer in time" : "the evaluator failed";
    else {
      evaluation = parseEvaluation(answerText(answer), followUpAllowed);
      if (!evaluation) note = "the evaluator's answer wasn't valid";
    }
  } catch {
    note = "the evaluator failed";
  }
  const by = evaluation ? "evaluator" as const : "rules" as const;
  evaluation ??= ruleEvaluation(input.task, { followUpAllowed });
  const dispatch = dispatchModel(candidates, evaluation, current)!;
  return autoRunChoice(dispatch, evaluation, by, { ...(by === "evaluator" ? { evaluator: judge.model.name } : {}), ...(note ? { note } : {}) });
}
