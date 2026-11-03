import { pikiExtension } from "../../../../../packages/shared/src/piki-extensions.js";
import { commandExtension, commandWords, positionals, type CliSpec } from "./command.js";

/*
 * piki:azure-cli, the Azure CLI (docs/design/piki-extensions.md), with its azure-devops extension where the host
 * has it: Azure DevOps repositories, pull requests, pipelines and boards.
 */

/** Verbs that read. */
const READ_VERB = /^(?:list|show|query|version|(?:list|show)-[a-z-]+)$/;
/** Words of commands that show secrets, or that read where secrets are, even when their verb only reads. */
const SECRET_WORD = /key|secret|password|credential|token|connection-string|sas|publish|appsettings|kubeconfig/i;

/**
 * Whether `arg` is the long option `name` or an abbreviation of it, as Python's argparse takes them, with or without
 * `=value`; or, for a short `name`, that option with its value joined.
 */
function isOption(arg: string, name: string): boolean {
  if (name.startsWith("--")) {
    const given = arg.split("=")[0]!;
    return given.length >= 3 && given.startsWith("--") && name.startsWith(given);
  }
  return arg === name || (arg.startsWith(name) && arg.length > name.length);
}

/** The values `args` give an option, by any of `names` (abbreviated long ones too). */
function values(args: readonly string[], names: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const name = names.find(candidate => isOption(arg, candidate));
    if (!name) continue;
    if (arg.includes("=") && name.startsWith("--")) found.push(arg.slice(arg.indexOf("=") + 1));
    else if (!name.startsWith("--") && arg.length > name.length) found.push(arg.slice(name.length));
    else { found.push(args[index + 1] ?? ""); index++; }
  }
  return found;
}

const has = (args: readonly string[], names: readonly string[]) => args.some(arg => names.some(name => isOption(arg, name)));

/** Options that write a file, as given or abbreviated past what they share with others (`--output` is not `--output-file`). */
const FILE_OPTIONS = [{ name: "--output-file", shortest: "--output-" }, { name: "--file", shortest: "--fil" }, { name: "--path", shortest: "--pat" }];
const writesFile = (args: readonly string[]) => args.some(arg => {
  const given = arg.split("=")[0]!;
  return FILE_OPTIONS.some(option => option.name.startsWith(given) && given.startsWith(option.shortest));
});

/** az matches its command words and options without regard to case. */
const lower = (args: readonly string[]) => args.map(arg => arg.toLowerCase());

/** Why a request az sends itself (`az rest`, `az devops invoke`) may change something. */
function requestWrites(args: readonly string[], method: readonly string[], body: readonly string[]): string | undefined {
  if (has(args, body)) return "it sends a request body";
  const methods = values(args, method).map(value => value.toUpperCase());
  return methods.every(value => value === "GET") ? undefined : `it sends a ${methods.find(value => value !== "GET")} request`;
}

export const azureCliSpec: CliSpec = {
  info: pikiExtension("piki:azure-cli")!,
  command: "az",
  windowsCommand: { file: "az.cmd", shim: true },
  description: [
    "Run the Azure CLI (az) on the session's Pikibun host, outside the sandbox, signed in as the host's owner is to az.",
    "Give the arguments after az as a list, as they are passed (no shell, no quoting), such as {\"args\": [\"repos\", \"pr\", \"list\", \"--organization\", \"https://dev.azure.com/acme\", \"--project\", \"App\"]}.",
    "Use it for what the sandbox can't reach: Azure DevOps pull requests, pipelines and their runs, and work items (az repos, az pipelines, az boards, with the host's azure-devops extension), their REST API (az devops invoke), and Azure resources.",
    "Pass --organization and --project unless the host's az devops configure set them; it runs in the session's worktree on the host, or in directory, a clone in it. Add --output json for output to read.",
    "It acts as the host owner's az account, which may not be the session owner's.",
    "Each call waits for approval unless the workspace runs this extension's tools automatically; where the workspace set it read-only, only commands that read (list, show, query) run, and none that show keys or secrets.",
    "Commands that would show its tokens (account get-access-token, --expose-token, --debug) are refused.",
  ].join(" "),
  passEnv: name => name.startsWith("AZURE_") || name === "AZDEVOPS_EXT_PAT",
  setEnv: { AZURE_CORE_NO_COLOR: "true", AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_CORE_DISABLE_PROGRESS_BAR: "true", AZURE_CORE_SURVEY_MESSAGE: "false",
    PYTHONIOENCODING: "utf-8" },
  // Options may sit anywhere among the command's words, abbreviated, in any case: these look at every argument.
  refused(original) {
    const args = lower(original);
    if (positionals(args).includes("get-access-token")) return "az account get-access-token would show a token";
    if (has(args, ["--expose-token"])) return "--expose-token would show a token";
    if (has(args, ["--debug"])) return "--debug would log its requests, with their credentials";
    return undefined;
  },
  writes(original) {
    const args = lower(original);
    if (args.length === 1 && args[0] === "--version") return undefined;
    // az reads an argument starting with @ from that file on the host.
    if (args.some(arg => arg.startsWith("@") || /^-[^=]*=@/.test(arg))) return "an argument reads a host file (@file)";
    const words = commandWords(args);
    if (!words.length) return `az ${args.join(" ")} is not a command that only reads`;
    if (words.some(word => SECRET_WORD.test(word))) return `az ${words.join(" ")} may show keys or secrets`;
    if (words.length === 1 && words[0] === "rest") return requestWrites(args, ["--method", "-m"], ["--body", "-b"]);
    if (words.join(" ") === "devops invoke") return requestWrites(args, ["--http-method"], ["--in-file"]);
    if (writesFile(args)) return "it writes a file";
    return READ_VERB.test(words.at(-1)!) ? undefined : `az ${words.join(" ")} is not a command that only reads`;
  },
};

export const azurePikiExtension = commandExtension(azureCliSpec);
