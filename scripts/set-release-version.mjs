import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [version, ...targets] = process.argv.slice(2);
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("usage: set-release-version.mjs <version such as 1.2.3 or 1.2.3-beta.1> <cli | extension:NAME>...");
}
if (targets.length === 0) throw new Error("Name the target: cli, or extension:NAME for extensions/NAME.");

function setManifestVersion(path) {
  const manifest = readFileSync(path, "utf8").replace(/^(  "version": )"[^"]*"/m, (_, key) => key + JSON.stringify(version));
  if (JSON.parse(manifest).version !== version) throw new Error(`${path} has no top-level version field`);
  writeFileSync(path, manifest);
}

for (const target of targets) {
  if (target === "cli") {
    const cli = join(root, "packages", "cli");
    setManifestVersion(join(cli, "package.json"));
    const shrinkwrapPath = join(cli, "npm-shrinkwrap.json");
    const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
    shrinkwrap.version = version;
    shrinkwrap.packages[""].version = version;
    writeFileSync(shrinkwrapPath, JSON.stringify(shrinkwrap, null, 2) + "\n");
    console.log(`pikibun@${version}`);
  } else if (target.startsWith("extension:")) {
    const name = target.slice("extension:".length);
    const path = join(root, "extensions", name, "package.json");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !existsSync(path)) throw new Error(`No Pi extension ${name} in extensions/.`);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.version !== version) {
      throw new Error(`extensions/${name}/package.json is at ${manifest.version}, not ${version}: commit the version to main first, then tag that commit. Connectors compare a pinned version with the one they bundle, which is the committed one.`);
    }
    console.log(`${manifest.name}@${version}`);
  } else {
    throw new Error(`Unknown target ${target}: use cli or extension:NAME.`);
  }
}
