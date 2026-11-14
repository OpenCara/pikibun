import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessChannel, sandboxLaunch, workerCodeMounts } from "../apps/runner/src/extensions/process.js";
import { installMount } from "../apps/runner/src/extensions/load.js";
import { Sandbox, serviceBindAllowed } from "../apps/runner/src/sandbox.js";
import { serviceLimits, serviceSocketDirectory } from "../apps/runner/src/session-service.js";
import { binding, linuxSandboxMissing } from "./helpers/workspaces.js";

test("a service is given only paths of its own: never a system directory, the home directory or a parent of it, or the session's own files", () => {
  const session = "/srv/pikibun/state/sessions/s1/sandbox";
  for (const path of ["/", "/etc", "/usr", "/tmp", "/tmp/pikibun/extensions", "/run/user/1000", "/home", homedir(), "/srv/pikibun", "/srv/pikibun/state/sessions/s1/sandbox/worktree", session, "relative/path", "/a/../b"]) {
    assert.equal(serviceBindAllowed(path, session), false, path);
  }
  for (const path of ["/srv/pikibun/state/extensions/packages/0123456789abcdef", "/opt/node/lib/node_modules", "/srv/users/ada/.npm/_npx/h/node_modules"]) {
    assert.equal(serviceBindAllowed(path, session), true, path);
  }
  assert.equal(installMount("/state/extensions/packages/0123456789abcdef/node_modules/@scope/pi-ext"), "/state/extensions/packages/0123456789abcdef",
    "an installed package is mounted with its project, which holds its dependencies");
  assert.equal(installMount("/work/my-extension.ts"), "/work/my-extension.ts", "a single-file extension is mounted alone, never its directory");
  assert.ok(workerCodeMounts().length > 0, "the connector's own code is found to mount");
});

test("in the Linux sandbox, an installed extension sees the session's worktree and its own files, read-only, and nothing else of the host's", { skip: linuxSandboxMissing() }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-extension-sandbox-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new Sandbox(binding("extension-sandbox"), join(root, "session"), undefined, {});
  t.after(() => sandbox.close());
  await sandbox.initialize();
  assert.ok(sandbox.nodeBin, "the host's Node.js is given to the sandbox");
  const authorize = async () => {};
  await sandbox.writeFile("notes.txt", "in the worktree", authorize);
  const secret = join(root, "host-secret.txt");
  await writeFile(secret, "the host's own");
  const extension = await realpath(await mkdtemp(join(homedir(), ".pikibun-extension-sandbox-")));
  t.after(() => rm(extension, { recursive: true, force: true }));
  await mkdir(extension, { recursive: true });
  const file = join(extension, "probe.ts");
  await writeFile(file, `import { Type } from "typebox";
    import { readFileSync, writeFileSync } from "node:fs";
    const attempt = work => { try { return String(work()); } catch (error) { return "refused: " + error.code; } };
    export default function (pi) {
      pi.registerTool({ name: "probe", label: "Probe", description: "Probe the sandbox.", parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
          let network;
          try { await fetch("https://example.com/", { signal: AbortSignal.timeout(5000) }); network = "reached"; } catch { network = "unreachable"; }
          return { content: [{ type: "text", text: JSON.stringify({
            cwd: ctx.cwd, home: process.env.HOME, worktree: attempt(() => readFileSync("notes.txt", "utf8")),
            host: attempt(() => readFileSync(${JSON.stringify(secret)}, "utf8")),
            own: attempt(() => readFileSync(${JSON.stringify(file)}, "utf8").length > 0),
            writeOwn: attempt(() => writeFileSync(${JSON.stringify(join(extension, "written"))}, "x")),
            network }) }], details: undefined };
        } });
    }`);
  const socketDirectory = serviceSocketDirectory("extension-sandbox", root);
  const output: string[] = [];
  const channel = new ProcessChannel({ directory: sandbox.worktree, warn: (source, message) => { output.push(`${source}: ${message}`); }, log: line => { output.push(line); },
    launch: sandboxLaunch({ socketDirectory, nodeBin: sandbox.nodeBin!, worktree: sandbox.worktree,
      start: (command, binds, onOutput, signal) => sandbox.startService(command, authorize, { limits: serviceLimits(300, 1), unbounded: true, socketDirectory, onOutput, signal, binds }) }) });
  t.after(() => channel.close());
  const opened = await channel.call("open", { source: "local:probe", files: [file], models: [], mount: extension }).catch(error => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join("\n")}`);
  });
  assert.deepEqual(opened.value.errors, [], output.join("\n"));
  const answer = await channel.call("execute", { source: "local:probe", settings: {}, tool: "probe", callId: "c", args: {} });
  const seen = JSON.parse((answer.value.content[0] as { text: string }).text) as Record<string, string>;
  assert.equal(seen.cwd, sandbox.worktree, "it works in the session's worktree, at the sandbox's path");
  assert.equal(seen.home, sandbox.home);
  assert.equal(seen.worktree, "in the worktree");
  assert.equal(seen.host, "refused: ENOENT", "a host file outside what it was given isn't there");
  assert.equal(seen.own, "true", "its own files are there");
  assert.match(seen.writeOwn, /^refused: (EROFS|EACCES)$/, "and read-only");
  assert.equal(seen.network, "unreachable", "without the session's egress proxy there is no network at all");
});
