import { parseToolDefinitions, type ToolDefinition } from "../../../packages/shared/src/tool-definitions.js";

export const TOOL_DEFINITIONS_TTL_MS = 60_000;

export class ToolDefinitionsSource {
  #value: readonly ToolDefinition[] | undefined;
  #at = -Infinity;
  #refresh: Promise<readonly ToolDefinition[] | undefined> | undefined;

  constructor(private readonly fetch: () => Promise<unknown>, private readonly now: () => number = Date.now) {}

  async get(): Promise<readonly ToolDefinition[] | undefined> {
    if (this.now() - this.#at < TOOL_DEFINITIONS_TTL_MS) return this.#value;
    this.#refresh ??= this.fetch().then(value => { this.#value = parseToolDefinitions(value); return this.#value; })
      .catch(() => this.#value)
      .finally(() => { this.#at = this.now(); this.#refresh = undefined; });
    return this.#refresh;
  }
}
