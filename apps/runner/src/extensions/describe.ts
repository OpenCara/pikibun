import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionModuleSummary } from "../../../../packages/shared/src/host-extensions.js";
import type { RunnerBinding } from "../../../../packages/shared/src/types.js";
import { Sandbox } from "../sandbox.js";
import { serviceLimits, serviceSocketDirectory } from "../session-service.js";
import { ProcessChannel, sandboxLaunch } from "./process.js";

export interface DescribedSource { root: string; files: string[]; mount?: string }
export type Describe = (source: DescribedSource) => Promise<ExtensionModuleSummary[]>;

export const DESCRIBE_TIMEOUT_MS = 60_000;
const DESCRIBE_SESSION = "extension-describe";

async function ask(channel: ProcessChannel, source: DescribedSource): Promise<ExtensionModuleSummary[]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = `It took longer than ${DESCRIBE_TIMEOUT_MS / 1000} seconds to describe`;
      channel.restart(reason);
      reject(new Error(reason));
    }, DESCRIBE_TIMEOUT_MS);
  });
  const answer = channel.call("describe", source).then(result => result.value);
  answer.catch(() => {});
  try { return await Promise.race([answer, late]); }
  finally {
    clearTimeout(timer);
    void channel.close().catch(() => {});
  }
}

export const processDescribe: Describe = async source => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-describe-"));
  try { return await ask(new ProcessChannel({ directory, warn: () => {} }), source); }
  finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
};

export function sandboxDescribe(stateDirectory: string, fallback: Describe = processDescribe): Describe {
  let sandbox: Sandbox | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const describe = async (source: DescribedSource) => {
    if (!sandbox) {
      const root = join(stateDirectory, DESCRIBE_SESSION);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const owner = "pikibun:host";
      sandbox = new Sandbox({ session: { id: DESCRIBE_SESSION, ownerId: owner }, owner: { id: owner, githubLogin: null, gitName: "Pikibun", gitEmail: "pikibun@localhost", env: {} },
        model: { provider: "none" } } as unknown as RunnerBinding, root, undefined, { browser: null });
    }
    const box = sandbox;
    await box.initialize();
    if (source.mount && !box.bindAllowed(source.mount)) return fallback(source);
    const nodeBin = box.nodeBin;
    if (!nodeBin) throw new Error("This host's Node.js can't be given to the sandbox, so its extensions can't be described");
    const socketDirectory = serviceSocketDirectory(DESCRIBE_SESSION, stateDirectory);
    return ask(new ProcessChannel({ directory: box.worktree, warn: () => {}, mountAllowed: path => box.bindAllowed(path),
      launch: sandboxLaunch({ socketDirectory, nodeBin, worktree: box.worktree,
        start: (command, binds, onOutput, signal) => box.startService(command, async () => {}, { limits: serviceLimits(DESCRIBE_TIMEOUT_MS / 1000, 1), unbounded: true,
          socketDirectory, onOutput, signal, binds }) }) }), source);
  };
  return source => {
    const next = queue.then(() => describe(source));
    queue = next.catch(() => {});
    return next;
  };
}
