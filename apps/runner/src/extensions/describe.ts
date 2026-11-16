import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionModuleSummary } from "../../../../packages/shared/src/host-extensions.js";
import type { RunnerBinding } from "../../../../packages/shared/src/types.js";
import { Sandbox } from "../sandbox.js";
import { serviceLimits, serviceSocketDirectory } from "../session-service.js";
import { HelperWorkspace, type HelperBackend } from "../helper-workspace.js";
import { confinedLaunch, ProcessChannel, sandboxLaunch } from "./process.js";

export interface DescribedSource { root: string; files: string[]; mount?: string }
export type Describe = (source: DescribedSource) => Promise<ExtensionModuleSummary[]>;

export const DESCRIBE_TIMEOUT_MS = 60_000;
const DESCRIBE_SESSION = "extension-describe";

export async function describeThrough(channel: ProcessChannel, source: DescribedSource, timeoutMs = DESCRIBE_TIMEOUT_MS): Promise<ExtensionModuleSummary[]> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const reason = `It took longer than ${timeoutMs / 1000} seconds to describe`;
      channel.restart(reason);
      reject(new Error(reason));
    }, timeoutMs);
  });
  const answer = channel.call("describe", source).then(result => result.value);
  answer.catch(() => {});
  try { return await Promise.race([answer, late]); }
  finally {
    clearTimeout(timer);
    const closing = channel.close().catch(() => {});
    if (!timedOut) await closing;
  }
}

export const processDescribe: Describe = async source => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-describe-"));
  try { return await describeThrough(new ProcessChannel({ directory, warn: () => {} }), source); }
  finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
};

const describeBinding = (): RunnerBinding => {
  const owner = "pikibun:host";
  return { session: { id: DESCRIBE_SESSION, ownerId: owner }, owner: { id: owner, githubLogin: null, gitName: "Pikibun", gitEmail: "pikibun@localhost", env: {} },
    model: { provider: "none" } } as unknown as RunnerBinding;
};

function queued(describe: Describe): Describe {
  let queue: Promise<unknown> = Promise.resolve();
  return source => {
    const next = queue.then(() => describe(source));
    queue = next.catch(() => {});
    return next;
  };
}

export function helperDescribe(stateDirectory: string, backend: () => HelperBackend, fallback: Describe = processDescribe): Describe {
  let sandbox: HelperWorkspace | undefined;
  return queued(async source => {
    if (!sandbox) {
      const root = join(stateDirectory, DESCRIBE_SESSION);
      await mkdir(root, { recursive: true, mode: 0o700 });
      sandbox = new HelperWorkspace(describeBinding(), join(root, "sandbox"), backend());
    }
    const box = sandbox;
    try { await box.initialize(); }
    catch (error) {
      if (sandbox === box) sandbox = undefined;
      await box.close().catch(() => {});
      throw error;
    }
    if (!box.runsProcesses || (source.mount && !box.bindAllowed(source.mount))) return fallback(source);
    if (!box.nodeBin) throw new Error("This host's Node.js can't be given to the sandbox, so its extensions can't be described");
    return describeThrough(new ProcessChannel({ directory: box.worktree, warn: () => {}, mountAllowed: path => box.bindAllowed(path), launch: confinedLaunch(box) }), source);
  });
}

export function sandboxDescribe(stateDirectory: string, fallback: Describe = processDescribe): Describe {
  let sandbox: Sandbox | undefined;
  return queued(async source => {
    if (!sandbox) {
      const root = join(stateDirectory, DESCRIBE_SESSION);
      await mkdir(root, { recursive: true, mode: 0o700 });
      sandbox = new Sandbox(describeBinding(), root, undefined, { browser: null });
    }
    const box = sandbox;
    try { await box.initialize(); }
    catch (error) {
      if (sandbox === box) sandbox = undefined;
      await box.close().catch(() => {});
      throw error;
    }
    if (source.mount && !box.bindAllowed(source.mount)) return fallback(source);
    const nodeBin = box.nodeBin;
    if (!nodeBin) throw new Error("This host's Node.js can't be given to the sandbox, so its extensions can't be described");
    const socketDirectory = serviceSocketDirectory(DESCRIBE_SESSION, stateDirectory);
    return describeThrough(new ProcessChannel({ directory: box.worktree, warn: () => {}, mountAllowed: path => box.bindAllowed(path),
      launch: sandboxLaunch({ socketDirectory, nodeBin, worktree: box.worktree,
        start: (command, binds, onOutput, signal) => box.startService(command, async () => {}, { limits: serviceLimits(DESCRIBE_TIMEOUT_MS / 1000, 1), unbounded: true,
          socketDirectory, onOutput, signal, binds }) }) }), source);
  });
}
