import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHostConfig, extensionFilePackage, hostConfigLimits, ownerOnlyHostConfig, parseExtensionFiles, parseHostConfigChange, readHostConfig } from "../packages/shared/src/host-config.js";
import { extensionFileBinds, hostFilePath, type FileBind } from "../apps/runner/src/extensions/files.js";
import { ProcessChannel, type WorkerLaunch } from "../apps/runner/src/extensions/process.js";
import { homeFileTarget } from "../apps/runner/src/sandbox.js";

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
    assert.deepEqual(extensionFileBinds(files, source, "/sessions/s/home", root), {
      binds: [{ source: real, target: "/sessions/s/home/.config/pi/web-search.json" }, { source: real, target: "/sessions/s/home/.pi/agent/web-search.json" }],
      missing: ["~/.pi/agent", "~/absent.json"],
    });
  }
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
  let shared: FileBind[] = [{ source: "/home/ada/.pi/agent/web-search.json", target: "/sessions/s/home/.config/pi/web-search.json" }];
  const warnings: string[] = [];
  const channel = new ProcessChannel({ directory: "/sessions/s/worktree", warn: (_source, message) => { warnings.push(message); }, launch,
    mountAllowed: path => !path.startsWith("/etc/"), files: async () => shared });
  const open = { source: "npm:pi-web-access@0.46.0", files: ["/x/index.ts"], models: [] };
  await channel.call("open", open);
  assert.deepEqual(launches, [shared], "the first start has them");
  await channel.call("open", open);
  assert.equal(launches.length, 1, "unchanged, it keeps running");
  shared = [];
  await channel.call("open", open);
  assert.deepEqual(launches, [[{ source: "/home/ada/.pi/agent/web-search.json", target: "/sessions/s/home/.config/pi/web-search.json" }], []], "one no longer shared is gone at the next start");
  assert.ok(warnings.some(message => message.includes("the host's files shared with its extensions")), warnings.join("\n"));
  shared = [{ source: "/etc/shadow", target: "/sessions/s/home/shadow" }];
  await channel.call("open", open);
  assert.equal(launches.length, 2, "a path the sandbox refuses is never given");
  await channel.close();
});
