import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { Extension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
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

/** One session's built-in extensions: each made once, installed in its registry, and selected per message as the host's configuration says. */
export class SessionBuiltins {
  readonly #sandbox = new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES, acquireWorker: acquireCodemodeWorker });
  /**
   * In the catalog's order. Scripts get no `models.*`: that would let them call the host's models, classifiers and
   * image generation outside the session's own model choice.
   */
  readonly extensions: ReadonlyMap<BuiltinExtensionName, Extension> = new Map([
    ["codemode", createCodemodeExtension({ sandbox: this.#sandbox, models: false })],
  ]);

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
