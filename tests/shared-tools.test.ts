import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HelperWorkspace, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "../apps/runner/src/helper-workspace.js";
import { HELPER, Sandbox, type SandboxRequest } from "../apps/runner/src/sandbox.js";
import { SeatbeltBackend } from "../apps/runner/src/seatbelt.js";
import { prepareSharedTools, SANDBOX_SHARED_TOOLS, sharedToolsDirectory, sharedToolsEnvironment, sharedToolsPath } from "../apps/runner/src/shared-tools.js";
import { binding, linuxSandboxMissing, seatbeltMissing } from "./helpers/workspaces.js";

const allow = async () => {};
const posix = process.platform !== "win32";
const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout?.trim() ?? "";
const bash = ["/bin/bash", "/usr/bin/bash"].find(path => existsSync(path)) ?? "";
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout?.trim() ?? "";

async function temporary(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function tools(directory: string): Promise<string> {
  const root = sharedToolsPath(directory);
  await prepareSharedTools(root);
  await mkdir(join(root, "bin"), { mode: 0o700 });
  await writeFile(join(root, "bin", "shared-hello"), "#!/bin/sh\necho shared tools ok\n", { mode: 0o700 });
  return root;
}

test("the shared tools folder is given only while it is a directory of the connector's user that no other user may write", { skip: !posix }, async t => {
  const directory = await temporary(t, "pikibun-tools-");
  const root = sharedToolsPath(directory);
  assert.equal(root, join(directory, "tools"));
  assert.equal(sharedToolsDirectory(root), undefined, "not made yet");
  await prepareSharedTools(root);
  assert.equal(sharedToolsDirectory(root), root);
  await symlink(root, join(directory, "linked"));
  assert.equal(sharedToolsDirectory(join(directory, "linked")), root, "a link is followed to the folder it names");
  await chmod(root, 0o775);
  assert.equal(sharedToolsDirectory(root), undefined, "a folder its group may write is refused");
  await chmod(root, 0o757);
  assert.equal(sharedToolsDirectory(root), undefined, "a folder anyone may write is refused");
  await chmod(root, 0o755);
  assert.equal(sharedToolsDirectory(root), root, "others may read it");
  await writeFile(join(directory, "file"), "");
  for (const path of [join(directory, "file"), "tools", "/", undefined, `${root}\n`]) assert.equal(sharedToolsDirectory(path), undefined);
});

test("the shared tools environment adds the folder's bin after the session's PATH and makes it the Azure CLI's system extension directory", () => {
  assert.deepEqual(sharedToolsEnvironment("/opt/pikibun/tools", "/usr/bin:/bin", false), {
    PIKIBUN_TOOLS: "/opt/pikibun/tools", PATH: "/usr/bin:/bin:/opt/pikibun/tools/bin", AZURE_EXTENSION_SYS_DIR: "/opt/pikibun/tools/azure-cli-extensions",
  });
  assert.deepEqual(sharedToolsEnvironment("C:\\state\\tools", "C:\\Windows\\System32", true), {
    PIKIBUN_TOOLS: "C:\\state\\tools", PATH: "C:\\Windows\\System32;C:\\state\\tools\\bin", AZURE_EXTENSION_SYS_DIR: "C:\\state\\tools\\azure-cli-extensions",
  });
});

class Recording implements HelperBackend {
  readonly name = "recording";
  readonly limitedShell = true;
  readonly path = "/usr/bin:/bin";
  readonly launched: { request: SandboxRequest; context: HelperContext }[] = [];
  supports(): boolean { return true; }
  async prepare(): Promise<void> {}
  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    this.launched.push({ request, context });
    return { command: python, args: ["-I", "-c", HELPER], cwd: layout.worktree,
      env: { ...context.environment, SANDBOX_GITDIR: layout.git, SANDBOX_GIT: git, SANDBOX_BASH: bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig } };
  }
}

test("the helper workspace gives commands, and only commands, the shared tools folder while it may be shared", { skip: !posix || !python || !git || !bash }, async t => {
  const directory = await temporary(t, "pikibun-helper-tools-");
  const root = await tools(directory);
  const backend = new Recording();
  const sandbox = new HelperWorkspace(binding("helper-tools"), join(directory, "sandbox"), backend, { sharedTools: root });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  assert.equal(await sandbox.execute({ kind: "bash", command: "shared-hello && printf %s \"$PIKIBUN_TOOLS $AZURE_EXTENSION_SYS_DIR\"" }, false, allow),
    `shared tools ok\n${root} ${join(root, "azure-cli-extensions")}`);
  await sandbox.readFile(".git", allow).catch(() => undefined);
  const by = (kind: string) => backend.launched.filter(entry => entry.request.kind === kind).map(entry => entry.context);
  assert.equal(by("bash")[0]!.sharedTools, root);
  assert.equal(by("bash")[0]!.environment.PATH, `/usr/bin:/bin:${join(root, "bin")}`);
  for (const kind of ["initialize", "read"]) {
    assert.equal(by(kind)[0]!.sharedTools, undefined);
    assert.equal(by(kind)[0]!.environment.PIKIBUN_TOOLS, undefined);
  }
  await chmod(root, 0o777);
  await assert.rejects(sandbox.execute({ kind: "bash", command: "shared-hello" }, false, allow), /not found/, "a folder others may write is no longer given");
  assert.equal(by("bash").at(-1)!.sharedTools, undefined);
});

test("in the Linux sandbox, commands run the shared tools at /opt/pikibun/tools, which they can't change", { skip: linuxSandboxMissing() }, async t => {
  const directory = await temporary(t, "pikibun-linux-tools-");
  const root = await tools(directory);
  const sandbox = new Sandbox(binding("linux-tools"), join(directory, "session"), undefined, { sharedTools: root, browser: null });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, allow, { unbounded: true });
  assert.equal(await shell("shared-hello && printf %s \"$PIKIBUN_TOOLS $AZURE_EXTENSION_SYS_DIR\""),
    `shared tools ok\n${SANDBOX_SHARED_TOOLS} ${SANDBOX_SHARED_TOOLS}/azure-cli-extensions`);
  await assert.rejects(shell(`touch ${SANDBOX_SHARED_TOOLS}/bin/planted`), /Read-only|Permission denied/);
  assert.ok(!existsSync(join(root, "bin", "planted")));
  const plain = new Sandbox(binding("linux-no-tools"), join(directory, "plain"), undefined, { browser: null });
  t.after(() => plain.close());
  await plain.initialize();
  assert.equal(await plain.execute({ kind: "bash", command: `test -e ${SANDBOX_SHARED_TOOLS} || echo absent` }, false, allow, { unbounded: true }), "absent\n");
});

test("in the macOS sandbox, commands run the shared tools in place, and can't change them", { skip: seatbeltMissing() }, async t => {
  const directory = await temporary(t, "pikibun-seatbelt-tools-");
  const root = await tools(directory);
  const sandbox = new HelperWorkspace(binding("seatbelt-tools"), join(directory, "sandbox"), new SeatbeltBackend(), { sharedTools: root });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, allow, { unbounded: true });
  assert.equal(await shell("shared-hello"), "shared tools ok\n");
  await assert.rejects(shell(`touch '${join(root, "bin", "planted")}'`), /Operation not permitted|Permission denied/);
  assert.ok(!existsSync(join(root, "bin", "planted")));
  const plain = new HelperWorkspace(binding("seatbelt-no-tools"), join(directory, "plain"), new SeatbeltBackend());
  t.after(() => plain.close());
  await plain.initialize();
  await assert.rejects(plain.execute({ kind: "bash", command: `cat '${join(root, "bin", "shared-hello")}'` }, false, allow, { unbounded: true }),
    /Operation not permitted|Permission denied/, "a session not given the folder can't read it");
});
