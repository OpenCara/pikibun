import { parseCliDefinitions, type CliDefinition } from "../../../packages/shared/src/cli-definitions.js";
import { parseToolDefinitions, type ToolDefinition } from "../../../packages/shared/src/tool-definitions.js";

export const TOOL_DEFINITIONS_TTL_MS = 60_000;
const NOTES_LIMIT = 128;

const stderrLog = (line: string) => { process.stderr.write(`${line}\n`); };

export class ToolDefinitionsSource {
  #value: readonly ToolDefinition[] | undefined;
  #clis: readonly CliDefinition[] = [];
  #at = -Infinity;
  #refresh: Promise<readonly ToolDefinition[] | undefined> | undefined;
  #noted = new Set<string>();

  constructor(private readonly fetch: () => Promise<unknown>, private readonly now: () => number = Date.now, private readonly log: (line: string) => void = stderrLog) {}

  #read(value: unknown): void {
    const notes: string[] = [];
    const note = (text: string) => { if (notes.length < NOTES_LIMIT) notes.push(text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500)); };
    try {
      const tools = parseToolDefinitions(value, (name, reason) => note(`the tool ${name || "(without a valid name)"} is passed over, so sessions on this host don't get it: ${reason}`));
      const clis = value && typeof value === "object" ? parseCliDefinitions((value as { clis?: unknown }).clis, (name, reason) => note(name
        ? `the rules for ${name} are passed over, so only this connector's own apply to it: ${reason}`
        : `CLI rules are passed over, so only this connector's own apply: ${reason}`)) : [];
      this.#value = tools;
      this.#clis = clis;
    } catch (error) {
      note(`the answer couldn't be read, so the definitions last read stay: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const text of notes) if (!this.#noted.has(text)) this.log(`Tool definitions from Pikibun: ${text}`);
    this.#noted = new Set(notes);
  }

  async get(): Promise<readonly ToolDefinition[] | undefined> {
    if (this.now() - this.#at < TOOL_DEFINITIONS_TTL_MS) return this.#value;
    this.#refresh ??= this.fetch().then(value => { this.#read(value); return this.#value; })
      .catch(() => this.#value)
      .finally(() => { this.#at = this.now(); this.#refresh = undefined; });
    return this.#refresh;
  }

  async clis(): Promise<readonly CliDefinition[]> {
    await this.get();
    return this.#clis;
  }
}
