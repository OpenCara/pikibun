import { randomUUID } from "node:crypto";
import { CodemodeSandbox, type CodemodeResult, type CodemodeRun, type CodemodeRunOptions } from "@earendil-works/pi-codemode";
import type { Extension, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { FileError, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { builtinExtensions, type BuiltinExtensionName } from "../../../../packages/shared/src/host-config.js";

/*
 * Pi's built-in extensions, as a host's configuration turns them on (HostConfig.builtinExtensions,
 * docs/design/host-extensions.md). Pikibun runs pi-durable's own versions rather than pi-coding-agent's: those call other
 * tools through the coding agent's loop, which Pikibun doesn't run, while pi-durable's run each call through the
 * session's harness, where it is permitted, approved and recorded like the model's own calls, and survive a restart.
 */

/** Heap of one script's QuickJS VM, as in Pi: a runaway script fails with "out of memory" instead of growing the connector. */
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/**
 * Scripts that run at once in this connector, all its sessions together: each holds a worker thread and its VM, also while
 * it waits for a call's approval. Another is refused until one ends.
 */
export const CODEMODE_MAX_WORKERS = 8;
/** Scripts one session runs at once, so a session whose scripts wait on approvals leaves the rest of the host's to others. */
export const CODEMODE_SESSION_WORKERS = 2;
/**
 * How long a script's VM may compute, in all: from its start, and from each result it is handed, until it waits again.
 * Time its calls take, approvals included, doesn't count, so a script that waits on a person isn't cut off, while one
 * that spins (`while (true) {}`) ends here instead of holding its worker and a CPU for good. Scripts can't raise it.
 */
export const CODEMODE_COMPUTE_LIMIT_MS = 120_000;
/** Where scripts' full output and images go, in the worktree, for read_file. */
export const CODEMODE_OUTPUT_DIRECTORY = "codemode-output";

let codemodeWorkers = 0;

/** Reserves one of the connector's script workers, or refuses the script. */
function acquireCodemodeWorker(): () => void {
  if (codemodeWorkers >= CODEMODE_MAX_WORKERS) {
    throw new Error(`This host already runs ${CODEMODE_MAX_WORKERS} code mode scripts; try again once one ends, or call the tools directly.`);
  }
  codemodeWorkers++;
  let released = false;
  return () => { if (!released) { released = true; codemodeWorkers--; } };
}

/**
 * One session's code mode sandbox: at most CODEMODE_SESSION_WORKERS scripts at once of the connector's, and each script's
 * VM stopped once it has computed for `computeLimitMs`, which ends the script as a time-out.
 */
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
    // The VM computes until it reports itself idle after the last result it can apply: results apply in order, so one
    // handed over after a gap waits for the missing one.
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
      // A run this stopped ends as a time-out, which the code mode tool records as the script's error, not as a sandbox
      // closed under it (an abort it didn't make), which it would wait out.
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

/** Writes a text file at a path relative to the worktree, under the file tools' rules. */
export type OutputFiles = { writeFile(path: string, content: string): Promise<void> };
/**
 * Where a code mode call writes its full output: files in the worktree's CODEMODE_OUTPUT_DIRECTORY, which read_file reads;
 * or, where `undefined`, nowhere (the result says it couldn't save it).
 */
export type CodemodeOutputs = (api: ToolExecutionApi) => Promise<OutputFiles | undefined>;

/**
 * The environment a code mode call gets: only the two file operations its output needs, into the worktree. Its full text
 * output is saved; images still reach the model, but aren't saved as files (the result says so).
 */
function outputEnv(files: OutputFiles): ExecutionEnv {
  const fail = (path: string, error: unknown) => ({ ok: false as const, error: new FileError("unknown", error instanceof Error ? error.message : String(error), path) });
  const env: Partial<ExecutionEnv> = {
    // A directory of the call's own: its files' names are fresh, so the paths the result names are theirs.
    createTempDir: async () => ({ ok: true, value: `${CODEMODE_OUTPUT_DIRECTORY}/${randomUUID().slice(0, 8)}` }),
    writeFile: async (path, content) => {
      if (!path.startsWith(`${CODEMODE_OUTPUT_DIRECTORY}/`)) return fail(path, "Code mode writes only its output");
      if (typeof content !== "string") return fail(path, "Pikibun saves only a script's text output");
      try {
        // A rerun after a restart writes the same file again, with the same content.
        await files.writeFile(path, content);
        return { ok: true, value: undefined };
      } catch (error) { return fail(path, error); }
    },
  };
  return env as ExecutionEnv;
}

/** `tool`, with the output environment of `outputs` in place of the harness's (which Pikibun doesn't give). */
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

/** One session's built-in extensions: each made once, installed in its registry, and selected per message as the host's configuration says. */
export class SessionBuiltins {
  readonly #sandbox: LimitedCodemodeSandbox;
  /**
   * In the catalog's order. Scripts get no `models.*`: that would let them call the host's models, classifiers and
   * image generation outside the session's own model choice.
   */
  readonly extensions: ReadonlyMap<BuiltinExtensionName, Extension>;

  constructor(options: { outputs?: CodemodeOutputs; computeLimitMs?: number } = {}) {
    this.#sandbox = new LimitedCodemodeSandbox(options.computeLimitMs);
    const codemode = createCodemodeExtension({ sandbox: this.#sandbox, models: false });
    this.extensions = new Map([
      ["codemode", { ...codemode, tools: (codemode.tools ?? []).map(tool => withOutputs(tool, options.outputs)) }],
    ]);
  }

  /**
   * The extensions of `enabled` a message runs with. One steps aside where an extension of the workspace offers a tool
   * by its name (`taken`), as Pi's built-ins do when an extension replaces them.
   */
  select(enabled: readonly BuiltinExtensionName[], taken: ReadonlySet<string>): { name: BuiltinExtensionName; extension: Extension }[] {
    return builtinExtensions.flatMap(item => {
      const extension = this.extensions.get(item.name);
      return extension && enabled.includes(item.name) && !item.tools.some(tool => taken.has(tool)) ? [{ name: item.name, extension }] : [];
    });
  }

  /** Stops the session's running scripts; a script stopped this way resumes with the session's next sandbox. */
  async close(): Promise<void> { await this.#sandbox.close(); }
}
