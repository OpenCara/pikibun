import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { latestExtensionRelease, RELEASE_VERSION } from "./release-versions.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [version, ...targets] = process.argv.slice(2);
if (!version || !RELEASE_VERSION.test(version)) {
  throw new Error("usage: set-release-version.mjs <version such as 1.2.3 or 1.2.3-beta.1> <cli | extension:NAME>...");
}
if (targets.length === 0) throw new Error("Name the target: cli, or extension:NAME for extensions/NAME.");

function setManifestVersion(path, to) {
  const manifest = readFileSync(path, "utf8").replace(/^(  "version": )"[^"]*"/m, (_, key) => key + JSON.stringify(to));
  if (JSON.parse(manifest).version !== to) throw new Error(`${path} has no top-level version field`);
  writeFileSync(path, manifest);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function stampBundledExtensions() {
  if (git("rev-parse", "--is-shallow-repository").trim() !== "false") {
    throw new Error("The checkout is shallow: fetch the whole history with its tags (fetch-depth: 0), so each bundled extension's latest release tag is there.");
  }
  const extensions = join(root, "extensions");
  for (const name of readdirSync(extensions).sort()) {
    const path = join(extensions, name, "package.json");
    if (!existsSync(path)) continue;
    const released = latestExtensionRelease(git("tag", "--merged", "HEAD", "--list", `ext-${name}-v*`).split("\n"), name);
    if (released) {
      setManifestVersion(path, released);
      console.log(`bundles extensions/${name} as ${released}, its latest release at this commit`);
    } else {
      console.log(`bundles extensions/${name} as ${JSON.parse(readFileSync(path, "utf8")).version}, as committed: it has no release yet`);
    }
  }
}

for (const target of targets) {
  if (target === "cli") {
    const cli = join(root, "packages", "cli");
    setManifestVersion(join(cli, "package.json"), version);
    const shrinkwrapPath = join(cli, "npm-shrinkwrap.json");
    const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
    shrinkwrap.version = version;
    shrinkwrap.packages[""].version = version;
    writeFileSync(shrinkwrapPath, JSON.stringify(shrinkwrap, null, 2) + "\n");
    console.log(`pikibun@${version}`);
    stampBundledExtensions();
  } else if (target.startsWith("extension:")) {
    const name = target.slice("extension:".length);
    const path = join(root, "extensions", name, "package.json");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !existsSync(path)) throw new Error(`No Pi extension ${name} in extensions/.`);
    setManifestVersion(path, version);
    console.log(`${JSON.parse(readFileSync(path, "utf8")).name}@${version}`);
  } else {
    throw new Error(`Unknown target ${target}: use cli or extension:NAME.`);
  }
}
