import test from "node:test";
import assert from "node:assert/strict";
import { packageIndexAccountCommand, pythonRequest, pythonShellCommand } from "../apps/runner/src/python-command.js";

test("the python tool runs Python or its package and test tools, with its arguments as a list", () => {
  assert.deepEqual(pythonRequest({ program: "python3", args: ["-m", "pytest"], directory: "app" }), { program: "python3", directory: "app", args: ["-m", "pytest"] });
  assert.deepEqual(pythonRequest({ program: "pip", args: ["install", "-e", "."], venv: ".venv" }), { program: "pip", directory: ".", args: ["install", "-e", "."], venv: ".venv" });
  for (const program of ["bash", "python", "/usr/bin/python3", "python3; id", "twine", undefined]) {
    assert.throws(() => pythonRequest({ program, args: [] }), /program is one of/, String(program));
  }
  assert.throws(() => pythonRequest({ program: "python3", args: "-c 1" }), /as a list/);
  assert.throws(() => pythonRequest({ program: "python3", directory: "../x" }), /within the session's worktree/);
  for (const venv of ["../venv", "/opt/venv", ".", ""]) assert.throws(() => pythonRequest({ program: "pip", venv }), /venv is a virtual environment/, venv);
});

test("the python tool refuses commands that act on a package index as an account, through what launches them", () => {
  const refused: [string, string[]][] = [
    ["uv", ["publish"]], ["uv", ["--directory", "app", "publish"]], ["poetry", ["publish", "--build"]], ["poetry", ["-C", "app", "publish"]],
    ["poetry", ["config", "pypi-token.pypi", "secret"]], ["poetry", ["config", "http-basic.internal", "me", "pw"]],
    ["python3", ["-m", "twine", "upload", "dist/*"]], ["python3", ["-mtwine", "upload", "dist/*"]], ["python3", ["-W", "ignore", "-m", "twine", "register"]],
    ["uvx", ["twine", "upload", "dist/*"]], ["uvx", ["twine==5.0", "upload"]], ["uvx", ["--from", "x", "twine", "upload"]], ["uv", ["tool", "run", "twine", "upload"]],
    ["uv", ["run", "twine", "upload"]], ["poetry", ["run", "twine", "upload"]], ["uv", ["run", "python3", "-m", "twine", "upload"]],
    ["uv", ["run", "--", "twine", "upload"]], ["uv", ["tool", "run", "--", "twine", "upload"]], ["uvx", ["--", "twine", "upload"]], ["poetry", ["run", "--", "twine", "upload"]],
    ["uv", ["run", "python", "-m", "twine", "upload"]], ["poetry", ["run", "python3.12", "-m", "twine", "register"]], ["uv", ["run", "--with", "x", "python", "-m", "twine", "upload"]],
    ["uv", ["run", "--with-requirements", "r.txt", "twine", "upload"]], ["uv", ["run", "--with-requirements=r.txt", "twine", "upload"]],
    ["uv", ["--package", "p", "publish"]], ["uv", ["--package=p", "publish"]], ["uv", ["run", "--extra", "dev", "--env-file", ".env", "twine", "upload"]],
    ["uvx", ["--with-editable", ".", "twine", "upload"]], ["uv", ["auth", "login", "example.com"]], ["uv", ["auth", "token", "example.com"]],
  ];
  for (const [program, args] of refused) assert.throws(() => pythonRequest({ program, args }), /acts on a package index as an account/, `${program} ${args.join(" ")}`);
  const allowed: [string, string[]][] = [
    ["python3", ["-c", "import twine"]], ["python3", ["publish.py", "upload"]], ["python3", ["-m", "pip", "install", "twine"]], ["pip", ["install", "twine"]],
    ["uv", ["pip", "install", "twine"]], ["uv", ["run", "pytest"]], ["uvx", ["ruff", "check"]], ["poetry", ["config", "virtualenvs.in-project", "true"]],
    ["poetry", ["run", "pytest", "--", "publish"]], ["pytest", ["-k", "upload"]], ["uv", ["build"]],
  ];
  for (const [program, args] of allowed) assert.doesNotThrow(() => pythonRequest({ program, args }), `${program} ${args.join(" ")}`);
  assert.equal(packageIndexAccountCommand("uvx", ["twine@5", "upload"]), "twine upload");
});

test("the python tool's command quotes every argument, without colours or prompts, and runs a virtual environment's programs first", () => {
  assert.match(pythonShellCommand({ program: "pip", directory: ".", args: [], venv: ".venv" }, "win32"), /^PATH="\$PWD"\/'\.venv\/Scripts':/, "Windows keeps them in Scripts");
  assert.match(pythonShellCommand({ program: "python3", directory: ".", args: ["-V"], venv: ".venv" }, "win32"), / python '-V' /, "and names its interpreter python");
  assert.match(pythonShellCommand({ program: "python3", directory: ".", args: ["-m", "venv", ".venv"] }, "win32"), / python '-m' 'venv' /, "installed too");
  assert.match(pythonShellCommand({ program: "python3", directory: ".", args: ["-V"], venv: ".venv" }, "linux"), / python3 '-V' /);
  assert.equal(pythonShellCommand({ program: "python3", directory: "app", args: ["-c", "print('hi')"] }),
    "cd -- './app' && PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/bin' NO_COLOR=1 PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 POETRY_NO_INTERACTION=1 UV_NO_PROGRESS=1 python3 '-c' 'print('\\''hi'\\'')' </dev/null 2>&1");
  assert.equal(pythonShellCommand({ program: "pip", directory: ".", args: ["install", "requests"], venv: ".venv" }),
    "PATH=\"$PWD\"/'.venv/bin':\"${PATH:-/usr/bin:/bin}\":'/usr/local/bin' VIRTUAL_ENV=\"$PWD\"/'.venv' NO_COLOR=1 PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 POETRY_NO_INTERACTION=1 UV_NO_PROGRESS=1 pip 'install' 'requests' </dev/null 2>&1");
});

test("a Linux host whose Python lacks venv and ensurepip is told to install python3-venv, without being kept from starting", async () => {
  const { pythonVenvPrerequisite, assertPrerequisites } = await import("../apps/runner/src/connect-setup.js");
  const missing = pythonVenvPrerequisite("linux", "/bin/false", true)!;
  assert.deepEqual([missing.ok, missing.optional, missing.fix?.command, missing.fix?.action], [false, true, "sudo apt install python3-venv", { kind: "apt", packages: ["python3-venv"] }]);
  assert.doesNotThrow(() => assertPrerequisites([missing], false, ""), "optional, like npm");
  assert.equal(pythonVenvPrerequisite("darwin"), undefined);
  assert.equal(pythonVenvPrerequisite("win32"), undefined);
});
