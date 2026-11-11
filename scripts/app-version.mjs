#!/usr/bin/env node
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
