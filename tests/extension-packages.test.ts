import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { extensionNames, packageProblems, packedFiles } from "../scripts/check-extension-packages.mjs";

const extensions = resolve(import.meta.dirname, "..", "extensions");

test("every Pi extension in extensions/ is a package release-extensions.yml can publish", () => {
  assert.deepEqual(extensionNames(), ["context-files", "pr-flow", "prompt-audit"]);
  for (const name of extensionNames()) {
    assert.deepEqual(packageProblems(join(extensions, name)), [], `extensions/${name}`);
  }
});

test("npm packs each extension's modules, README and manifest, and nothing else", () => {
  assert.deepEqual(packedFiles(join(extensions, "pr-flow")).sort(), ["README.md", "index.ts", "package.json", "pr-flow.ts"]);
});

test("the package check finds what would break a published extension", async t => {
  const directory = await mkdtemp(join(tmpdir(), "extension-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "pi-thing",
    version: "0.1.0",
    private: true,
    keywords: ["pi-extension"],
    pi: { extensions: ["./index.ts", "./missing.ts"] },
    peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
  }));
  await writeFile(join(directory, "index.ts"), [
    'import { readFile } from "node:fs/promises";',
    'import { join } from "path";',
    'import type { ExtensionFactory } from "@earendil-works/pi-coding-agent/dist/types";',
    'import { helper } from "./helper.ts";',
    'import { util } from "./util.js";',
    'import { bare } from "./bare";',
    'import { nested } from "./lib";',
    'import { shared } from "../../packages/shared/src/thing.ts";',
    'import lodash from "lodash";',
    'const later = () => import("left-pad");',
    'const words = ["from", "import", "nothing"];',
  ].join("\n"));
  await mkdir(join(directory, "lib"));
  for (const file of ["util.ts", "bare.ts", "lib/index.ts"]) await writeFile(join(directory, file), "export const value = 1;\n");
  const problems = packageProblems(directory, { files: ["package.json", "index.ts", "util.ts", "bare.ts", "lib/index.ts"], release: true });
  assert.deepEqual(problems.filter(problem => !problem.startsWith("has no repository")), [
    "is private: npm refuses to publish it",
    "is named pi-thing, not @opencara/pi-…",
    "lacks the pi-package keyword Pi's package gallery lists",
    "names no license",
    "packs no README.md",
    "packs no LICENSE: the release copies the repository's in first",
    "packs no ./missing.ts, which pi.extensions names",
    "index.ts imports ./helper.ts, which the package doesn't pack",
    "index.ts imports ../../packages/shared/src/thing.ts, which the package doesn't pack",
    "index.ts imports lodash, which is in neither dependencies nor peerDependencies",
    "index.ts imports left-pad, which is in neither dependencies nor peerDependencies",
  ]);
  assert.equal(problems.filter(problem => problem.startsWith("has no repository")).length, 1);
});

test("a release also needs the LICENSE the workflow copies in, which the repository's extensions don't commit", () => {
  const directory = join(extensions, "pr-flow");
  const files = packedFiles(directory);
  assert.deepEqual(packageProblems(directory, { files, release: true }), ["packs no LICENSE: the release copies the repository's in first"]);
  assert.deepEqual(packageProblems(directory, { files: [...files, "LICENSE"], release: true }), []);
});
