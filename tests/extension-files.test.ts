import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHostConfig, extensionFilePackage, hostConfigLimits, ownerOnlyHostConfig, parseExtensionFiles, parseHostConfigChange, readHostConfig } from "../packages/shared/src/host-config.js";
import { extensionFileBinds, hostFilePath, type FileBind } from "../apps/runner/src/extensions/files.js";
import { FILES_REFRESH_MS, ProcessChannel, type WorkerLaunch } from "../apps/runner/src/extensions/process.js";
import { homeFileClear, homeFileTarget, sharedFilesRefusal } from "../apps/runner/src/sandbox.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

test("a shared file names an npm: or Git package, a host path and a place in the session's home, and only the host's owner sets them", () => {
  assert.deepEqual(defaultHostConfig.extensionFiles, []);
  assert.ok(ownerOnlyHostConfig.includes("extensionFiles"));
  assert.equal(extensionFilePackage("npm:pi-web-access@0.46.0"), "npm:pi-web-access");
  assert.equal(extensionFilePackage("npm:@scope/pi-ext"), "npm:@scope/pi-ext");
  assert.equal(extensionFilePackage(`git:github.com/acme/ext.git@${commit}#packages/a`), "git:https://github.com/acme/ext#packages/a");
  assert.equal(extensionFilePackage("git:https://github.com/acme/ext"), "git:https://github.com/acme/ext");
  for (const invalid of ["piki:gh", "local:/home/a/ext.ts", "npm:Bad Name", "git:https://ada:secret@github.com/acme/ext", ""]) assert.throws(() => extensionFilePackage(invalid), invalid);

  const file = { extension: "npm:pi-web-access@0.46.0", path: " ~/.pi/agent/web-search.json ", target: ".config/pi/web-search.json" };
  assert.deepEqual(parseExtensionFiles([file]), [{ extension: "npm:pi-web-access", path: "~/.pi/agent/web-search.json", target: ".config/pi/web-search.json" }]);
  assert.deepEqual(parseHostConfigChange({ extensionFiles: [file] }).extensionFiles?.map(item => item.extension), ["npm:pi-web-access"]);
  for (const path of ["web-search.json", "~", "~/", "/", "~/../x", "/a/../b", "/a\nb", "x".repeat(hostConfigLimits.extensionFilePath + 1)]) {
    assert.throws(() => parseExtensionFiles([{ ...file, path }]), /absolute path/, JSON.stringify(path));
  }
  for (const target of ["", "/abs", "../x", "a/../b", "./a", "a//b", "a/", ".gitconfig", ".tmp/x", "a\tb"]) {
    assert.throws(() => parseExtensionFiles([{ ...file, target }]), /session's home/, JSON.stringify(target));
  }
  assert.throws(() => parseExtensionFiles([file, { ...file, path: "/etc/other" }]), /Two shared files go to/);
  assert.throws(() => parseExtensionFiles([{ ...file, contents: "{}" }]), /Invalid shared extension file/);
  assert.throws(() => parseExtensionFiles(Array.from({ length: hostConfigLimits.extensionFiles + 1 }, (_, index) => ({ ...file, target: `f${index}` }))), /at most 32/);
  const older = Object.fromEntries(Object.entries(defaultHostConfig).filter(([key]) => key !== "extensionFiles"));
  assert.deepEqual(readHostConfig(older).extensionFiles, [], "a Pikibun server from before the list shares nothing");
});

test("a shared file reaches the extension's package at any version, as the real file it names, and one that isn't a file is reported", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-extension-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi", "agent"), { recursive: true });
  await writeFile(join(root, ".pi", "agent", "web-search.json"), "{}");
  await symlink(join(root, ".pi", "agent", "web-search.json"), join(root, "linked.json"));
  const files = parseExtensionFiles([
    { extension: "npm:pi-web-access", path: "~/.pi/agent/web-search.json", target: ".config/pi/web-search.json" },
    { extension: "npm:pi-web-access", path: join(root, "linked.json"), target: ".pi/agent/web-search.json" },
    { extension: "npm:pi-web-access", path: "~/.pi/agent", target: "dir" },
    { extension: "npm:pi-web-access", path: "~/absent.json", target: "absent.json" },
    { extension: "npm:other", path: "~/.pi/agent/web-search.json", target: "other.json" },
  ]);
  assert.equal(hostFilePath("~/a/b", "/home/ada"), "/home/ada/a/b");
  assert.equal(hostFilePath("/etc/a", "/home/ada"), "/etc/a");
  const real = join(root, ".pi", "agent", "web-search.json");
  for (const source of ["npm:pi-web-access@0.46.0", "npm:pi-web-access@0.47.1"]) {
    const { binds, missing } = extensionFileBinds(files, source, "/sessions/s/home", root);
    assert.deepEqual(binds.map(({ source, target }) => ({ source, target })),
      [{ source: real, target: "/sessions/s/home/.config/pi/web-search.json" }, { source: real, target: "/sessions/s/home/.pi/agent/web-search.json" }]);
    assert.deepEqual(missing, ["~/.pi/agent", "~/absent.json"]);
  }
  const before = extensionFileBinds(files, "npm:pi-web-access@0.46.0", "/sessions/s/home", root).binds[0]!.stamp;
  await writeFile(`${real}.new`, `{"ssrf":{}}`);
  await rename(`${real}.new`, real);
  assert.notEqual(extensionFileBinds(files, "npm:pi-web-access@0.46.0", "/sessions/s/home", root).binds[0]!.stamp, before,
    "a file saved anew, as editors do by replacing it, reads as changed");
  assert.deepEqual(extensionFileBinds(files, "piki:gh", "/sessions/s/home", root), { binds: [], missing: [] });
  assert.deepEqual(extensionFileBinds(files, "local:/x/ext.ts", "/sessions/s/home", root), { binds: [], missing: [] });
});

test("a shared file goes only somewhere in the session's home other than its Git configuration and temporary files", () => {
  const home = "/sessions/s/home";
  for (const target of [`${home}/.config/pi/web-search.json`, `${home}/a`]) assert.equal(homeFileTarget(target, home), true, target);
  for (const target of [home, `${home}/`, `${home}/.gitconfig`, `${home}/.tmp/x`, `${home}/../x`, "/etc/x", `${home}x/a`, "relative", `${home}/a\nb`]) {
    assert.equal(homeFileTarget(target, home), false, target);
  }
});

test("files are shared only with a bubblewrap that keeps links from leading out of the sandbox as it places them, 0.12.0 or newer", () => {
  for (const version of ["0.12.0", "0.12.1", "0.13.1", "1.0.0"]) assert.equal(sharedFilesRefusal(version), undefined, version);
  for (const version of ["0.11.9", "0.8.0", "0.9.0"]) assert.match(sharedFilesRefusal(version)!, new RegExp(`bubblewrap ${version.replace(/\./g, "\\.")} predates 0\\.12\\.0`), version);
  for (const version of [null, "", "0.12", "x.y.z"]) assert.match(sharedFilesRefusal(version)!, /can't be told/, String(version));
});

test("a shared file is left out where the agent put a link or another kind of file on its way, in the session's home", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pikibun-extension-home-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(homeFileClear(home, ".config/pi/web-search.json"), true, "nothing there yet");
  await mkdir(join(home, ".config", "pi"), { recursive: true });
  assert.equal(homeFileClear(home, ".config/pi/web-search.json"), true);
  await writeFile(join(home, ".config", "pi", "web-search.json"), "");
  assert.equal(homeFileClear(home, ".config/pi/web-search.json"), true, "the empty file a previous start left");
  await rm(join(home, ".config", "pi"), { recursive: true });
  await symlink("/etc", join(home, ".config", "pi"));
  assert.equal(homeFileClear(home, ".config/pi/web-search.json"), false, "a link in its directories");
  await rm(join(home, ".config", "pi"));
  await mkdir(join(home, ".config", "pi"));
  await symlink("/etc/passwd", join(home, ".config", "pi", "web-search.json"));
  assert.equal(homeFileClear(home, ".config/pi/web-search.json"), false, "a link in its place");
  await rm(join(home, ".config", "pi", "web-search.json"));
  await mkdir(join(home, ".config", "pi", "web-search.json"));
  assert.equal(homeFileClear(home, ".config/pi/web-search.json"), false, "a directory in its place");
});

test("the extension process starts again with the files shared with its extensions, as they change", async () => {
  const launches: FileBind[][] = [];
  const launch: WorkerLaunch = async (handlers, _mounts, files = []) => {
    launches.push([...files]);
    let alive = true;
    return {
      send: message => {
        const id = (message as { id?: number }).id;
        if (alive && typeof id === "number") queueMicrotask(() => handlers.reply({ id, value: { errors: [], tools: [] } }));
      },
      hold: () => {},
      kill: () => { if (alive) { alive = false; handlers.ended("it was killed"); } },
      exited: Promise.resolve(),
    };
  };
  const first = { source: "/home/ada/.pi/agent/web-search.json", target: "/sessions/s/home/.config/pi/web-search.json" };
  let shared: FileBind[] = [first];
  let clock = 1_000_000;
  const asked: string[] = [];
  const warnings: string[] = [];
  const channel = new ProcessChannel({ directory: "/sessions/s/worktree", warn: (_source, message) => { warnings.push(message); }, launch, now: () => clock,
    mountAllowed: path => !path.startsWith("/etc/"), files: async source => { asked.push(source); return source.startsWith("npm:pi-web-access@") ? shared : []; } });
  const source = "npm:pi-web-access@0.46.0";
  const emit = () => channel.call("emit", { source, settings: {}, event: { type: "turn_start", turnIndex: 0, timestamp: 0 } } as never);
  await channel.call("open", { source, files: ["/x/index.ts"], models: [] });
  await channel.call("open", { source: "npm:other@1.0.0", files: ["/y/index.ts"], models: [] });
  assert.deepEqual(launches, [[first]], "the first start has them, and an extension without any adds none");
  shared = [];
  await emit();
  assert.equal(launches.length, 1, "the list is asked for again only after a while");
  clock += FILES_REFRESH_MS;
  await emit();
  assert.deepEqual(launches, [[first], []], "one no longer shared is gone once the list is asked for again");
  assert.ok(warnings.some(message => message.includes("the host's files shared with its extensions")), warnings.join("\n"));
  assert.deepEqual(asked.slice(-2).sort(), ["npm:other@1.0.0", source], "each open extension is asked about");
  clock += FILES_REFRESH_MS;
  await emit();
  assert.equal(launches.length, 2, "unchanged, it keeps running");
  shared = [{ ...first, stamp: "replaced" }];
  clock += FILES_REFRESH_MS;
  await emit();
  assert.deepEqual(launches.at(-1), [first], "a file saved anew starts it again, so the bind holds the new file");
  shared = [{ source: "/etc/shadow", target: "/sessions/s/home/shadow" }];
  for (let round = 0; round < 2; round++) {
    clock += FILES_REFRESH_MS;
    await emit();
  }
  assert.deepEqual(launches.at(-1), [], "a path the sandbox refuses is never given");
  assert.equal(warnings.filter(message => message.startsWith("/etc/shadow")).length, 1, "and the session is told so once");
  await channel.close();

  const failing = new ProcessChannel({ directory: "/sessions/s/worktree", warn: () => {}, launch, files: async () => { throw new Error("no configuration"); } });
  const opened = await failing.call("open", { source, files: ["/x/index.ts"], models: [] });
  assert.deepEqual(opened.value.errors, [], "an extension still opens when the host's configuration can't be read");
  await failing.close();
});
