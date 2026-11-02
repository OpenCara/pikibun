import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultStateDir } from "./connect-setup.js";
import { loadExtensions } from "./extensions/load.js";
import { ExtensionStore, ExtensionStoreError, parseExtensionSource } from "./extensions/store.js";
import { ConnectorSetupError } from "./protocol.js";

const HELP = `Usage: pikibun extensions <command> [options]

Host extensions add tools, prompt text and hooks to the agents of sessions on this host. Install them here; turn each
one on, choose its sessions and set its settings in Pikibun (Settings > Hosts > this host > Extensions). They run in the
connector, as this machine's user, outside the sandbox: install only code you trust.

Commands:
  add SOURCE              Install an extension, pinned:
                            npm:<package>@<exact version>     e.g. npm:@acme/pikibun-search@1.2.0
                            git:<https URL>@<full commit>     e.g. git:github.com/acme/search@<40-character commit>
                            PATH                              a .js/.mjs/.ts file or a package directory, loaded in place
  list                    Load the installed extensions and show what each offers, or why it doesn't load
  remove NAME             Uninstall a package by its name, or a local extension by its path

Options:
  --state-dir PATH        Connector state (default ~/.local/share/pikibun/connector)
  --allow-scripts         For add: let npm run the package's install scripts (off by default)
  --help                  Show this help

Restart the connector after adding or removing an extension.
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
      await list(store, installed.source);
      process.stdout.write("Restart the connector, then turn it on in Pikibun: Settings > Hosts > this host > Extensions.\n");
      return;
    }
    if (values["allow-scripts"]) throw new ConnectorSetupError("--allow-scripts applies to add only.");
    if (command === "list" && !rest.length) { await list(store); return; }
    if (command === "remove" && rest.length === 1) {
      const removed = await store.remove(rest[0]!);
      process.stdout.write(`Removed ${removed.source}. Restart the connector.\n`);
      return;
    }
  } catch (error) {
    if (error instanceof ExtensionStoreError) throw new ConnectorSetupError(error.message);
    throw error;
  }
  throw new ConnectorSetupError(`Unknown extensions command: ${positionals.join(" ")}. Run "pikibun extensions --help".`);
}

async function list(store: ExtensionStore, only?: string): Promise<void> {
  const loaded = (await loadExtensions(store)).filter(item => only === undefined || item.summary.source === only);
  if (!loaded.length) { process.stdout.write(`No extensions installed in ${store.directory}.\n`); return; }
  for (const { summary } of loaded) {
    process.stdout.write(`${summary.name}${summary.version ? ` ${summary.version}` : ""}  (${summary.source})\n`);
    if (summary.error) { process.stdout.write(`  Doesn't load: ${summary.error}\n`); continue; }
    if (summary.description) process.stdout.write(`  ${summary.description}\n`);
    if (summary.tools.length) process.stdout.write(`  Tools: ${summary.tools.map(tool => tool.name).join(", ")}\n`);
    if (summary.events.length) process.stdout.write(`  Events: ${summary.events.join(", ")}\n`);
    if (summary.settingsSchema) process.stdout.write(`  Settings: ${Object.keys((summary.settingsSchema.properties ?? {}) as object).join(", ") || "none"}\n`);
  }
}
