#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const usage = "Usage: node scripts/app-version.mjs 1.2.3 [the pikibun command's version, the latest cli-v tag at HEAD by default]";

const version = process.argv[2] ?? "";
if (!VERSION.test(version)) {
  console.error(`Not a semantic version: ${JSON.stringify(version)}. ${usage}`);
  process.exit(1);
}

function releasedCli() {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "cli-v*", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return tag.slice("cli-v".length);
  } catch (error) {
    console.error(`No cli-v tag at or before HEAD (${String(error.stderr ?? error.message).trim()}): check out the whole history with its tags (fetch-depth: 0). ${usage}`);
    process.exit(1);
  }
}

const cli = process.argv[3] ?? releasedCli();
if (!VERSION.test(cli)) {
  console.error(`Not a semantic version for the pikibun command: ${JSON.stringify(cli)}. ${usage}`);
  process.exit(1);
}
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "nsh", "src", "app-version.ts");
writeFileSync(file, `export const APP_VERSION: string = ${JSON.stringify(version)};\nexport const CLI_VERSION: string = ${JSON.stringify(cli)};\n`);
console.error(`The client is version ${version}, and installs pikibun ${cli} into its own folder (${path.relative(process.cwd(), file)}).`);
