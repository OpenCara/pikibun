import { randomUUID } from "node:crypto";
import { CODEMODE_OUTPUT_DIRECTORY } from "../tool-output.js";
import { CodemodeSandbox, type CodemodeResult, type CodemodeRun, type CodemodeRunOptions } from "@earendil-works/pi-codemode";
import type { Extension, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { FileError, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { builtinExtensions, type BuiltinExtensionName } from "../../../../packages/shared/src/host-config.js";

const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
export const CODEMODE_MAX_WORKERS = 8;
export const CODEMODE_SESSION_WORKERS = 2;
export const CODEMODE_COMPUTE_LIMIT_MS = 120_000;
export { CODEMODE_OUTPUT_DIRECTORY };

let codemodeWorkers = 0;

function acquireCodemodeWorker(): () => void {
  if (codemodeWorkers >= CODEMODE_MAX_WORKERS) {
    throw new Error(`This host already runs ${CODEMODE_MAX_WORKERS} code mode scripts; try again once one ends, or call the tools directly.`);
  }
  codemodeWorkers++;
  let released = false;
  return () => { if (!released) { released = true; codemodeWorkers--; } };
}

export class LimitedCodemodeSandbox extends CodemodeSandbox {
  #workers = 0;

  constructor(private readonly computeLimitMs = CODEMODE_COMPUTE_LIMIT_MS) {
    super({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES, acquireWorker: () => {
      if (this.#workers >= CODEMODE_SESSION_WORKERS) {
        throw new Error(`This session already runs ${CODEMODE_SESSION_WORKERS} code mode scripts; try again once one ends, or call the tools directly.`);
      }
      const release = acquireCodemodeWorker();
      this.#workers++;
      let released = false;
      return () => { if (!released) { released = true; this.#workers--; release(); } };
    } });
  }

  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    const limit = this.computeLimitMs;
    const stop = new AbortController();
    let spent = 0;
    let busySince: number | undefined = Date.now();
    let timer: NodeJS.Timeout | undefined;
    let exceeded = false;
    const delivered = new Set<number>();
    let applicable = 0;
    let idleAt = -1;
    const arm = () => {
      clearTimeout(timer);
      if (busySince === undefined) return;
      timer = setTimeout(() => { exceeded = true; stop.abort(new Error("compute limit")); }, Math.max(0, limit - spent));
      timer.unref();
    };
    const idle = () => {
      if (busySince !== undefined) spent += Date.now() - busySince;
      busySince = undefined;
      clearTimeout(timer);
    };
    arm();
    const run = super.start(code, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal,
      onIdle: (seq, issued) => {
        idleAt = Math.max(idleAt, seq);
        if (idleAt >= applicable) idle();
        options.onIdle?.(seq, issued);
      },
    });
    const result = run.result.then((outcome): CodemodeResult => {
      idle();
      if (exceeded && !outcome.ok && outcome.error.kind === "aborted" && !options.signal?.aborted) {
        return { ...outcome, error: { kind: "timeout", message: `Script stopped: it computed for more than ${Math.round(limit / 1000)} seconds. Time its tool calls take doesn't count.` } };
      }
      return outcome;
    });
    return {
      result,
      get finished() { return run.finished; },
      deliver: (seq, now, id, outcome) => {
        run.deliver(seq, now, id, outcome);
        delivered.add(seq);
        while (delivered.has(applicable + 1)) applicable++;
        if (applicable > idleAt && busySince === undefined) { busySince = Date.now(); arm(); }
      },
    };
  }
}

export type OutputFiles = { writeFile(path: string, content: string): Promise<void> };
export type CodemodeOutputs = (api: ToolExecutionApi) => Promise<OutputFiles | undefined>;

function outputEnv(files: OutputFiles): ExecutionEnv {
  const fail = (path: string, error: unknown) => ({ ok: false as const, error: new FileError("unknown", error instanceof Error ? error.message : String(error), path) });
  const env: Partial<ExecutionEnv> = {
    createTempDir: async () => ({ ok: true, value: `${CODEMODE_OUTPUT_DIRECTORY}/${randomUUID().slice(0, 8)}` }),
    writeFile: async (path, content) => {
      if (!path.startsWith(`${CODEMODE_OUTPUT_DIRECTORY}/`)) return fail(path, "Code mode writes only its output");
      if (typeof content !== "string") return fail(path, "Pikibun saves only a script's text output");
      try {
        await files.writeFile(path, content);
        return { ok: true, value: undefined };
      } catch (error) { return fail(path, error); }
    },
  };
  return env as ExecutionEnv;
}

function withOutputs(tool: ToolRegistration, outputs: CodemodeOutputs | undefined): ToolRegistration {
  if (!outputs) return tool;
  return { ...tool, execute: async (args, api, context) => {
    const files = await outputs(api).catch(() => undefined);
    const env = files ? outputEnv(files) : undefined;
    const view = new Proxy(api, { get: (target, key) => {
      if (key === "env") return env;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return tool.execute(args, view, context);
  } } as ToolRegistration;
}

export class SessionBuiltins {
  readonly #sandbox: LimitedCodemodeSandbox;
  readonly extensions: ReadonlyMap<BuiltinExtensionName, Extension>;

  constructor(options: { outputs?: CodemodeOutputs; computeLimitMs?: number } = {}) {
    this.#sandbox = new LimitedCodemodeSandbox(options.computeLimitMs);
    const codemode = createCodemodeExtension({ sandbox: this.#sandbox, models: false });
    this.extensions = new Map([
      ["pi:codemode", { ...codemode, tools: (codemode.tools ?? []).map(tool => withOutputs(tool, options.outputs)) }],
    ]);
  }

  select(enabled: readonly BuiltinExtensionName[], taken: ReadonlySet<string>): { name: BuiltinExtensionName; extension: Extension }[] {
    return builtinExtensions.flatMap(item => {
      const extension = this.extensions.get(item.name);
      const on = ("core" in item && item.core === true) || enabled.includes(item.name);
      return extension && on && !item.tools.some(tool => taken.has(tool)) ? [{ name: item.name, extension }] : [];
    });
  }

  async close(): Promise<void> { await this.#sandbox.close(); }
}
