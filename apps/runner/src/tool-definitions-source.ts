import { parseCliDefinitions, type CliDefinition } from "../../../packages/shared/src/cli-definitions.js";
import { parseToolDefinitions, type ToolDefinition } from "../../../packages/shared/src/tool-definitions.js";

export const TOOL_DEFINITIONS_TTL_MS = 60_000;

export class ToolDefinitionsSource {
  #value: readonly ToolDefinition[] | undefined;
  #clis: readonly CliDefinition[] = [];
  #at = -Infinity;
  #refresh: Promise<readonly ToolDefinition[] | undefined> | undefined;

  constructor(private readonly fetch: () => Promise<unknown>, private readonly now: () => number = Date.now) {}

  async get(): Promise<readonly ToolDefinition[] | undefined> {
    if (this.now() - this.#at < TOOL_DEFINITIONS_TTL_MS) return this.#value;
    this.#refresh ??= this.fetch().then(value => {
      this.#value = parseToolDefinitions(value);
      this.#clis = value && typeof value === "object" ? parseCliDefinitions((value as { clis?: unknown }).clis) : [];
      return this.#value;
    })
      .catch(() => this.#value)
      .finally(() => { this.#at = this.now(); this.#refresh = undefined; });
    return this.#refresh;
  }

  async clis(): Promise<readonly CliDefinition[]> {
    await this.get();
    return this.#clis;
  }
}
