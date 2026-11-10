import { runAppHost } from "./app-host.js";
import { ConnectorSetupError } from "./protocol.js";

const HELP = `Usage: pikibun host --stdio [--state-dir PATH]

Runs this computer's host for the Pikibun app, which starts this command itself and
talks to it over stdin and stdout (JSON lines): it pairs this computer, starts and
stops its connector, and signs Pi in to providers as the app asks. To connect this
computer from a terminal instead, run "pikibun connect".

Options:
  --stdio            Requests on stdin, events on stdout (required)
  --state-dir PATH   Private connector state (default ~/.local/share/pikibun/connector,
                     shared with "pikibun connect": only one of them runs at a time)
  --help             Show this help
`;

export async function hostMain(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(HELP); return; }
  if (!args.includes("--stdio")) throw new ConnectorSetupError("pikibun host is run by the Pikibun app, over --stdio. To connect this computer from a terminal, run \"pikibun connect\".");
  try { runAppHost(args); }
  catch { throw new ConnectorSetupError(`Unknown option. Run "pikibun host --help".`); }
}
