import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { sandboxExecutable, sandboxMissingPrograms } from "../apps/runner/src/program-availability.ts";
import { pythonPrograms } from "../apps/runner/src/python-command.ts";
import { hostToolPrograms, installChatMessage, installChatTitle, programInstallStep, programsMissingText } from "../packages/shared/src/program-install.ts";
import { bundledToolDefinitions } from "../packages/shared/src/tool-definitions.ts";

test("every program a program tool runs has a step the host's owner installs it with", () => {
  const programs = [...bundledToolDefinitions.flatMap(definition => definition.kind === "program" ? definition.programs : []), ...pythonPrograms];
  for (const program of programs) assert.ok(programInstallStep(program), `${program} has an install step`);
  assert.equal(programInstallStep("nothing-like-it"), undefined);
});

test("the sandbox finds a program in the connector's Node.js, /usr/bin or the tool's own directories", () => {
  const host = new Set(["/usr/bin/npm", "/usr/bin/npx", "/usr/bin/node", "/usr/local/go/bin/go", "/usr/local/bin/uv"]);
  const executable = (path: string) => host.has(path);
  const node = { programs: ["node", "npm", "npx", "pnpm", "yarn", "corepack"], path: ["/usr/local/bin"], toolchain: "node" as const };
  assert.deepEqual(sandboxMissingPrograms(node, { bin: "/usr/bin" }, executable), ["pnpm", "yarn", "corepack"]);
  assert.deepEqual(sandboxMissingPrograms(node, { bin: "/opt/pikibun/node/bin", programs: ["node", "npm", "npx", "pnpm"] }, () => false), ["yarn", "corepack"]);
  assert.deepEqual(sandboxMissingPrograms(node, undefined, executable), ["pnpm", "yarn", "corepack"]);
  assert.deepEqual(sandboxMissingPrograms({ programs: ["go", "gofmt"], path: ["/usr/local/go/bin", "/usr/lib/go/bin"] }, undefined, executable), ["gofmt"]);
  assert.deepEqual(sandboxMissingPrograms({ programs: ["uv", "poetry"], path: "/usr/local/bin" }, { bin: "/usr/local/bin", programs: ["poetry"] }, executable), ["poetry"]);
});

test("only an executable whose real path stays in /usr counts, as the sandbox mounts nothing else of the host", () => {
  assert.equal(sandboxExecutable("/home/someone/.local/bin/uv"), false);
  assert.equal(sandboxExecutable("/usr/bin/no-such-program-here"), false);
  if (existsSync("/usr/bin/env")) assert.equal(sandboxExecutable("/usr/bin/env"), true);
  assert.equal(sandboxExecutable("/usr/bin"), false);
});

test("the missing programs' text names each tool's and how each is installed, once per step", () => {
  assert.equal(programsMissingText({}), undefined);
  assert.equal(programsMissingText({ node: [] }), undefined);
  const text = programsMissingText({ node: ["pnpm", "yarn", "corepack"], python: ["uv", "uvx", "pytest"], go: ["go", "gofmt"] })!;
  assert.match(text, /^This host doesn't have the node tool's pnpm, yarn and corepack, the python tool's uv, uvx and pytest and the go tool's go and gofmt /);
  assert.match(text, /only the host's \/usr/);
  assert.match(text, /pnpm and yarn: with the npm of the Node\.js the connector runs on: npm install -g pnpm yarn/);
  assert.match(text, /corepack: npm install -g corepack/);
  assert.match(text, /uv and uvx: uv for the whole system: curl -LsSf https:\/\/astral\.sh\/uv\/install\.sh \| sudo env UV_INSTALL_DIR=\/usr\/local\/bin sh/);
  assert.match(text, /go and gofmt: Go's release in \/usr\/local\/go/);
  assert.equal(text.match(/astral\.sh/g)!.length, 1);
  assert.match(programsMissingText({ thing: ["frobnicate"] })!, /frobnicate: the distribution's package/);
});

test("a chat that installs a host's missing programs asks for each, with its step, and on the host to install them itself", () => {
  assert.deepEqual(hostToolPrograms("browser"), ["chromium"]);
  assert.deepEqual(hostToolPrograms("tunnel"), ["cloudflared"]);
  assert.equal(hostToolPrograms("node"), undefined);
  const chat = { host: "ada-pi", missing: { node: ["pnpm", "yarn"], python: ["uv", "uvx"], thing: ["frobnicate"] }, onHost: true };
  assert.equal(installChatTitle(chat), "Install pnpm, yarn, uv and more on ada-pi");
  assert.equal(installChatTitle({ ...chat, missing: { node: ["pnpm", "yarn"] } }), "Install pnpm and yarn on ada-pi");
  const text = installChatMessage(chat);
  assert.match(text, /^Install on this host \(ada-pi\) the programs Pikibun's sessions on it lack: the node tool's pnpm and yarn, the python tool's uv and uvx and the thing tool's frobnicate\./);
  assert.match(text, /\n- pnpm and yarn: with the npm of the Node\.js the connector runs on/);
  assert.match(text, /\n- uv and uvx: uv for the whole system/);
  assert.match(text, /\n- frobnicate: the distribution's package/);
  assert.match(text, /runs on the host itself/);
  assert.match(text, /run it with sudo -A: sudo then asks me for my password in Pikibun, in a box of its own/);
  assert.match(text, /If I decline, or this session doesn't offer sudo -A, stop and tell me the exact commands/);
  assert.doesNotMatch(text, /can't install anything/);
  const browser = installChatMessage({ host: "ada-pi", missing: { browser: ["chromium"] }, onHost: false });
  assert.match(browser, /the browser tool's chromium/);
  assert.match(browser, /\n- chromium: the distribution's chromium package .*piki:browser\) says Find it/);
  assert.match(browser, /runs in the host's sandbox, which can't install anything on the host/);
});
