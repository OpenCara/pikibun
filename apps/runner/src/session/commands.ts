import { sessionCommandLimits, type SessionCommand } from "../../../../packages/shared/src/session-commands.js";
import { RunnerError } from "../protocol.js";
import { inPiOrder, ownerOf, qualifiedNames } from "./names.js";
import type { PiText } from "./pi-text.js";
import type { Skill } from "./skills.js";
import type { Run } from "./state.js";

export const COMPACTION_STARTED = "Compaction started. The summary shows here once Pi has written it; a conversation too short to summarize stays as it is.";
export const COMPACTED = "Compacted: the summary of the older messages is in the conversation.";
export const NOTHING_TO_COMPACT = "Nothing to compact: the conversation is still too short to summarize.";
export const COMPACTION_STOPPED = "Compaction stopped before it finished. The conversation is as it was.";
export const compactionFailed = (reason: string) => `Compaction failed: ${reason.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300) || "the model wrote no summary"}. The conversation is as it was.`;
export const ranBefore = (name: string) => `The host stopped while /${name} ran, so whether it finished isn't known. It wasn't run again: send it again if it should be.`;
const shown = (text: string) => text.replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, " ").trim();
export const ACTS = "changes the session, which a side ask or a Read-only message doesn't do: send it as a shared message that may act. Nothing ran.";
export const PROMPT_FILES = "{,*/}.pi/prompts/*.md";
const FILE_LIST_MS = 120_000;

export interface ParsedCommand {
  name: string;
  args: string;
}

export function parseCommand(content: string): ParsedCommand | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9:._-]{0,127})(?:\s+([\s\S]*))?$/.exec(content);
  return match ? { name: match[1]!, args: (match[2] ?? "").trim() } : undefined;
}

export type CommandOutcome =
  | { action: "command"; name: string; notice: string }
  | { action: "refused"; by: string; notice: string }
  | { action: "message"; text: string };

export interface ExtensionCommand {
  source: string;
  name: string;
  description?: string;
}

export interface PromptFile {
  name: string;
  path: string;
}

export interface SessionCommandsOptions {
  compact(run: Run, instructions: string | undefined): Promise<void>;
  extensionCommands(): Promise<ExtensionCommand[]>;
  runExtensionCommand(run: Run, command: ExtensionCommand, args: string): Promise<{ notices: string[]; messages: string[] }>;
  find(pattern: string, limit: number): Promise<string[]>;
  read(path: string): Promise<string>;
  text(): Promise<PiText>;
  skills: { listed(): Skill[]; expand(name: string, args: string): Promise<string | undefined> };
  now?(): number;
}

export function promptFiles(paths: readonly string[]): PromptFile[] {
  const found: (PromptFile & { owner: string })[] = [];
  for (const path of inPiOrder(paths)) {
    const parts = path.split("/");
    const file = parts.at(-1)!;
    const at = parts.findIndex((part, index) => part === ".pi" && index <= 1);
    if (at < 0 || parts[at + 1] !== "prompts" || parts.length !== at + 3 || !file.endsWith(".md")) continue;
    found.push({ name: file.slice(0, -3), path, owner: ownerOf(parts, at) });
  }
  return qualifiedNames(found);
}

export class SessionCommands {
  #files: { at: number; list: PromptFile[] } | undefined;
  #scanning: Promise<PromptFile[]> | undefined;

  constructor(private readonly options: SessionCommandsOptions) {}

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private scan(): Promise<PromptFile[]> {
    this.#scanning ??= this.options.find(PROMPT_FILES, sessionCommandLimits.files).then(paths => {
      const list = promptFiles(paths);
      this.#files = { at: this.#now(), list };
      return list;
    }).finally(() => { this.#scanning = undefined; });
    return this.#scanning;
  }

  private listed(): PromptFile[] {
    if (!this.#files || this.#now() - this.#files.at > FILE_LIST_MS) void this.scan().catch(() => {});
    return this.#files?.list ?? [];
  }

  private async found(name: string): Promise<PromptFile | undefined> {
    const matches = (file: PromptFile) => file.name === name;
    return this.#files?.list.find(matches) ?? (await this.scan().catch(() => [] as PromptFile[])).find(matches);
  }

  async list(): Promise<SessionCommand[]> {
    const commands: SessionCommand[] = [{ name: "compact", kind: "host", description: "Summarize the older messages now, to free the model's context", argument: "instructions" }];
    const taken = new Set(commands.map(command => command.name));
    const add = (command: SessionCommand) => {
      if (taken.has(command.name) || commands.length >= sessionCommandLimits.commands) return;
      taken.add(command.name);
      commands.push(command);
    };
    for (const command of await this.options.extensionCommands().catch(() => [])) {
      add({ name: command.name, kind: "extension", description: (command.description || `A command of ${command.source}`).slice(0, sessionCommandLimits.description) });
    }
    for (const file of this.listed()) add({ name: file.name, kind: "prompt", description: `Prompt template ${file.path}`, argument: "arguments" });
    for (const skill of this.options.skills.listed()) {
      add({ name: `skill:${skill.name}`, kind: "skill", description: (skill.description ?? `Skill ${skill.path}`).slice(0, sessionCommandLimits.description), argument: "arguments" });
    }
    return commands;
  }

  async before(run: Run, first: () => Promise<boolean> = async () => true): Promise<CommandOutcome | undefined> {
    const parsed = parseCommand(run.content);
    if (!parsed) return undefined;
    const acts = run.mode === "write" && run.options?.access !== "read";
    if (parsed.name === "compact") {
      if (!acts) return { action: "refused", by: "", notice: `/compact ${ACTS}` };
      if (!await first()) return { action: "command", name: "compact", notice: ranBefore("compact") };
      try { await this.options.compact(run, parsed.args || undefined); }
      catch (error) {
        return { action: "refused", by: "", notice: error instanceof RunnerError ? error.message : "The host couldn't start compacting this conversation. Try again shortly." };
      }
      return { action: "command", name: "compact", notice: COMPACTION_STARTED };
    }
    const command = (await this.options.extensionCommands()).find(item => item.name === parsed.name);
    if (!command) return undefined;
    if (!acts) return { action: "refused", by: command.source, notice: `/${command.name} is a command of an extension (${command.source}), which ${ACTS}` };
    if (!await first()) return { action: "command", name: command.name, notice: ranBefore(command.name) };
    try {
      const { notices, messages } = await this.options.runExtensionCommand(run, command, parsed.args);
      const text = messages.map(message => message.trim()).filter(Boolean).join("\n\n");
      if (text) return { action: "message", text };
      return { action: "command", name: command.name, notice: notices.map(shown).filter(Boolean).join("\n").slice(0, sessionCommandLimits.notice) || "It ran, and said nothing." };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { action: "refused", by: command.source,
        notice: error instanceof RunnerError ? reason : `/${command.name} (${command.source}) failed: ${reason.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 300)}` };
    }
  }

  async expand(text: string): Promise<string> {
    const parsed = parseCommand(text);
    if (!parsed) return text;
    if (parsed.name.startsWith("skill:")) return await this.options.skills.expand(parsed.name.slice("skill:".length), parsed.args) ?? text;
    const file = await this.found(parsed.name);
    if (!file) return text;
    try {
      const content = await this.options.read(file.path);
      const { substitute, frontmatter } = await this.options.text();
      return substitute(frontmatter(content).body, parsed.args);
    } catch { return text; }
  }
}
