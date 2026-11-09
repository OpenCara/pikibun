/*
 * How a host's owner installs the programs the program tools run (piki:node, piki:python, piki:rust, piki:go,
 * piki:dotnet, piki:make), for the sessions in its Linux sandbox. The sandbox mounts only the host's /usr (and the
 * connector's own Node.js), so a program counts where it is installed for the whole system, with its files in /usr: one
 * in a home directory (~/.local/bin, ~/.cargo/bin, ~/go/bin) is never there, nor a link from /usr to it.
 *
 * As the browser's Chromium is (browserUnavailableText): the agent learns what the host lacks and how it is installed, so
 * it tells its people rather than guessing, and a call to a missing program is refused before it waits for an approval.
 */

/** Programs installed by one step, and that step. */
interface InstallStep { programs: readonly string[]; how: string }

const steps: readonly InstallStep[] = Object.freeze([
  { programs: ["pnpm", "yarn"], how: "with the npm of the Node.js the connector runs on: npm install -g pnpm yarn (with sudo where that Node.js is the system's, in /usr)" },
  { programs: ["corepack"], how: "npm install -g corepack with the npm of the Node.js the connector runs on (Node.js 25 and newer no longer bundle it), then corepack enable" },
  { programs: ["npm", "npx", "node"], how: "the Node.js the connector runs on has them: run the connector on an installation of Node.js 24 or newer that includes npm" },
  { programs: ["uv", "uvx"], how: "uv for the whole system: curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh" },
  { programs: ["poetry"], how: "sudo pipx install --global poetry (pipx 1.5 or newer), or the distribution's python3-poetry package" },
  { programs: ["pytest"], how: "the distribution's python3-pytest package; without it, a session installs pytest into a virtual environment itself (pip install pytest with venv .venv)" },
  { programs: ["pip", "pip3"], how: "the distribution's python3-pip package" },
  { programs: ["python3"], how: "the distribution's python3 package" },
  { programs: ["cargo", "rustc", "rustup", "rustfmt"], how: "Rust for the whole system, as the official rust image has it: curl https://sh.rustup.rs -sSf | sudo env RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo sh -s -- -y --no-modify-path, or the distribution's cargo, rustc and rustfmt packages" },
  { programs: ["go", "gofmt"], how: "Go's release in /usr/local/go (https://go.dev/doc/install: sudo tar -C /usr/local -xzf go<version>.linux-<arch>.tar.gz), or the distribution's golang package" },
  { programs: ["dotnet"], how: "the distribution's .NET SDK package (Ubuntu: sudo apt install dotnet-sdk-8.0), or Microsoft's dotnet-install.sh with --install-dir /usr/share/dotnet" },
  { programs: ["make"], how: "the distribution's make package (sudo apt install make)" },
]);

/** How the host's owner installs `program` for the sandbox, or undefined for a program this version has no step for. */
export function programInstallStep(program: string): string | undefined {
  return steps.find(step => step.programs.includes(program))?.how;
}

const list = (items: readonly string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * What to tell a session's people, and its agent, of the programs `missing` names, by tool (node: [pnpm, yarn]), the
 * host doesn't have: which they are, and the steps that install each, once per step.
 */
export function programsMissingText(missing: Readonly<Record<string, readonly string[]>>): string | undefined {
  const tools = Object.entries(missing).filter(([, programs]) => programs.length);
  if (!tools.length) return undefined;
  const programs = [...new Set(tools.flatMap(([, items]) => items))];
  const found = steps.map(step => ({ step, programs: programs.filter(program => step.programs.includes(program)) })).filter(item => item.programs.length);
  const unknown = programs.filter(program => !programInstallStep(program));
  return `This host doesn't have ${list(tools.map(([tool, items]) => `the ${tool} tool's ${list(items)}`))} where the session's sandbox sees them. `
    + "Its owner installs them on the host for the whole system, as the sandbox sees only the host's /usr (never a home directory such as ~/.local or ~/.cargo): "
    + [...found.map(item => `${list(item.programs)}: ${item.step.how}`), ...(unknown.length ? [`${list(unknown)}: the distribution's package`] : [])].join("; ")
    + ". Sessions find them from their next message (those installed into a Node.js outside /usr, from the next session on).";
}
