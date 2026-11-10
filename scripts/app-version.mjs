#!/usr/bin/env node
// Stamps the version a release packages into the client (apps/nsh/src/app-version.ts), which NSH can't read at
// runtime: the app shows it and compares it with GitHub's releases to offer an update. Run before `nsh package`:
//   node scripts/app-version.mjs 1.2.3-beta.1
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

const version = process.argv[2] ?? "";
if (!VERSION.test(version)) {
  console.error(`Not a semantic version: ${JSON.stringify(version)}. Usage: node scripts/app-version.mjs 1.2.3`);
  process.exit(1);
}
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "nsh", "src", "app-version.ts");
writeFileSync(file, `export const APP_VERSION: string = ${JSON.stringify(version)};\n`);
console.error(`The client is version ${version} (${path.relative(process.cwd(), file)}).`);
