import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionsDirectory = join(root, "extensions");
const builtins = new Set(builtinModules);

export function extensionNames() {
  return readdirSync(extensionsDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(extensionsDirectory, entry.name, "package.json")))
    .map(entry => entry.name)
    .sort();
}

export function packedFiles(directory) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const result = JSON.parse(output);
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
  return packed.files.map(file => file.path);
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function packageProblems(directory, files = packedFiles(directory)) {
  const problems = [];
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const packed = new Set(files);
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  const expectedDirectory = relative(root, directory).split("\\").join("/");

  if (manifest.private) problems.push("is private: npm refuses to publish it");
  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@opencara/pi-")) problems.push(`is named ${manifest.name}, not @opencara/pi-…`);
  if (!manifest.keywords?.includes("pi-package")) problems.push("lacks the pi-package keyword Pi's package gallery lists");
  if (!manifest.license) problems.push("names no license");
  if (manifest.repository?.url !== "https://github.com/OpenCara/pikibun.git" || manifest.repository?.directory !== expectedDirectory) {
    problems.push(`has no repository at https://github.com/OpenCara/pikibun.git, directory ${expectedDirectory}: npm provenance needs it`);
  }
  if (!packed.has("README.md")) problems.push("packs no README.md");

  const entries = manifest.pi?.extensions ?? [];
  if (entries.length === 0) problems.push("names no pi.extensions");
  for (const entry of entries) {
    if (!packed.has(posix.normalize(entry))) problems.push(`packs no ${entry}, which pi.extensions names`);
  }

  for (const file of files.filter(path => /\.[cm]?[jt]s$/.test(path) && !path.endsWith(".d.ts"))) {
    const source = readFileSync(join(directory, file), "utf8");
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(file), specifier));
        if (!packed.has(target) && !packed.has(target.replace(/\.js$/, ".ts"))) problems.push(`${file} imports ${specifier}, which the package doesn't pack`);
      } else if (!specifier.startsWith("node:") && !builtins.has(specifier) && !declared.has(packageName(specifier))) {
        problems.push(`${file} imports ${specifier}, which is in neither dependencies nor peerDependencies`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2);
  let failed = false;
  for (const name of names.length ? names : extensionNames()) {
    const directory = join(extensionsDirectory, name);
    if (!existsSync(join(directory, "package.json"))) {
      console.error(`extensions/${name}: no such Pi extension`);
      failed = true;
      continue;
    }
    const problems = packageProblems(directory);
    for (const problem of problems) console.error(`extensions/${name} ${problem}`);
    if (problems.length === 0) console.log(`extensions/${name}: ready to publish`);
    failed ||= problems.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
