import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const copies = [
  { from: "packages/shared/src/non-public-addresses.ts", to: "extensions/context-files/non-public-addresses.ts" },
];

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

export function staleCopies() {
  return copies.filter(({ from, to }) => {
    try { return read(to) !== read(from); } catch { return true; }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const stale = staleCopies();
    for (const { from, to } of stale) console.error(`${to} differs from ${from}: run node scripts/copy-shared-files.mjs`);
    process.exit(stale.length ? 1 : 0);
  }
  for (const { from, to } of copies) writeFileSync(new URL(to, root), read(from));
}
