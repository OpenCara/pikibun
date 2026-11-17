import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const scope = "@earendil-works/";

type Manifest = Record<"dependencies" | "devDependencies" | "optionalDependencies", Record<string, string> | undefined>;

function scoped(path: string): Record<string, string> {
  const manifest = JSON.parse(read(path)) as Manifest;
  return Object.fromEntries([manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]
    .flatMap(group => Object.entries(group ?? {})).filter(([name]) => name.startsWith(scope)));
}

function lockedVersions(lockfile: string): { importers: Record<string, Record<string, { specifier: string; version: string }>>; packages: Map<string, Set<string>> } {
  const importers: Record<string, Record<string, { specifier: string; version: string }>> = {};
  const packages = new Map<string, Set<string>>();
  let section = "";
  let importer = "";
  let name = "";
  for (const line of lockfile.split("\n")) {
    const top = /^(\S[^:]*):\s*$/.exec(line);
    if (top) { section = top[1]!; importer = ""; name = ""; continue; }
    if (section === "importers") {
      const at = /^ {2}(\S[^:]*):\s*$/.exec(line);
      if (at) { importer = at[1]!; importers[importer] = {}; continue; }
      const dependency = /^ {6}'?(@earendil-works\/[^':]+)'?:\s*$/.exec(line);
      if (dependency) { name = dependency[1]!; importers[importer]![name] = { specifier: "", version: "" }; continue; }
      if (/^ {6}\S/.test(line)) { name = ""; continue; }
      const field = /^ {8}(specifier|version): (.+)$/.exec(line);
      if (field && name) importers[importer]![name]![field[1] as "specifier" | "version"] = field[2]!.trim();
      continue;
    }
    if (section === "packages" || section === "snapshots") {
      const entry = /^ {2}'?(@earendil-works\/[^@'(]+)@([^('":]+)/.exec(line);
      if (entry) {
        const versions = packages.get(entry[1]!) ?? new Set<string>();
        versions.add(entry[2]!);
        packages.set(entry[1]!, versions);
      }
    }
  }
  return { importers, packages };
}

test("the @earendil-works packages pin one exact version, the same in the root and connector manifests", () => {
  const ours = scoped("package.json");
  const connector = scoped("packages/cli/package.json");
  const versions = new Set(Object.values(ours));
  assert.ok(Object.keys(ours).length >= 5, "the root manifest names the Pi packages");
  assert.equal(versions.size, 1, `one version for every ${scope} package: ${JSON.stringify(ours)}`);
  const [version] = versions;
  assert.match(version!, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "an exact version, no range");
  assert.deepEqual(connector, ours, "packages/cli/package.json names the same packages at the same version: upgrade both together");
});

test("both lockfiles hold that version: pnpm-lock.yaml for the repository and npm-shrinkwrap.json for the published connector", () => {
  const [version] = new Set(Object.values(scoped("package.json")));
  const { importers, packages } = lockedVersions(read("pnpm-lock.yaml"));
  for (const importer of [".", "packages/cli"]) {
    const locked = importers[importer] ?? {};
    assert.deepEqual(Object.keys(locked).sort(), Object.keys(scoped(importer === "." ? "package.json" : `${importer}/package.json`)).sort(), `pnpm-lock.yaml's ${importer} importer`);
    for (const [name, entry] of Object.entries(locked)) {
      assert.equal(entry.specifier, version, `${name} in pnpm-lock.yaml's ${importer}: regenerate it with pnpm install`);
      assert.ok(entry.version === version || entry.version.startsWith(`${version}(`), `${name} resolves to ${entry.version} in pnpm-lock.yaml's ${importer}`);
    }
  }
  for (const [name, found] of packages) assert.deepEqual([...found], [version], `${name} in pnpm-lock.yaml's packages`);
  const shrinkwrap = JSON.parse(read("packages/cli/npm-shrinkwrap.json")) as { packages: Record<string, { version?: string }> };
  const wrapped = Object.entries(shrinkwrap.packages).filter(([path]) => /(?:^|\/)node_modules\/@earendil-works\/[^/]+$/.test(path));
  assert.ok(wrapped.length >= Object.keys(scoped("packages/cli/package.json")).length, "the shrinkwrap holds the connector's Pi packages");
  for (const [path, entry] of wrapped) {
    assert.equal(entry.version, version, `${path} in packages/cli/npm-shrinkwrap.json: regenerate it with pnpm --filter pikibun run shrinkwrap`);
  }
});

test("the lockfile reader finds a version that drifted", () => {
  const lockfile = [
    "importers:", "", "  .:", "    dependencies:", "      '@earendil-works/pi-ai':", "        specifier: 1.5.2", "        version: 1.5.2(ws@8.21.0)",
    "      hono:", "        specifier: 4.12.8", "        version: 4.12.8", "", "packages:", "", "  '@earendil-works/pi-ai@1.5.2':", "    resolution: {}",
    "  '@earendil-works/pi-ai@1.4.0':", "    resolution: {}", "", "snapshots:", "", "  '@earendil-works/pi-ai@1.5.2(ws@8.21.0)':", "    dependencies: {}",
  ].join("\n");
  const { importers, packages } = lockedVersions(lockfile);
  assert.deepEqual(importers, { ".": { "@earendil-works/pi-ai": { specifier: "1.5.2", version: "1.5.2(ws@8.21.0)" } } });
  assert.deepEqual([...packages.get("@earendil-works/pi-ai")!].sort(), ["1.4.0", "1.5.2"]);
});
