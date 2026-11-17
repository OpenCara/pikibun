import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./program-command.js";

export const LONG_RUN_DEFAULT_SECONDS = 1200;
export const callEnvironmentLimits = Object.freeze({ variables: 16, value: 4096 });

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = /^(PATH|LD_.*|DYLD_.*)$/;

export function callEnvironment(value: unknown): string {
  if (value === undefined) return "";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("env is an object of variable names and their values, such as {\"TMPDIR\": \"/tmp\"}");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > callEnvironmentLimits.variables) throw new Error(`env sets at most ${callEnvironmentLimits.variables} variables`);
  return entries.map(([name, setting]) => {
    if (!VARIABLE.test(name)) throw new Error(`env names a variable with letters, digits and _, not ${JSON.stringify(name.slice(0, 64))}`);
    if (RESERVED.test(name)) throw new Error(`env can't set ${name}: the tool sets it itself`);
    if (typeof setting !== "string" || setting.includes("\0") || setting.length > callEnvironmentLimits.value) {
      throw new Error(`env's ${name} is a string of at most ${callEnvironmentLimits.value} characters, without NUL`);
    }
    return `${name}=${shellQuote(setting)}`;
  }).join(" ");
}

const LONG_SCRIPT = /^(test|tests|t|dev|start|serve|server|preview|watch|bench|e2e)(?::.*)?$/;
const LONG_RUNNERS = new Set(["vitest", "jest", "mocha", "ava", "tap", "playwright", "cypress", "vite", "serve", "http-server", "next", "nuxt", "astro", "webpack-dev-server", "nodemon"]);
const LONG_PYTHON = new Set(["pytest", "unittest", "http.server", "uvicorn", "gunicorn", "flask", "runserver", "tox", "nox"]);
const LONG_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  cargo: new Set(["test", "t", "run", "r", "bench", "watch", "nextest"]),
  go: new Set(["test", "run"]),
  dotnet: new Set(["test", "run", "watch"]),
};

const VALUED = new Set(["--filter", "-F", "--dir", "-C", "--workspace", "-w", "--prefix", "--cwd", "--manifest-path", "-p", "--package"]);

function words(args: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) { if (!arg.includes("=") && VALUED.has(arg)) index++; continue; }
    found.push(arg);
  }
  return found;
}

const NODE_VALUED = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "--conditions", "-C",
  "--input-type", "--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination", "--test-concurrency", "--test-timeout", "--watch-path"]);

function nodeOptions(args: readonly string[]): string[] {
  const options: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-") || arg === "--" || arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print") break;
    options.push(arg);
    if (!arg.includes("=") && NODE_VALUED.has(arg)) index++;
  }
  return options;
}

export function longRun(program: string, args: readonly string[]): boolean {
  const positional = words(args);
  if (program === "node") return nodeOptions(args).some(arg => arg === "--test" || arg.startsWith("--test=") || arg === "--watch" || arg.startsWith("--watch="));
  if (program === "npm" || program === "pnpm" || program === "yarn") {
    const [first, second] = positional;
    if (first === "run" || first === "run-script") return !!second && LONG_SCRIPT.test(second);
    if (first === "exec" || first === "dlx" || first === "x") return !!second && LONG_RUNNERS.has(second);
    return !!first && (LONG_SCRIPT.test(first) || LONG_RUNNERS.has(first));
  }
  if (program === "npx" || program === "corepack") return positional.some(word => LONG_RUNNERS.has(word.replace(/@[^@/]*$/, "")));
  if (["python3", "pytest", "uv", "uvx", "poetry"].includes(program)) return program === "pytest" || args.some(arg => LONG_PYTHON.has(arg));
  if (program === "make") return positional.some(word => LONG_SCRIPT.test(word));
  const subcommands = LONG_SUBCOMMANDS[program];
  return !!subcommands && subcommands.has(positional.find(word => !word.startsWith("+")) ?? "");
}

export function defaultedTimeout(program: string, args: readonly string[], given: number | undefined): { seconds?: number; defaulted: boolean } {
  if (given !== undefined) return { seconds: given, defaulted: false };
  return longRun(program, args) ? { seconds: LONG_RUN_DEFAULT_SECONDS, defaulted: true } : { defaulted: false };
}

export function timedOutHint(result: string | undefined): string | undefined {
  if (!result || !/exceeded (?:\d+ms|its) time limit/.test(result)) return undefined;
  return `It stopped at its time limit: a test suite or a server run without timeout_seconds gets at most ${LONG_RUN_DEFAULT_SECONDS} seconds. `
    + "Give timeout_seconds to one that needs longer.";
}

const manifests: readonly { file: string; pattern: RegExp }[] = [
  { file: "package.json", pattern: /ENOENT[^\n]*package\.json|ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|ERR_PNPM_NO_PKG_MANIFEST|No package\.json (?:was )?found|Couldn't find a package\.json/i },
  { file: "pyproject.toml", pattern: /could not find a pyproject\.toml|No `pyproject\.toml` found|No such file or directory: '(?:requirements[^']*\.txt|setup\.py)'|Could not open requirements file/i },
  { file: "Cargo.toml", pattern: /could not find `Cargo\.toml`/ },
  { file: "go.mod", pattern: /go\.mod file not found|cannot find main module/ },
  { file: "Makefile", pattern: /No targets specified and no makefile found/ },
];

export function clones(worktree: string): string[] {
  try {
    return readdirSync(worktree, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(worktree, entry.name, ".git")))
      .map(entry => entry.name).sort();
  } catch { return []; }
}

export function directoryHint(options: { worktree: string; directory: string; status: string; result: string | undefined }): string | undefined {
  if (options.directory !== "." || options.status !== "failed" || !options.result) return undefined;
  const missing = manifests.find(item => item.pattern.test(options.result!) && !existsSync(join(options.worktree, item.file)));
  if (!missing) return undefined;
  const found = clones(options.worktree).filter(name => existsSync(join(options.worktree, name, missing.file)));
  if (!found.length) return undefined;
  return `It ran at the worktree's top, which has no ${missing.file}: run it again with directory, the clone to run in, such as directory: ${JSON.stringify(found[0])}`
    + `${found.length > 1 ? ` (clones with one: ${found.join(", ")})` : ""}.`;
}
