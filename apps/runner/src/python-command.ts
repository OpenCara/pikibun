import { programArguments, programShellCommand, shellQuote, workDirectory } from "./program-command.js";

/*
 * The python tool (piki:python, #163): Python and its package tools without a shell, as the node tool is for Node.js.
 * The agent names the program and gives its arguments as a list, and a directory of the worktree; the session runs
 * exactly that program there, which its approval card shows as one sandboxed command. Its calls are decided as bash
 * commands are: `pytest` and `python3 script.py` run whatever the project or the script says.
 */

/** The programs the python tool runs: the interpreter, and the package and test tools sessions used. */
export const pythonPrograms = Object.freeze(["python3", "pip", "pip3", "uv", "uvx", "poetry", "pytest"] as const);
export type PythonProgram = (typeof pythonPrograms)[number];

/**
 * Fixed for every call: no colours, no prompt (input is closed, so one would only fail), no pip version check, and
 * the host's toolchain directory after the sandbox's PATH, where uv and poetry install.
 */
const PYTHON_ENVIRONMENT = "NO_COLOR=1 PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 POETRY_NO_INTERACTION=1 UV_NO_PROGRESS=1";

/** Options that take the next argument as their value, before the command or module they run. */
const valued: Readonly<Record<string, ReadonlySet<string>>> = {
  python3: new Set(["-W", "-X", "-c", "-m"]),
  // uv's global options and those of run, tool run and uvx that take a value (review of #186).
  uv: new Set(["--directory", "--project", "--config-file", "--cache-dir", "--python", "-p", "--color", "--with", "-w", "--with-requirements",
    "--with-editable", "--from", "--package", "--extra", "--group", "--only-group", "--no-group", "--env-file", "--index", "--index-url",
    "--default-index", "--extra-index-url", "--find-links", "-f", "--index-strategy", "--keyring-provider", "--resolution", "--prerelease",
    "--exclude-newer", "--config-setting", "-C", "--python-preference", "--allow-insecure-host", "--upgrade-package", "-P", "--reinstall-package",
    "--refresh-package", "--no-binary-package", "--no-build-package", "--link-mode"]),
  uvx: new Set(["--from", "--with", "-w", "--with-requirements", "--with-editable", "--python", "-p", "--index", "--index-url", "--default-index",
    "--extra-index-url", "--find-links", "-f", "--index-strategy", "--keyring-provider", "--resolution", "--prerelease", "--exclude-newer",
    "--config-setting", "-C", "--python-preference", "--allow-insecure-host", "--directory", "--project", "--cache-dir", "--color", "--config-file"]),
  poetry: new Set(["--directory", "-C", "--project", "-P"]),
};

/** The arguments' positional ones before --, each with where it is, skipping options and their values. */
function positionals(args: readonly string[], options: ReadonlySet<string> = new Set()): { arg: string; index: number }[] {
  const found: { arg: string; index: number }[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) { if (!arg.includes("=") && options.has(arg)) index++; continue; }
    found.push({ arg, index });
  }
  return found;
}

/**
 * The program a launcher runs, from `args[from]` on: its first argument past options and their values, or the first
 * one after a `--` (`uv run -- twine upload`), with where it is.
 */
function launched(args: readonly string[], from: number, options: ReadonlySet<string> = new Set()): { name: string; index: number } | undefined {
  for (let index = from; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return index + 1 < args.length ? { name: packageName(args[index + 1]!), index: index + 1 } : undefined;
    if (arg.startsWith("-")) { if (!arg.includes("=") && options.has(arg)) index++; continue; }
    return { name: packageName(arg), index };
  }
  return undefined;
}

/** Python's interpreter by any of its names: python3, python, python3.12. A virtual environment has each. */
const interpreter = (name: string) => /^python(3(\.\d+)?)?$/.test(name);

/** A package's name without the version a launcher may give it: twine==5 is twine, twine@5 too. */
const packageName = (spec: string) => spec.split(/[=<>~!@[\s]/)[0]!.toLowerCase();

/**
 * The command that acts on a package index as an account that `program` would run with `args`, if any: publishing
 * (`uv publish`, `poetry publish`, twine's `upload` and `register`), and storing credentials (`uv auth`, `poetry config
 * http-basic.*` or `pypi-token.*`), followed through what launches twine by name (`python3 -m twine`, `uvx twine`,
 * `uv tool run twine`, `uv run twine`, `poetry run twine`). A program that runs any other way (a script) isn't
 * followed: the check keeps the plain forms off the cards, while the card's approval is what stands for the rest.
 */
export function packageIndexAccountCommand(program: string, args: readonly string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (program === "twine") {
    const command = positionals(args)[0]?.arg;
    return command === "upload" || command === "register" ? `twine ${command}` : undefined;
  }
  if (interpreter(program)) {
    // python3 [options] -m module args: the module runs as a program.
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "-m") { const module = args[index + 1]; return module ? packageIndexAccountCommand(packageName(module), args.slice(index + 2), depth + 1) : undefined; }
      if (arg.startsWith("-m") && arg.length > 2) return packageIndexAccountCommand(packageName(arg.slice(2)), args.slice(index + 1), depth + 1);
      if (arg === "-c" || !arg.startsWith("-")) return undefined;
      if (valued.python3!.has(arg)) index++;
    }
    return undefined;
  }
  const options = valued[program] ?? new Set<string>();
  const found = positionals(args, options);
  // What a launcher runs, past its options, its values and a "--": followed as that program would be.
  const launch = (from: number) => {
    const next = launched(args, from, options);
    return next ? packageIndexAccountCommand(next.name, args.slice(next.index + 1), depth + 1) : undefined;
  };
  const first = found[0];
  if (program === "uvx") return launch(0);
  if (program === "uv") {
    if (first?.arg === "publish") return "uv publish";
    // uv auth login, logout and token store and show an index's credentials (review of #186).
    if (first?.arg === "auth") return "uv auth";
    if (first?.arg === "tool" && found[1]?.arg === "run") return launch(found[1].index + 1);
    if (first?.arg === "run") return launch(first.index + 1);
    return undefined;
  }
  if (program === "poetry") {
    if (first?.arg === "publish") return "poetry publish";
    if (first?.arg === "config" && found.slice(1).some(({ arg }) => /^(http-basic|pypi-token|certificates)\./i.test(arg))) return "poetry config (credentials)";
    if (first?.arg === "run") return launch(first.index + 1);
  }
  return undefined;
}

export interface PythonRequest {
  program: PythonProgram;
  /** The worktree directory it runs in, relative and without `..`: "." for the worktree itself. */
  directory: string;
  args: string[];
  /** A virtual environment's directory, relative to `directory`, whose bin is looked in first. */
  venv?: string;
}

/** The python tool's call as it runs, or an error saying what it refused. */
export function pythonRequest(input: { program: unknown; args?: unknown; directory?: unknown; venv?: unknown }): PythonRequest {
  if (typeof input.program !== "string" || !(pythonPrograms as readonly string[]).includes(input.program)) {
    throw new Error(`program is one of ${pythonPrograms.join(", ")}`);
  }
  const program = input.program as PythonProgram;
  const args = programArguments(input.args ?? [], '["-m", "pytest"]');
  const command = packageIndexAccountCommand(program, args);
  if (command !== undefined) throw new Error(`${command} acts on a package index as an account, which sessions don't have: the python tool doesn't run it`);
  let venv: string | undefined;
  if (input.venv !== undefined) {
    try { venv = workDirectory(input.venv); } catch { throw new Error("venv is a virtual environment's directory where it runs, such as .venv"); }
    if (venv === ".") throw new Error("venv is a virtual environment's directory where it runs, such as .venv");
  }
  return { program, directory: workDirectory(input.directory), args, ...(venv ? { venv } : {}) };
}

/**
 * The shell command that runs `request`, as its card shows it. With a virtual environment its bin comes first on PATH,
 * as an absolute path, so python3, pip and pytest are the environment's wherever a program goes, and VIRTUAL_ENV
 * names it, as activating it would.
 */
export function pythonShellCommand(request: PythonRequest, platform: NodeJS.Platform = process.platform): string {
  // A virtual environment made on Windows keeps its programs in Scripts (review of #186).
  const venv = request.venv ? { firstHere: `${request.venv}/${platform === "win32" ? "Scripts" : "bin"}`, prefix: `VIRTUAL_ENV="$PWD"/${shellQuote(request.venv)} ` } : undefined;
  return programShellCommand({ directory: request.directory, path: "/usr/local/bin", ...(venv ? { firstHere: venv.firstHere } : {}),
    prefix: `${venv?.prefix ?? ""}${PYTHON_ENVIRONMENT}`, program: request.program, args: request.args });
}
