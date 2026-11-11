import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    'import { shared } from "../../packages/shared/src/thing.ts";',
    'import lodash from "lodash";',
    'const later = () => import("left-pad");',
    'const words = ["from", "import", "nothing"];',
  ].join("\n"));
  const problems = packageProblems(directory, ["package.json", "index.ts"]);
  assert.deepEqual(problems.filter(problem => !problem.startsWith("has no repository")), [
    "is private: npm refuses to publish it",
    "is named pi-thing, not @opencara/pi-…",
    "lacks the pi-package keyword Pi's package gallery lists",
    "names no license",
    "packs no README.md",
    "packs no ./missing.ts, which pi.extensions names",
    "index.ts imports ./helper.ts, which the package doesn't pack",
    "index.ts imports ../../packages/shared/src/thing.ts, which the package doesn't pack",
    "index.ts imports lodash, which is in neither dependencies nor peerDependencies",
    "index.ts imports left-pad, which is in neither dependencies nor peerDependencies",
  ]);
  assert.equal(problems.filter(problem => problem.startsWith("has no repository")).length, 1);
});
