import { connectMain } from "../../../apps/runner/src/connect-cli.js";
import { cacheMain } from "../../../apps/runner/src/cache-cli.js";
import { extensionsMain } from "../../../apps/runner/src/extensions-cli.js";
import { hostMain } from "../../../apps/runner/src/host-cli.js";
import { identityMain } from "../../../apps/runner/src/identity-cli.js";
import { ConnectorSetupError } from "../../../apps/runner/src/protocol.js";
import { lazyPrivateHome, providePrivateHomes } from "../../../apps/runner/src/private-home.js";
import { withholdProgramResumeToken } from "../../../apps/runner/src/program-resume.js";
import packageJson from "../package.json" with { type: "json" };
import { tuiMain } from "./tui.js";

const USAGE = `Usage: pikibun <command> [options]

Commands:
  connect     Connect this Linux or WSL2 Pi host to a Pikibun workspace
  serve       Run Pikibun on this computer, for yourself with it as the host,
              or shared with others (--share)
  cache       List or prune this host's repository cache
  extensions  Add, list or remove this host's extensions
  identity    Your identity on this computer, which signs your private
              workspace's settings: show, export, import, rotate or reset it
  host        This computer's host for the Pikibun app, which runs it itself
              (host --stdio)
  tui         Pikibun in this terminal: sign in, sessions and their chats
              (@pikibun/tui, which it runs from npm when it isn't installed)

Options:
  --help      Show this help
  --version   Show the installed version

Run "pikibun connect --help" or "pikibun serve --help" for their options.
`;

withholdProgramResumeToken();
const [command, ...args] = process.argv.slice(2);
providePrivateHomes(host => lazyPrivateHome(import("../../../apps/server/src/local/home.js").then(home => home.createPrivateHome(host, {
  log: line => process.stderr.write(`${line}\n`),
}))));
const serveMain = async (args: string[]) => (await import("../../../apps/server/src/local/cli.js")).serveMain(args);
const run = command === "connect" ? connectMain : command === "cache" ? cacheMain : command === "extensions" ? extensionsMain : command === "identity" ? identityMain : command === "serve" ? serveMain
  : command === "host" ? hostMain : command === "tui" ? tuiMain : undefined;
if (run) {
  run(args).catch((error: unknown) => {
    process.stderr.write(error instanceof ConnectorSetupError
      ? `${error.message}\n`
      : command === "serve" ? "Pikibun failed. Check --help, the state directory's permissions, the port, local Pi configuration and sandbox prerequisites.\n"
      : command === "tui" ? "Pikibun's terminal app didn't start. Check pikibun tui --help, and that npm can install @pikibun/tui.\n"
      : "Connector failed. Check --help, private state permissions, pairing, local Pi configuration and sandbox prerequisites.\n");
    process.exitCode = 1;
  });
} else if (command === "--version" || command === "-v") {
  process.stdout.write(`${packageJson.version}\n`);
} else if (command === undefined || command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 2;
}
