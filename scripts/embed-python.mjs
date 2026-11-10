import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sources = join(root, "apps", "runner", "src", "sandbox-python");
const target = join(root, "apps", "runner", "src", "sandbox-python.generated.ts");

const programs = [
  ["HELPER", "helper.py"],
  ["GIT_SHIM", "git_shim.py"],
  ["BROWSER_DRIVER", "browser.py"],
  ["SERVICE_DRIVER", "service.py"],
];

export function embedded() {
  const constants = programs.map(([name, file]) => `export const ${name}: string = ${JSON.stringify(readFileSync(join(sources, file), "utf8"))};`);
  return `${constants.join("\n\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wanted = embedded();
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { }
  if (process.argv.includes("--check")) {
    if (current !== wanted) {
      console.error("apps/runner/src/sandbox-python.generated.ts is out of date: run `pnpm python:embed`.");
      process.exit(1);
    }
  } else if (current !== wanted) writeFileSync(target, wanted);
}
