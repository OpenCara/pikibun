interface InstallStep { programs: readonly string[]; how: string }

const steps: readonly InstallStep[] = Object.freeze([
  { programs: ["pnpm", "yarn"], how: "with the npm of the Node.js the connector runs on: npm install -g pnpm yarn (with sudo where that Node.js is the system's, in /usr)" },
  { programs: ["corepack"], how: "npm install -g corepack with the npm of the Node.js the connector runs on (Node.js 25 and newer no longer bundle it), then corepack enable" },
  { programs: ["npm", "npx", "node"], how: "the Node.js the connector runs on has them: run the connector on an installation of Node.js 24 or newer that includes npm" },
  { programs: ["uv", "uvx"], how: "uv for the whole system: curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh" },
  { programs: ["poetry"], how: "the distribution's python3-poetry package, or sudo env PIPX_GLOBAL_HOME=/usr/local/share/pipx PIPX_GLOBAL_BIN_DIR=/usr/local/bin pipx install --global poetry (pipx 1.5 or newer)" },
  { programs: ["pytest"], how: "the distribution's python3-pytest package; without it, a session installs pytest into a virtual environment itself (pip install pytest with venv .venv)" },
  { programs: ["pip", "pip3"], how: "the distribution's python3-pip package" },
  { programs: ["python3"], how: "the distribution's python3 package" },
  { programs: ["cargo", "rustc", "rustup", "rustfmt"], how: "Rust for the whole system, as the official rust image has it: curl https://sh.rustup.rs -sSf | sudo env RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo sh -s -- -y --no-modify-path, or the distribution's cargo, rustc and rustfmt packages" },
  { programs: ["go", "gofmt"], how: "Go's release in /usr/local/go (https://go.dev/doc/install: sudo tar -C /usr/local -xzf go<version>.linux-<arch>.tar.gz), or the distribution's golang package" },
  { programs: ["dotnet"], how: "the distribution's .NET SDK package (Ubuntu: sudo apt install dotnet-sdk-8.0), or Microsoft's dotnet-install.sh with --install-dir /usr/share/dotnet" },
  { programs: ["make"], how: "the distribution's make package (sudo apt install make)" },
]);

export function programInstallStep(program: string): string | undefined {
  return steps.find(step => step.programs.includes(program))?.how;
}

const list = (items: readonly string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const hostPrograms: Readonly<Record<string, InstallStep>> = Object.freeze({
  browser: { programs: ["chromium"], how: "the distribution's chromium package (sudo apt install chromium on Debian; Ubuntu's is a snap, which can't run in another sandbox, so Google Chrome's .deb there), or npx playwright install chromium-headless-shell as the connector's user; the connector finds it within a minute while the host's page (Settings → Hosts → the host → Extensions → piki:browser) says Find it" },
  tunnel: { programs: ["cloudflared"], how: "Cloudflare's cloudflared package (sudo apt install cloudflared from Cloudflare's repository) or its release in /usr/local/bin; the connector finds it within a minute while the host's page (Settings → Hosts → the host → Extensions → piki:tunnel) says Find it" },
});

export function hostToolPrograms(tool: string): readonly string[] | undefined {
  return hostPrograms[tool]?.programs;
}

export interface InstallChat { host: string; missing: Readonly<Record<string, readonly string[]>>; onHost: boolean }

const missingPrograms = (missing: InstallChat["missing"]) => [...new Set(Object.values(missing).flat())];

export function installChatTitle(chat: InstallChat): string {
  const programs = missingPrograms(chat.missing);
  return Array.from(`Install ${programs.length > 3 ? `${programs.slice(0, 3).join(", ")} and more` : list(programs)} on ${chat.host}`).slice(0, 80).join("");
}

export function installChatMessage(chat: InstallChat): string {
  const tools = Object.entries(chat.missing).filter(([, programs]) => programs.length);
  const programs = missingPrograms(chat.missing);
  const step = (program: string) => tools.map(([tool]) => hostPrograms[tool]).find(item => item?.programs.includes(program))?.how ?? programInstallStep(program);
  const known = programs.filter(program => step(program));
  const steps = [...new Set(known.map(step))].map(how => `- ${list(known.filter(program => step(program) === how))}: ${how}`);
  const unknown = programs.filter(program => !step(program));
  return [
    `Install on this host (${chat.host}) the programs Pikibun's sessions on it lack: ${list(tools.map(([tool, items]) => `the ${tool} tool's ${list(items)}`))}.`,
    "Sessions in the host's sandbox see only its /usr (and the connector's Node.js), so install them for the whole system, never into a home directory such as ~/.local or ~/.cargo, unless a step below says otherwise. The usual steps:",
    [...steps, ...(unknown.length ? [`- ${list(unknown)}: the distribution's package`] : [])].join("\n"),
    chat.onHost
      ? "This session runs on the host itself, as its user, without the sandbox. First look at the host (its distribution and architecture, the Node.js the connector runs on) and what is already installed, then install each program and check that it runs from where sessions see it. "
        + "Where a step needs root, run it with sudo -A: sudo then asks me for my password in Pikibun, in a box of its own, and never through the chat. "
        + "If I decline, or this session doesn't offer sudo -A, stop and tell me the exact commands to run in a terminal on the host instead."
      : "This session runs in the host's sandbox, which can't install anything on the host: look at what you can of it, then tell me the exact commands to run in a terminal on the host, for its distribution and architecture.",
    "Sessions find a program installed in /usr from their next message (one installed into a Node.js outside /usr, from their next session). Tell me what you installed, how you checked it, and anything left for me to do.",
  ].join("\n\n");
}

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
