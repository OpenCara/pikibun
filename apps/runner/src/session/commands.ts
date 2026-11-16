import { sessionCommandLimits, type SessionCommand } from "../../../../packages/shared/src/session-commands.js";
import { RunnerError } from "../protocol.js";
import type { Run } from "./state.js";

export const COMPACTION_STARTED = "Compaction started. The summary shows here once Pi has written it; a conversation too short to summarize stays as it is.";
export const COMPACTED = "Compacted: the summary of the older messages is in the conversation.";
export const NOTHING_TO_COMPACT = "Nothing to compact: the conversation is still too short to summarize.";
export const COMPACTION_STOPPED = "Compaction stopped before it finished. The conversation is as it was.";
export const compactionFailed = (reason: string) => `Compaction failed: ${reason.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300) || "the model wrote no summary"}. The conversation is as it was.`;
export const ranBefore = (name: string) => `The host stopped while /${name} ran, so whether it finished isn't known. It wasn't run again: send it again if it should be.`;
const shown = (text: string) => text.replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, " ").trim();
export const ACTS = "changes the session, which a side ask or a Read-only message doesn't do: send it as a shared message that may act. Nothing ran.";
export const COMMAND_FILES = "{,*/}{.pi/prompts/*.md,{.pi,.agents}/skills/{*.md,**/SKILL.md}}";
const FILE_LIST_MS = 120_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

export interface CommandFile {
  kind: "prompt" | "skill";
  name: string;
  path: string;
}

export interface SessionCommandsOptions {
  compact(run: Run, instructions: string | undefined): Promise<void>;
  extensionCommands(): Promise<ExtensionCommand[]>;
  runExtensionCommand(run: Run, command: ExtensionCommand, args: string): Promise<{ notices: string[]; messages: string[] }>;
  find(pattern: string, limit: number): Promise<string[]>;
  read(path: string): Promise<string>;
  expansion(): Promise<{
    substitute(content: string, args: string): string;
    body(content: string): string;
    skillName(content: string): string | undefined;
  }>;
  now?(): number;
}

export const WORKTREE_OWNER = "worktree";

export function commandFiles(paths: readonly string[]): CommandFile[] {
  const sorted = [...paths].map(path => path.replace(/\/+$/, "")).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const found: (CommandFile & { owner: string })[] = [];
  const skillRoots: string[] = [];
  const taken = new Set<string>();
  const add = (file: CommandFile, owner: string) => {
    const key = `${owner}\n${file.kind}\n${file.name}`;
    if (!NAME.test(file.name) || taken.has(key)) return;
    taken.add(key);
    found.push({ ...file, owner });
  };
  for (const path of sorted) {
    const parts = path.split("/");
    const file = parts.at(-1)!;
    const at = parts.findIndex((part, index) => (part === ".pi" || part === ".agents") && index <= 1);
    if (at < 0) continue;
    const owner = at === 1 ? parts[0]! : "";
    if (parts[at] === ".pi" && parts[at + 1] === "prompts" && parts.length === at + 3 && file.endsWith(".md")) {
      add({ kind: "prompt", name: file.slice(0, -3), path }, owner);
    } else if (parts[at + 1] === "skills") {
      const directory = parts.slice(0, -1).join("/");
      if (skillRoots.some(root => directory.startsWith(`${root}/`))) continue;
      if (file === "SKILL.md" && parts.length > at + 3) {
        skillRoots.push(directory);
        add({ kind: "skill", name: parts.at(-2)!, path }, owner);
      } else if (parts.length === at + 3 && file.endsWith(".md") && file !== "SKILL.md") add({ kind: "skill", name: file.slice(0, -3), path }, owner);
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const file of found) {
    const key = `${file.kind}\n${file.name}`;
    owners.set(key, (owners.get(key) ?? new Set()).add(file.owner));
  }
  const files: CommandFile[] = [];
  const names = new Set<string>();
  for (const { owner, ...file } of found) {
    const shared = owners.get(`${file.kind}\n${file.name}`)!.size > 1;
    const qualifier = owner || WORKTREE_OWNER;
    if (shared && !NAME.test(qualifier)) continue;
    const name = shared ? `${qualifier}:${file.name}` : file.name;
    const key = `${file.kind}\n${name}`;
    if (names.has(key) || files.filter(item => item.kind === file.kind).length >= sessionCommandLimits.perKind) continue;
    names.add(key);
    files.push({ ...file, name });
  }
  return files;
}

type Expansion = Awaited<ReturnType<SessionCommandsOptions["expansion"]>>;
let expansion: Promise<Expansion> | undefined;

export function piExpansion(): Promise<Expansion> {
  expansion ??= load().catch(error => { expansion = undefined; throw error; });
  return expansion;
}

async function load(): Promise<Expansion> {
  const at = (path: string) => new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
  const templates = await import(at("./core/prompt-templates.js")) as { parseCommandArgs(args: string): string[]; substituteArgs(content: string, args: string[]): string };
  const { parseFrontmatter } = await import(at("./utils/frontmatter.js")) as { parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } };
  const parsed = (content: string) => {
    try { return parseFrontmatter(content); } catch { return { frontmatter: {}, body: content }; }
  };
  return {
    substitute: (content, args) => templates.substituteArgs(content, templates.parseCommandArgs(args)),
    body: content => parsed(content).body,
    skillName: content => {
      const { name } = parsed(content).frontmatter;
      return typeof name === "string" && NAME.test(name) ? name : undefined;
    },
  };
}

const directoryOf = (path: string) => path.split("/").slice(0, -1).join("/") || ".";
const quoted = (value: string) => value.replaceAll("\"", "'");

export class SessionCommands {
  #files: { at: number; list: CommandFile[] } | undefined;
  #scanning: Promise<CommandFile[]> | undefined;

  constructor(private readonly options: SessionCommandsOptions) {}

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private scan(): Promise<CommandFile[]> {
    this.#scanning ??= this.options.find(COMMAND_FILES, sessionCommandLimits.files).then(paths => {
      const list = commandFiles(paths);
      this.#files = { at: this.#now(), list };
      return list;
    }).finally(() => { this.#scanning = undefined; });
    return this.#scanning;
  }

  private listed(): CommandFile[] {
    if (!this.#files || this.#now() - this.#files.at > FILE_LIST_MS) void this.scan().catch(() => {});
    return this.#files?.list ?? [];
  }

  private async found(matches: (file: CommandFile) => boolean): Promise<CommandFile | undefined> {
    return this.#files?.list.find(matches) ?? (await this.scan().catch(() => [] as CommandFile[])).find(matches);
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
    const files = this.listed();
    for (const file of files.filter(item => item.kind === "prompt")) add({ name: file.name, kind: "prompt", description: `Prompt template ${file.path}`, argument: "arguments" });
    for (const file of files.filter(item => item.kind === "skill")) add({ name: `skill:${file.name}`, kind: "skill", description: `Skill ${file.path}`, argument: "arguments" });
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
    const skill = parsed.name.startsWith("skill:") ? parsed.name.slice("skill:".length) : undefined;
    const file = await this.found(item => skill !== undefined ? item.kind === "skill" && item.name === skill : item.kind === "prompt" && item.name === parsed.name);
    if (!file) return text;
    let content: string;
    let expansion: Expansion;
    try {
      content = await this.options.read(file.path);
      expansion = await this.options.expansion();
    } catch { return text; }
    if (file.kind === "prompt") return expansion.substitute(expansion.body(content), parsed.args);
    const block = `<skill name="${quoted(expansion.skillName(content) ?? file.name)}" location="${quoted(file.path)}">\nReferences are relative to ${directoryOf(file.path)}.\n\n${expansion.body(content).trim()}\n</skill>`;
    return parsed.args ? `${block}\n\n${parsed.args}` : block;
  }
}
