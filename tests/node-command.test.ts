import test from "node:test";
import assert from "node:assert/strict";
import { nodeRequest, nodeShellCommand, registryAccountCommand } from "../apps/runner/src/node-command.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

test("the node tool runs Node.js or a package manager, with its arguments as a list", () => {
  assert.deepEqual(nodeRequest({ program: "pnpm", args: ["test"], directory: "app" }), { program: "pnpm", directory: "app", args: ["test"] });
  assert.deepEqual(nodeRequest({ program: "node" }), { program: "node", directory: ".", args: [] });
  for (const program of ["bash", "sh", "python3", "node; rm -rf .", "/usr/bin/node", undefined]) {
    assert.throws(() => nodeRequest({ program, args: [] }), /program is one of/, String(program));
  }
  assert.throws(() => nodeRequest({ program: "node", args: "-e 1" }), /as a list/);
  assert.throws(() => nodeRequest({ program: "node", args: ["a\0"] }), /NUL/);
  assert.throws(() => nodeRequest({ program: "node", directory: "../other" }), /within the session's worktree/);
});

test("the node tool refuses package manager commands that act on a registry as an account", () => {
  const refused: [string, string[]][] = [
    ["npm", ["publish"]], ["pnpm", ["publish", "--access", "public"]], ["yarn", ["npm", "publish"]], ["npm", ["login"]], ["npm", ["token", "list"]],
    ["pnpm", ["--filter", "web", "publish"]], ["pnpm", ["-C", "packages/a", "publish"]], ["pnpm", ["-r", "publish"]], ["pnpm", ["recursive", "publish"]],
    ["yarn", ["workspace", "web", "publish"]], ["npm", ["owner", "add", "eve", "pkg"]], ["npm", ["dist-tag", "add", "pkg@1", "latest"]],
    ["npm", ["tag", "pkg@1", "latest"]], ["yarn", ["npm", "tag", "add", "pkg@1", "latest"]],
    ["npm", ["-w", "packages/a", "publish"]], ["pnpm", ["-w", "publish"]],
    // Through what launches a package manager by name.
    ["corepack", ["pnpm", "publish"]], ["corepack", ["pnpm@9.1.0", "publish"]], ["corepack", ["yarn", "npm", "publish"]],
    ["npx", ["npm", "publish"]], ["npx", ["-y", "pnpm@9", "publish"]], ["npx", ["--package", "x", "npm", "login"]], ["npx", ["--", "npm", "publish"]],
    ["pnpm", ["dlx", "npm", "publish"]], ["pnpm", ["exec", "npm", "token", "list"]], ["npm", ["exec", "--", "pnpm", "publish"]], ["npm", ["x", "yarn", "npm", "publish"]],
    ["yarn", ["dlx", "-p", "npm", "npm", "publish"]], ["npx", ["corepack", "pnpm", "publish"]],
  ];
  for (const [program, args] of refused) assert.throws(() => nodeRequest({ program, args }), /acts on a package registry/, `${program} ${args.join(" ")}`);
  const allowed: [string, string[]][] = [
    ["pnpm", ["add", "token"]], ["npm", ["install", "npm"]], ["pnpm", ["run", "build", "--", "publish"]], ["pnpm", ["--filter=web", "test"]],
    ["npx", ["publish-please"]], ["node", ["publish.js"]], ["pnpm", ["exec", "tsc", "--noEmit"]], ["npm", ["test"]],
    ["pnpm", ["-w", "run", "publish"]], ["pnpm", ["-w", "add", "-D", "typescript"]], ["corepack", ["enable"]], ["corepack", ["pnpm", "install"]],
    ["npx", ["npm", "pack"]], ["npx", ["@scope/publish@1", "x"]], ["pnpm", ["dlx", "create-vite", "publish"]],
  ];
  for (const [program, args] of allowed) assert.doesNotThrow(() => nodeRequest({ program, args }), `${program} ${args.join(" ")}`);
  assert.equal(registryAccountCommand("pnpm", ["--filter", "web", "--", "publish"]), undefined);
  assert.equal(registryAccountCommand("corepack", ["pnpm@9", "publish"]), "pnpm publish");
});

test("the node tool's command quotes every argument and runs without colours or prompts, finding Node in /usr/local/bin too", () => {
  assert.equal(nodeShellCommand({ program: "pnpm", directory: "app", args: ["test", "--", "it's"] }),
    "cd -- './app' && PATH=\"$PATH\":'/usr/local/bin' NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true pnpm 'test' '--' 'it'\\''s' </dev/null 2>&1");
  assert.equal(nodeShellCommand({ program: "node", directory: ".", args: [] }),
    "PATH=\"$PATH\":'/usr/local/bin' NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true node </dev/null 2>&1");
});

test("the node tool's calls fit a bash operation's 8192 characters, or are refused saying so", async () => {
  const { validateOperation } = await import("../apps/runner/src/protocol.js");
  assert.throws(() => nodeShellCommand({ program: "node", directory: ".", args: ["-e", "x".repeat(8150)] }), /over 8192 characters/);
  assert.doesNotThrow(() => validateOperation({ kind: "bash", command: nodeShellCommand({ program: "node", directory: "app", args: ["-e", "x".repeat(8000)] }) }));
});

test("the node tool looks first where the session's commands find the connector's own Node.js", () => {
  assert.equal(nodeShellCommand({ program: "pnpm", directory: ".", args: ["test"] }, "/opt/pikibun/node/bin"),
    "PATH='/opt/pikibun/node/bin':\"$PATH\":'/usr/local/bin' NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true pnpm 'test' </dev/null 2>&1");
  // A path with spaces (a macOS home, say) is quoted, not refused.
  assert.match(nodeShellCommand({ program: "node", directory: ".", args: [] }, "/Users/Jo Doe/.nvm/versions/node/v24.11.0/bin"),
    /^PATH='\/Users\/Jo Doe\/\.nvm\/versions\/node\/v24\.11\.0\/bin':"\$PATH":'\/usr\/local\/bin' /);
});

test("the connector's own Node.js: where it is installed, and how the Linux sandbox gives it to commands", async t => {
  const { mkdtemp, mkdir, writeFile, symlink, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { connectorNode, sandboxNodeMount, SANDBOX_NODE_DIRECTORY } = await import("../apps/runner/src/node-toolchain.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-node-toolchain-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nvm", "v24.11.0", "bin"), { recursive: true });
  await writeFile(join(root, "nvm", "v24.11.0", "bin", "node"), "");
  await mkdir(join(root, "shims"));
  await symlink(join(root, "nvm", "v24.11.0", "bin", "node"), join(root, "shims", "node"));
  // Resolved through links to the installation itself.
  const found = connectorNode(join(root, "shims", "node"), { ...process.versions, node: "24.11.0" });
  assert.deepEqual(found, { version: "24.11.0", prefix: join(root, "nvm", "v24.11.0"), bin: join(root, "nvm", "v24.11.0", "bin") });
  assert.equal(connectorNode(join(root, "missing")), undefined);
  assert.equal(connectorNode(process.execPath, { ...process.versions, electron: "38.0.0" }), undefined, "the desktop app runs on Electron, not Node.js");

  assert.deepEqual(sandboxNodeMount(found), { mount: { source: join(root, "nvm", "v24.11.0"), target: SANDBOX_NODE_DIRECTORY }, bin: `${SANDBOX_NODE_DIRECTORY}/bin` });
  assert.deepEqual(sandboxNodeMount({ version: "24.11.0", prefix: "/usr/local", bin: "/usr/local/bin" }), { bin: "/usr/local/bin" }, "already in /usr");
  assert.deepEqual(sandboxNodeMount({ version: "24.11.0", prefix: "/usr", bin: "/usr/bin" }), { bin: "/usr/bin" });
  assert.equal(sandboxNodeMount({ version: "24.11.0", prefix: "/", bin: "/bin" }), undefined);
  assert.equal(sandboxNodeMount(undefined), undefined);
});

test("the Linux sandbox gives shell commands the connector's own Node.js, read-only, where it isn't in /usr", { skip: process.platform !== "linux" }, async t => {
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Sandbox } = await import("../apps/runner/src/sandbox.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-node-mount-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  // An installation outside /usr, as nvm, Volta or a tarball leave it.
  const prefix = join(root, "node-v24");
  await mkdir(join(prefix, "bin"), { recursive: true });
  await writeFile(join(prefix, "bin", "node"), "#!/bin/sh\necho \"connector-node $*\"\n", { mode: 0o755 });
  const binding = (id: string): RunnerBinding => ({
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Node", policyVersion: 1,
      status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "",
      tools: ["node"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Faux", provider: "faux", modelId: "faux-1" },
  });
  const sandbox = new Sandbox(binding("node-mount"), join(root, "session"), undefined, { node: { version: "24.11.0", prefix, bin: join(prefix, "bin") } });
  t.after(() => sandbox.close());
  assert.equal(sandbox.nodeBin, "/opt/pikibun/node/bin");
  await sandbox.initialize();
  const authorize = async () => {};
  const output = await sandbox.execute({ kind: "bash", command: nodeShellCommand({ program: "node", directory: ".", args: ["--version"] }, sandbox.nodeBin) }, false, authorize,
    { allowTestShell: true });
  assert.equal(output.trim(), "connector-node --version");
  // Read-only: a command can't change the host's installation.
  await assert.rejects(sandbox.execute({ kind: "bash", command: "echo changed > /opt/pikibun/node/bin/node" }, false, authorize, { allowTestShell: true }));
  const { readFile } = await import("node:fs/promises");
  assert.match(await readFile(join(prefix, "bin", "node"), "utf8"), /connector-node/);

  const without = new Sandbox(binding("node-none"), join(root, "none"), undefined, { node: null });
  t.after(() => without.close());
  assert.equal(without.nodeBin, undefined);
});
