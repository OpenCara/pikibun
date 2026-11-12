import { defineExtension, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { bundledToolDefinitions, type ToolDefinition } from "../../../../packages/shared/src/tool-definitions.js";
import { rememberToolDefinitions } from "../defined-tools.js";
import { wholeForScripts } from "../script-output.js";

export interface SessionDefinitionsOptions {
  sessionId: string;
  windows: boolean;
  config: { toolDefinitions?: () => Promise<readonly ToolDefinition[]> };
  tool(definition: ToolDefinition): ToolRegistration;
  registry(): Registry | undefined;
  toolNames(): string[];
  added(tools: ToolRegistration[], names: string[]): void;
}

export class SessionDefinitions {
  #definitions: ToolDefinition[] = [];
  #extensions: Extension[] = [];
  readonly #notes = new Set<string>();

  constructor(private readonly options: SessionDefinitionsOptions) {}

  get definitions(): readonly ToolDefinition[] {
    return this.#definitions;
  }

  get extensions(): readonly Extension[] {
    return this.#extensions;
  }

  #note(name: string, what: string): void {
    const note = `${name} ${what}`;
    if (this.#notes.has(note)) return;
    this.#notes.add(note);
    process.stderr.write(`Session ${this.options.sessionId}: the tool definition ${note}.\n`);
  }

  async fetch(): Promise<readonly ToolDefinition[]> {
    const config = this.options.config;
    const fetched = config.toolDefinitions ? await config.toolDefinitions().catch(() => undefined) : undefined;
    if (fetched) rememberToolDefinitions(fetched);
    return fetched ?? bundledToolDefinitions;
  }

  usable(definitions: readonly ToolDefinition[], own: readonly string[]): ToolDefinition[] {
    const windows = this.options.windows;
    const taken = new Set(own);
    return definitions.filter(definition => {
      if (taken.has(definition.name) || (definition.kind === "program" && windows && !definition.windowsSandbox)) return false;
      taken.add(definition.name);
      return true;
    });
  }

  async load(own: readonly string[]): Promise<ToolRegistration[]> {
    this.#definitions = this.usable(await this.fetch(), own);
    this.#extensions = [];
    return this.#definitions.map(definition => wholeForScripts(this.options.tool(definition)));
  }

  async refresh(extensionTools: readonly string[] = []): Promise<void> {
    if (!this.options.config.toolDefinitions || !this.options.registry()) return;
    const fetched = await this.fetch();
    for (const definition of fetched) {
      const had = this.#definitions.find(item => item.name === definition.name);
      if (had && JSON.stringify(had) !== JSON.stringify(definition)) this.#note(definition.name, "changed; the session uses it as it was until it next opens");
      else if (!had && extensionTools.includes(definition.name)) this.#note(definition.name, "is offered by one of the workspace's extensions, which keeps it");
    }
    const added = this.usable(fetched, [...this.options.toolNames(), ...extensionTools]);
    if (!added.length) return;
    const tools = added.map(definition => wholeForScripts(this.options.tool(definition)));
    const extension = defineExtension({ name: `defined-tools-${this.#extensions.length + 1}`, tools });
    this.options.registry()!.install(extension);
    this.#extensions.push(extension);
    this.#definitions.push(...added);
    this.options.added(tools, added.map(definition => definition.name));
  }
}
