import type { ThinkingLevel } from "../../shared/src/types";
import { levelLabels } from "./chat-options";

export type SlashCommandName = "model" | "thinking" | "name" | "new" | "clone" | "copy" | "session" | "settings";

export interface SlashCommand {
  name: SlashCommandName;
  description: string;
  argument?: string;
  lists?: true;
}

export const slashCommands: readonly SlashCommand[] = [
  { name: "model", description: "Choose the model for your next messages", argument: "provider/model", lists: true },
  { name: "thinking", description: "Set the reasoning level for your next messages", argument: "level", lists: true },
  { name: "name", description: "Rename this session", argument: "title" },
  { name: "new", description: "Start a new session in this workspace" },
  { name: "clone", description: "Fork a new session from the agent's latest reply" },
  { name: "copy", description: "Copy the agent's latest reply" },
  { name: "session", description: "Show this session's details" },
  { name: "settings", description: "Open settings" },
];

export interface SlashModel {
  provider: string;
  modelId: string;
  name: string;
}

export interface SlashDraft {
  name: string;
  argument: string;
  naming: boolean;
}

export function parseSlashDraft(draft: string): SlashDraft | undefined {
  if (!draft.startsWith("/") || /[\r\n]/.test(draft.trimEnd())) return undefined;
  const space = draft.search(/\s/);
  return {
    name: (space < 0 ? draft.slice(1) : draft.slice(1, space)).toLowerCase(),
    argument: space < 0 ? "" : draft.slice(space + 1).trim(),
    naming: space < 0,
  };
}

export function slashCommand(draft: string): { command: SlashCommand; argument: string } | undefined {
  const parsed = parseSlashDraft(draft);
  const command = parsed && slashCommands.find(item => item.name === parsed.name);
  return command ? { command, argument: parsed!.argument } : undefined;
}

export interface SlashSuggestion {
  key: string;
  label: string;
  hint: string;
  draft: string;
  runs: boolean;
}

export interface SlashOffer {
  commands: readonly SlashCommandName[];
  models: readonly SlashModel[];
  levels: readonly ThinkingLevel[];
}

const modelReference = (model: SlashModel) => `${model.provider}/${model.modelId}`;
const plain = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");

export function slashSuggestions(draft: string, offer: SlashOffer): SlashSuggestion[] {
  const parsed = parseSlashDraft(draft);
  if (!parsed) return [];
  if (parsed.naming) {
    return slashCommands.filter(command => offer.commands.includes(command.name) && command.name.startsWith(parsed.name)).map(command => ({
      key: command.name,
      label: command.argument ? `/${command.name} [${command.argument}]` : `/${command.name}`,
      hint: command.description,
      draft: command.argument ? `/${command.name} ` : `/${command.name}`,
      runs: !command.lists,
    }));
  }
  if (!offer.commands.some(name => name === parsed.name)) return [];
  const typed = parsed.argument.toLowerCase();
  if (parsed.name === "model") {
    const rank = (model: SlashModel) => (modelReference(model).toLowerCase() === typed ? 0
      : model.modelId.toLowerCase() === typed || model.name.toLowerCase() === typed ? 1 : 2);
    return offer.models.filter(model => modelReference(model).toLowerCase().includes(typed) || model.name.toLowerCase().includes(typed))
      .map((model, index) => ({ model, index })).sort((a, b) => rank(a.model) - rank(b.model) || a.index - b.index)
      .map(({ model }) => ({ key: modelReference(model), label: model.name, hint: modelReference(model), draft: `/model ${modelReference(model)}`, runs: true }));
  }
  if (parsed.name === "thinking") {
    return offer.levels.filter(level => plain(level).startsWith(plain(typed)) || plain(levelLabels[level]).startsWith(plain(typed))).map(level => ({
      key: level, label: levelLabels[level], hint: level, draft: `/thinking ${level}`, runs: true,
    }));
  }
  return [];
}

export function slashModel<T extends SlashModel>(models: readonly T[], argument: string): { model: T } | { error: string } {
  const typed = argument.trim().toLowerCase();
  if (!typed) return { error: "Name a model after /model, such as /model provider/model." };
  const exact = models.filter(model => modelReference(model).toLowerCase() === typed);
  const named = exact.length ? exact : models.filter(model => model.modelId.toLowerCase() === typed || model.name.toLowerCase() === typed);
  const found = named.length ? named : models.filter(model => modelReference(model).toLowerCase().includes(typed) || model.name.toLowerCase().includes(typed));
  if (found.length === 1) return { model: found[0]! };
  if (!found.length) return { error: `This session's host offers no model matching "${argument.trim()}".` };
  const listed = found.slice(0, 5).map(modelReference).join(", ");
  return { error: `"${argument.trim()}" matches ${found.length} models (${listed}${found.length > 5 ? ", …" : ""}). Type more of its name.` };
}

export function slashLevel(levels: readonly ThinkingLevel[], argument: string): ThinkingLevel | undefined {
  const typed = plain(argument);
  return typed ? levels.find(level => plain(level) === typed || plain(levelLabels[level]) === typed) : undefined;
}
