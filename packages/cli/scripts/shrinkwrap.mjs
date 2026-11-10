import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(packageDir, "package.json");
const shrinkwrapPath = join(packageDir, "npm-shrinkwrap.json");
const read = path => JSON.parse(readFileSync(path, "utf8"));

if (process.argv.includes("--check")) {
  const manifest = read(manifestPath);
  let root;
  try { root = read(shrinkwrapPath).packages?.[""]; } catch { root = undefined; }
  const fields = ["name", "version", "dependencies", "devDependencies"];
  const stale = !root || fields.some(field => !isDeepStrictEqual(root[field], manifest[field]));
  if (stale) {
    console.error("npm-shrinkwrap.json does not match package.json; run `pnpm --filter pikibun run shrinkwrap`.");
    process.exit(1);
  }
} else {
  const scratch = mkdtempSync(join(tmpdir(), "pikibun-shrinkwrap-"));
  try {
    copyFileSync(manifestPath, join(scratch, "package.json"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    const npm = (...args) => execFileSync("npm", args, { cwd: scratch, stdio: "inherit", env });
    npm("install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund");
    npm("shrinkwrap");
    copyFileSync(join(scratch, "npm-shrinkwrap.json"), shrinkwrapPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
