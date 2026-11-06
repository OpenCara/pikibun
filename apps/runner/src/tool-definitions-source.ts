import { parseToolDefinitions, type ToolDefinition } from "../../../packages/shared/src/tool-definitions.js";

/** How long the control plane's tool definitions are used before it is asked again, or not asked after it failed. */
export const TOOL_DEFINITIONS_TTL_MS = 60_000;

/**
 * The tools the control plane defines as data (tool-definitions.ts), as a connector reads them: asked at most once a
 * minute. Where it can't be asked (a control plane that predates them answers 404, or it is out of reach), the last
 * definitions read, or none, so sessions use the ones this version bundles.
 */
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
