import { programArguments, programShellCommand, shellQuote, workDirectory } from "./program-command.js";

export const pythonPrograms = Object.freeze(["python3", "pip", "pip3", "uv", "uvx", "poetry", "pytest"] as const);
export type PythonProgram = (typeof pythonPrograms)[number];

export const PYTHON_ENVIRONMENT = "NO_COLOR=1 PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 POETRY_NO_INTERACTION=1 UV_NO_PROGRESS=1";

const valued: Readonly<Record<string, ReadonlySet<string>>> = {
  python3: new Set(["-W", "-X", "-c", "-m"]),
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

function launched(args: readonly string[], from: number, options: ReadonlySet<string> = new Set()): { name: string; index: number } | undefined {
  for (let index = from; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return index + 1 < args.length ? { name: packageName(args[index + 1]!), index: index + 1 } : undefined;
    if (arg.startsWith("-")) { if (!arg.includes("=") && options.has(arg)) index++; continue; }
    return { name: packageName(arg), index };
  }
  return undefined;
}

const interpreter = (name: string) => /^python(3(\.\d+)?)?$/.test(name);

const packageName = (spec: string) => spec.split(/[=<>~!@[\s]/)[0]!.toLowerCase();

export function packageIndexAccountCommand(program: string, args: readonly string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (program === "twine") {
    const command = positionals(args)[0]?.arg;
    return command === "upload" || command === "register" ? `twine ${command}` : undefined;
  }
  if (interpreter(program)) {
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
  const launch = (from: number) => {
    const next = launched(args, from, options);
    return next ? packageIndexAccountCommand(next.name, args.slice(next.index + 1), depth + 1) : undefined;
  };
  const first = found[0];
  if (program === "uvx") return launch(0);
  if (program === "uv") {
    if (first?.arg === "publish") return "uv publish";
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
  directory: string;
  args: string[];
  venv?: string;
}

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

export function pythonShellCommand(request: PythonRequest, platform: NodeJS.Platform = process.platform): string {
  const venv = request.venv ? { firstHere: `${request.venv}/${platform === "win32" ? "Scripts" : "bin"}`, prefix: `VIRTUAL_ENV="$PWD"/${shellQuote(request.venv)} ` } : undefined;
  const program = platform === "win32" && request.program === "python3" ? "python" : request.program;
  return programShellCommand({ directory: request.directory, path: "/usr/local/bin", ...(venv ? { firstHere: venv.firstHere } : {}),
    prefix: `${venv?.prefix ?? ""}${PYTHON_ENVIRONMENT}`, program, args: request.args });
}
