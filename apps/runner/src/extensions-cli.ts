import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultStateDir } from "./connect-setup.js";
import { loadInstalled, type LoadedSource } from "./extensions/load.js";
import { ExtensionSourceError, ExtensionStore, parseExtensionSource } from "./extensions/store.js";
import { ConnectorSetupError } from "./protocol.js";

const HELP = `Usage: pikibun extensions <command> [options]

Pi extensions for the sessions on this host. A workspace chooses which ones its sessions use (Settings > Workspaces >
the workspace > Extensions in Pikibun); a session runs with those this host has at the same version. The host's owner
can also install them from Pikibun (Settings > Hosts > this host > Extensions). They run in the connector, as this
machine's user, outside the sandbox: install only code you trust.

Commands:
  add SOURCE              Install an extension, pinned:
                            npm:<package>@<exact version>     e.g. npm:@ollama/pi-web-search@0.0.5
                            git:<https URL>@<full commit>     e.g. git:github.com/acme/search@<40-character commit>
                            PATH                              a dev extension: a .ts/.js file or a package directory,
                                                              loaded in place, in your own sessions on this host only
  list                    Load Pikibun's own and the installed extensions and show what each offers, ignores, or why it
                          doesn't load
  remove NAME             Uninstall one: its source as listed, a package name, or a dev extension's path

Options:
  --state-dir PATH        Connector state (default ~/.local/share/pikibun/connector)
  --allow-scripts         For add: let npm run the package's install scripts (off by default)
  --help                  Show this help

Pikibun's built-in extensions (piki:gh, piki:glab, piki:azure-cli) come with the connector: they run the GitHub, GitLab
or Azure CLI installed and signed in on this host, where a workspace uses them. Nothing to install.

A running connector picks up changes made here when it next reconnects; restart it to use them at once.
`;

export async function extensionsMain(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    help: { type: "boolean" }, "state-dir": { type: "string" }, "allow-scripts": { type: "boolean" },
  } });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) { process.stdout.write(HELP); return; }
  const store = ExtensionStore.forStateDir(resolve(values["state-dir"] ?? defaultStateDir()));
  try {
    if (command === "add" && rest.length === 1) {
      const installed = await store.add(parseExtensionSource(rest[0]!), { allowScripts: values["allow-scripts"] });
      process.stdout.write(`Installed ${installed.source}.\n`);
      print((await loadInstalled(store)).filter(item => item.summary.source === installed.source));
      return;
    }
    if (values["allow-scripts"]) throw new ConnectorSetupError("--allow-scripts applies to add only.");
    if (command === "list" && !rest.length) {
      const loaded = await loadInstalled(store);
      if (!loaded.some(item => !item.factories)) process.stdout.write(`No extensions installed in ${store.directory}.\n`);
      print(loaded);
      return;
    }
    if (command === "remove" && rest.length === 1) {
      const removed = await store.remove(rest[0]!);
      process.stdout.write(`Removed ${removed.source}.\n`);
      return;
    }
  } catch (error) {
    if (error instanceof ExtensionSourceError) throw new ConnectorSetupError(error.message);
    throw error;
  }
  throw new ConnectorSetupError(`Unknown extensions command: ${positionals.join(" ")}. Run "pikibun extensions --help".`);
}

function print(loaded: LoadedSource[]): void {
  for (const { summary } of loaded) {
    process.stdout.write(`${summary.source}${summary.dev ? "  (dev: your own sessions on this host)" : summary.source.startsWith("piki:") ? "  (built into the connector)" : ""}\n`);
    if (summary.description) process.stdout.write(`  ${summary.description}\n`);
    if (summary.error) { process.stdout.write(`  Doesn't load: ${summary.error}\n`); continue; }
    for (const module of summary.modules) {
      process.stdout.write(`  ${module.path}\n`);
      if (module.error) { process.stdout.write(`    Doesn't load: ${module.error}\n`); continue; }
      if (module.tools.length) process.stdout.write(`    Tools: ${module.tools.map(tool => tool.name).join(", ")}\n`);
      if (module.events.length) process.stdout.write(`    Events: ${module.events.join(", ")}\n`);
      if (module.flags.length) process.stdout.write(`    Settings: ${module.flags.map(flag => flag.name).join(", ")}\n`);
      if (module.noops.length) process.stdout.write(`    Does nothing here: ${module.noops.join(", ")}\n`);
      if (module.ignored.length) process.stdout.write(`    Not supported: ${module.ignored.join(", ")}\n`);
    }
  }
}
