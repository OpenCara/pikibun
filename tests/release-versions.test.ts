import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareVersions } from "../packages/shared/src/managed-extensions.js";
import { compareReleaseVersions, latestExtensionRelease } from "../scripts/release-versions.mjs";

const scripts = join(import.meta.dirname, "..", "scripts");

test("an extension's latest release is its highest ext-<name>-v tag, a prerelease below its release, other lines' tags left out", () => {
  const tags = ["ext-pr-flow-v0.2.0", "ext-pr-flow-v0.10.0-beta.1", "ext-pr-flow-v0.9.0", "ext-pr-v9.0.0", "ext-pr-flow-other-v5.0.0", "ext-pr-flow-vnext", "cli-v1.0.0", " ext-pr-flow-v0.3.0 ", ""];
  assert.equal(latestExtensionRelease(tags, "pr-flow"), "0.10.0-beta.1");
  assert.equal(latestExtensionRelease([...tags, "ext-pr-flow-v0.10.0"], "pr-flow"), "0.10.0");
  assert.equal(latestExtensionRelease(tags, "pr"), "9.0.0");
  assert.equal(latestExtensionRelease(tags, "sub-agents"), undefined);
  const ordered = ["0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.beta", "0.1.0-beta", "0.1.0-beta.2", "0.1.0-beta.11", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "0.10.0", "1.0.0"];
  for (const a of ordered) for (const b of ordered) assert.equal(compareReleaseVersions(a, b), compareVersions(a, b), `${a} against ${b}, as connectors compare them`);
});

async function repository(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pikibun-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const file of ["set-release-version.mjs", "release-versions.mjs"]) await copyFile(join(scripts, file), join(root, "scripts", file));
  const manifest = (name: string, version: string) => `{\n  "name": "${name}",\n  "version": "${version}",\n  "type": "module"\n}\n`;
  await mkdir(join(root, "packages", "cli"), { recursive: true });
  await writeFile(join(root, "packages", "cli", "package.json"), manifest("pikibun", "0.9.0"));
  await writeFile(join(root, "packages", "cli", "npm-shrinkwrap.json"), JSON.stringify({ name: "pikibun", version: "0.9.0", packages: { "": { version: "0.9.0" } } }));
  for (const name of ["pr-flow", "sub-agents"]) {
    await mkdir(join(root, "extensions", name), { recursive: true });
    await writeFile(join(root, "extensions", name, "package.json"), manifest(`@pikibun/pi-${name}`, "0.1.0"));
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.name=Release", "-c", "user.email=release@example.invalid", "add", ".");
  git("-c", "user.name=Release", "-c", "user.email=release@example.invalid", "commit", "-q", "-m", "first");
  const release = (...args: string[]) => execFileSync(process.execPath, [join(root, "scripts", "set-release-version.mjs"), ...args], { cwd: root, encoding: "utf8", stdio: "pipe" });
  const version = async (...path: string[]) => JSON.parse(await readFile(join(root, ...path), "utf8")).version as string;
  return { root, git, release, version };
}

test("a connector release takes its version from its tag and bundles each extension under its latest release tag, or as committed without one", async t => {
  const r = await repository(t);
  r.git("tag", "ext-pr-flow-v0.2.0");
  r.git("tag", "ext-pr-flow-v0.3.0");
  const output = r.release("0.37.0", "cli");
  assert.equal(await r.version("packages", "cli", "package.json"), "0.37.0");
  assert.equal(await r.version("packages", "cli", "npm-shrinkwrap.json"), "0.37.0");
  assert.equal(await r.version("extensions", "pr-flow", "package.json"), "0.3.0");
  assert.equal(await r.version("extensions", "sub-agents", "package.json"), "0.1.0");
  assert.match(output, /bundles extensions\/pr-flow as 0\.3\.0/);
  assert.match(output, /bundles extensions\/sub-agents as 0\.1\.0, as committed: it has no release yet/);
});

test("a tag on a later commit isn't the bundled copy's release", async t => {
  const r = await repository(t);
  r.git("tag", "ext-pr-flow-v0.2.0");
  r.git("-c", "user.name=Release", "-c", "user.email=release@example.invalid", "commit", "-q", "--allow-empty", "-m", "later");
  r.git("tag", "ext-pr-flow-v0.3.0");
  r.git("checkout", "-q", "HEAD~1");
  r.release("0.37.0", "cli");
  assert.equal(await r.version("extensions", "pr-flow", "package.json"), "0.2.0");
});

test("an extension release takes its version from its tag, whatever is committed", async t => {
  const r = await repository(t);
  assert.match(r.release("0.4.0-beta.1", "extension:pr-flow"), /@pikibun\/pi-pr-flow@0\.4\.0-beta\.1/);
  assert.equal(await r.version("extensions", "pr-flow", "package.json"), "0.4.0-beta.1");
  assert.equal(await r.version("extensions", "sub-agents", "package.json"), "0.1.0");
  assert.throws(() => r.release("0.4.0", "extension:missing"), /No Pi extension missing/);
  assert.throws(() => r.release("latest", "extension:pr-flow"), /usage/);
});

test("one target a run: a connector's stamping can't undo the version an extension's release just set", async t => {
  const r = await repository(t);
  assert.throws(() => r.release("0.4.0", "extension:pr-flow", "cli"), /Name one target/);
  assert.equal(await r.version("extensions", "pr-flow", "package.json"), "0.1.0");
  assert.equal(await r.version("packages", "cli", "package.json"), "0.9.0");
});
