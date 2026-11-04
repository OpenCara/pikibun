import test from "node:test";
import assert from "node:assert/strict";
import { nodeRequest, nodeShellCommand, registryAccountCommand } from "../apps/runner/src/node-command.js";

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
    "cd -- './app' && PATH=\"$PATH:/usr/local/bin\" NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true pnpm 'test' '--' 'it'\\''s' </dev/null 2>&1");
  assert.equal(nodeShellCommand({ program: "node", directory: ".", args: [] }),
    "PATH=\"$PATH:/usr/local/bin\" NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true node </dev/null 2>&1");
});

test("the node tool's calls fit a bash operation's 8192 characters, or are refused saying so", async () => {
  const { validateOperation } = await import("../apps/runner/src/protocol.js");
  assert.throws(() => nodeShellCommand({ program: "node", directory: ".", args: ["-e", "x".repeat(8150)] }), /over 8192 characters/);
  assert.doesNotThrow(() => validateOperation({ kind: "bash", command: nodeShellCommand({ program: "node", directory: "app", args: ["-e", "x".repeat(8000)] }) }));
});
