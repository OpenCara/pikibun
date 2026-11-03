import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { HelperWorkspace, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "../../apps/runner/src/helper-workspace.js";
import { HostWorkspace } from "../../apps/runner/src/host-workspace.js";
import { NODE_HELPER, NODE_HELPER_KINDS } from "../../apps/runner/src/node-helper.js";
import { HELPER, Sandbox, type SandboxRequest } from "../../apps/runner/src/sandbox.js";
import type { SessionWorkspace } from "../../apps/runner/src/workspace.js";
import type { RunnerBinding } from "../../packages/shared/src/types.js";

/*
 * Every implementation of a session's files, made the same way for tests that hold them all to the same rules
 * (tests/sandbox-conformance.test.ts): the Linux sandbox (bubblewrap and the Python helper), the Python helper as the
 * macOS sandbox runs it, the Node helper as the Windows sandbox runs it, and the unsandboxed host's own TypeScript.
 * The two helpers run here without their OS boundary (Seatbelt, AppContainer), which only the real platforms have: what
 * is held to the rules is each helper's own logic.
 */

// Without sh (Windows), nothing is found, and the kinds that need these are skipped.
const which = (command: string) => spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).stdout?.trim() ?? "";
export const git = which("git");
export const bash = ["/bin/bash", "/usr/bin/bash"].find(path => existsSync(path)) ?? "";
export const python = which("python3");
const posix = process.platform !== "win32" && !!git && !!bash;

/** Why the Linux sandbox can't run here, if it can't: bubblewrap missing, or no user namespaces for it. */
function linuxSandboxMissing(): string | undefined {
  if (process.platform !== "linux") return "the Linux sandbox runs only on Linux";
  if (!existsSync("/usr/bin/bwrap")) return "bubblewrap (/usr/bin/bwrap) is not installed";
  if (!existsSync("/usr/bin/python3")) return "/usr/bin/python3 is not installed";
  const probe = spawnSync("/usr/bin/bwrap", ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev",
    "--", "/usr/bin/true"], { encoding: "utf8" });
  return probe.status === 0 ? undefined : `bubblewrap can't make a sandbox here (${(probe.stderr || "no user namespaces").trim().slice(0, 120)})`;
}

export function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Workspace", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.",
      tools: ["read_file", "write_file", "bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

/** A backend that runs a helper with no boundary at all: the workspace layer and the helper's own logic, nothing else. */
export class Unconfined implements HelperBackend {
  readonly path = "/usr/bin:/bin";
  readonly launched: { request: SandboxRequest; context: HelperContext }[] = [];
  constructor(readonly name: string, readonly limitedShell: boolean, readonly helper: "python" | "node") {}
  supports(kind: SandboxRequest["kind"]): boolean { return this.helper === "python" || NODE_HELPER_KINDS.has(kind); }
  async prepare(layout: HelperLayout): Promise<void> {
    if (this.helper === "node") await writeFile(join(layout.bin, "helper.mjs"), NODE_HELPER, { mode: 0o400 }).catch(() => undefined);
  }
  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    this.launched.push({ request, context });
    const env = { ...context.environment, SANDBOX_GITDIR: layout.git, SANDBOX_GIT: git, SANDBOX_BASH: bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig };
    return this.helper === "python"
      ? { command: python, args: ["-I", "-c", HELPER], env, cwd: layout.worktree }
      : { command: process.execPath, args: [join(layout.bin, "helper.mjs")], env, cwd: layout.worktree };
  }
}

export interface WorkspaceKind {
  name: string;
  /** Why it can't run here, if it can't: its tests are skipped with this reason. */
  missing?: string;
  /**
   * Opens one, and says where its worktree is on this machine (its `hostWorktree`), for a test to set up files in. The
   * Linux sandbox's own `worktree` is the path its commands see inside the sandbox, not this one.
   */
  open(t: TestContext): Promise<{ workspace: SessionWorkspace; worktree: string }>;
}

async function scratch(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function opened(t: TestContext, workspace: SessionWorkspace): Promise<{ workspace: SessionWorkspace; worktree: string }> {
  t.after(() => workspace.close());
  await workspace.initialize();
  return { workspace, worktree: workspace.hostWorktree };
}

/** Each implementation of a session's files, and why it can't run here, if it can't. */
export const workspaceKinds: readonly WorkspaceKind[] = [
  {
    name: "the Linux sandbox (bubblewrap, Python helper)", missing: linuxSandboxMissing(),
    open: async t => {
      return opened(t, new Sandbox(binding("conformance-linux"), join(await scratch(t, "conformance-linux-"), "session")));
    },
  },
  {
    name: "the Python helper, as the macOS sandbox runs it", missing: !posix ? "needs a POSIX host with git and bash" : !python ? "python3 is not installed" : undefined,
    open: async t => {
      return opened(t, new HelperWorkspace(binding("conformance-python"), join(await scratch(t, "conformance-python-"), "sandbox"), new Unconfined("python", true, "python")));
    },
  },
  {
    name: "the Node helper, as the Windows sandbox runs it", missing: !posix ? "needs a POSIX host with git and bash" : undefined,
    open: async t => {
      return opened(t, new HelperWorkspace(binding("conformance-node"), join(await scratch(t, "conformance-node-"), "sandbox"), new Unconfined("node", true, "node")));
    },
  },
  {
    name: "the unsandboxed host's workspace", missing: !posix ? "needs a POSIX host with git and bash" : undefined,
    open: async t => {
      return opened(t, new HostWorkspace(binding("conformance-host"), join(await scratch(t, "conformance-host-"), "session")));
    },
  },
];
