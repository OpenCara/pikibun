import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessChannel, sandboxLaunch, workerCodeMounts } from "../apps/runner/src/extensions/process.js";
import { installMount } from "../apps/runner/src/extensions/load.js";
import { sandboxDescribe } from "../apps/runner/src/extensions/describe.js";
import { commandBindAllowed, hostSharedFilesRefusal, Sandbox, serviceBindAllowed } from "../apps/runner/src/sandbox.js";
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

test("a command is given only a program's install under /opt, never Pikibun's own or anything else of the host's", () => {
  for (const path of ["/", "/opt", "/opt/pikibun", "/opt/pikibun/bin", "/usr", "/etc", "/home", homedir(), "opt/az", "/opt/az/../../etc", "/opt/az/", "/opt/a\nb"]) {
    assert.equal(commandBindAllowed(path), false, path);
  }
  for (const path of ["/opt/az", "/opt/azure-cli"]) assert.equal(commandBindAllowed(path), true, path);
});

test("in the Linux sandbox, a command sees the /opt installs it was given, read-only, where they exist, and is refused any other path", { skip: linuxSandboxMissing() }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-command-binds-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = binding("command-binds");
  const sandbox = new Sandbox({ ...faux, model: { ...faux.model, provider: "faux" } }, join(root, "session"), undefined, {});
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const present = ["/opt/az", "/opt/azure-cli"].find(path => existsSync(path));
  const absent = "/opt/pikibun-test-absent-install";
  const shell = (command: string, binds: string[]) => sandbox.execute({ kind: "bash", command }, false, async () => {}, { allowTestShell: true, binds });
  assert.equal((await shell(`test -e ${absent} || echo absent`, [absent])).trim(), "absent", "a missing install is left out, and the command still runs");
  if (present) {
    assert.deepEqual((await shell(`test -d ${present} && echo seen; touch ${present}/written 2>/dev/null || echo read-only`, [present])).trim().split("\n"), ["seen", "read-only"]);
    assert.equal((await shell(`test -e ${present} || echo hidden`, [])).trim(), "hidden", "only for a command given it");
  } else t.diagnostic("no Azure CLI install under /opt here: only the absent case is checked");
  await assert.rejects(shell("true", ["/etc"]), /A command can't be given \/etc/);
  await assert.rejects(shell("true", ["/opt/pikibun"]), /A command can't be given \/opt\/pikibun/);
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
  const warnings: Error[] = [];
  const warned = (warning: Error) => { warnings.push(warning); };
  process.on("warning", warned);
  t.after(() => { process.off("warning", warned); });
  for (let request = 0; request < 12; request++) await channel.call("emit", { source: "local:probe", settings: {}, event: { type: "session_start", reason: "startup" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(warnings.filter(warning => warning.name === "MaxListenersExceededWarning"), [], "holding its process for each request leaves nothing on the process's closed pipes");
});

test("in the Linux sandbox, a host file shared with an extension is in its process, read-only, at its place in the session's home, and never in the agent's commands", { skip: linuxSandboxMissing() }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-extension-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = binding("extension-files");
  const sandbox = new Sandbox({ ...faux, model: { ...faux.model, provider: "faux" } }, join(root, "session"), undefined, {});
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const authorize = async () => {};
  const extension = await realpath(await mkdtemp(join(homedir(), ".pikibun-extension-files-")));
  t.after(() => rm(extension, { recursive: true, force: true }));
  const shared = join(extension, "web-search.json");
  await writeFile(shared, `{"ssrf":{"allowRanges":["198.18.0.0/15"]}}`);
  const target = join(sandbox.home, ".config", "pi", "web-search.json");
  const file = join(extension, "probe.ts");
  await writeFile(file, `import { Type } from "typebox";
    import { readFileSync, writeFileSync } from "node:fs";
    const attempt = work => { try { return String(work()); } catch (error) { return "refused: " + error.code; } };
    export default function (pi) {
      pi.registerTool({ name: "probe", label: "Probe", description: "Probe the shared file.", parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: JSON.stringify({
            read: attempt(() => readFileSync(${JSON.stringify(target)}, "utf8")),
            write: attempt(() => writeFileSync(${JSON.stringify(target)}, "{}")),
            beside: attempt(() => writeFileSync(${JSON.stringify(join(sandbox.home, ".config", "pi", "cache.json"))}, "{}")) }) }], details: undefined };
        } });
    }`);
  const socketDirectory = serviceSocketDirectory("extension-files", root);
  const output: string[] = [];
  const asked: string[] = [];
  const channel = new ProcessChannel({ directory: sandbox.worktree, warn: (source, message) => { output.push(`${source}: ${message}`); }, log: line => { output.push(line); },
    mountAllowed: path => sandbox.bindAllowed(path),
    files: async source => { asked.push(source); return [{ source: shared, target }]; },
    launch: sandboxLaunch({ socketDirectory, nodeBin: sandbox.nodeBin!, worktree: sandbox.worktree,
      start: (command, binds, onOutput, signal, files) => sandbox.startService(command, authorize, { limits: serviceLimits(300, 1), unbounded: true, socketDirectory, onOutput, signal, binds,
        ...(files?.length ? { files } : {}) }) }) });
  t.after(() => channel.close());
  const opened = await channel.call("open", { source: "local:probe", files: [file], models: [], mount: extension }).catch(error => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join("\n")}`);
  });
  assert.deepEqual(opened.value.errors, [], output.join("\n"));
  assert.deepEqual(asked, ["local:probe"], "the files are asked for as the extension opens");
  const answer = await channel.call("execute", { source: "local:probe", settings: {}, tool: "probe", callId: "c", args: {} });
  const seen = JSON.parse((answer.value.content[0] as { text: string }).text) as Record<string, string>;
  if (hostSharedFilesRefusal()) {
    t.diagnostic(`shared files are left out here: ${hostSharedFilesRefusal()}`);
    assert.equal(seen.read, "refused: ENOENT", "with a bubblewrap too old to place it safely, the file is left out");
  } else {
    assert.equal(seen.read, `{"ssrf":{"allowRanges":["198.18.0.0/15"]}}`, "the extension reads the host's file where it looks for it");
    assert.match(seen.write, /^refused: (EROFS|EACCES)$/, "and can't change it");
    assert.equal(seen.beside, "undefined", "the rest of the session's home stays writable, for its caches");
  }
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, authorize, { allowTestShell: true });
  assert.equal((await shell(`cat ${target} 2>/dev/null; echo "[end]"`)).trim(), "[end]", "the agent's own commands never see its contents");
  await assert.rejects(sandbox.startService("true", authorize, { limits: serviceLimits(60, 1), unbounded: true, socketDirectory, onOutput: () => {}, files: [{ source: shared, target: join(sandbox.home, ".gitconfig") }] }),
    /A service's file can't go to/);
  await assert.rejects(sandbox.startService("true", authorize, { limits: serviceLimits(60, 1), unbounded: true, socketDirectory, onOutput: () => {}, files: [{ source: shared, target: "/etc/web-search.json" }] }),
    /A service's file can't go to/);
  await assert.rejects(sandbox.startService("true", authorize, { limits: serviceLimits(60, 1), unbounded: true, socketDirectory, onOutput: () => {}, files: [{ source: "/etc/shadow", target }] }),
    /A service can't be given \/etc\/shadow/);
});

test("in the Linux sandbox, an installed extension is described without its code seeing the host: what it reads at load time isn't there", { skip: linuxSandboxMissing() }, async t => {
  const state = await realpath(await mkdtemp(join(homedir(), ".pikibun-describe-state-")));
  t.after(() => rm(state, { recursive: true, force: true }));
  const secret = join(state, "host-secret.txt");
  await writeFile(secret, "the host's own");
  const extension = join(state, "extension");
  await mkdir(extension);
  const file = join(extension, "peek.ts");
  await writeFile(file, `import { Type } from "typebox";
    import { readFileSync } from "node:fs";
    let seen;
    try { seen = readFileSync(${JSON.stringify(secret)}, "utf8"); } catch (error) { seen = "refused: " + error.code; }
    export default function (pi) {
      pi.registerTool({ name: "peek", label: "Peek", description: seen + " " + process.cwd(), parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
    }`);
  const describe = sandboxDescribe(state);
  const [module] = await describe({ root: extension, files: [file], mount: extension });
  assert.equal(module!.error, undefined);
  assert.match(module!.tools[0]!.description, /^refused: ENOENT \/sessions\//, "its load-time code ran in the sandbox, where the host's file isn't");
  const [again] = await describe({ root: extension, files: [file], mount: extension });
  assert.equal(again!.tools[0]!.name, "peek", "each description gets a process of its own");
});
