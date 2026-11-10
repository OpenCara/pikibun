import { pikiExtension } from "../../../../../packages/shared/src/piki-extensions.js";
import { commandWords, positionals, type CliSpec } from "./command.js";

const READ_VERB = /^(?:list|show|query|version|(?:list|show)-[a-z-]+)$/;
const SECRET_WORD = /key|secret|password|credential|token|connection-string|sas|publish|appsettings|kubeconfig/i;

function isOption(arg: string, name: string): boolean {
  if (name.startsWith("--")) {
    const given = arg.split("=")[0]!;
    return given.length >= 3 && given.startsWith("--") && name.startsWith(given);
  }
  return arg === name || (arg.startsWith(name) && arg.length > name.length);
}

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

const FILE_OPTIONS = [{ name: "--output-file", shortest: "--output-" }, { name: "--file", shortest: "--fil" }, { name: "--path", shortest: "--pat" }];
const writesFile = (args: readonly string[]) => args.some(arg => {
  const given = arg.split("=")[0]!;
  return FILE_OPTIONS.some(option => option.name.startsWith(given) && given.startsWith(option.shortest));
});

const lower = (args: readonly string[]) => args.map(arg => arg.toLowerCase());

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
    "Run the Azure CLI (az) as the session owner: in the session's sandbox, where Pikibun adds the session owner's Azure DevOps personal access token (for the organization a request names) to its requests to dev.azure.com, on the session owner's own host.",
    "Give the arguments after az as a list, as they are passed (no shell, no quoting), such as {\"args\": [\"repos\", \"pr\", \"list\", \"--organization\", \"https://dev.azure.com/acme\", \"--project\", \"App\"]}.",
    "Use it for Azure DevOps: pull requests, pipelines and their runs, and work items (az repos, az pipelines, az boards, with the azure-devops extension), and their REST API (az devops invoke). Azure resources (az vm, az storage, ...) need an Azure sign-in, which only the host owner's own sessions have, where the host's owner allows that.",
    "Pass --organization https://dev.azure.com/<organization> and --project; it runs in the session's worktree, or in directory, a clone in it. Add --output json for output to read.",
    "It reads always; it writes outside read-only.",
    "Where the workspace set it read-only, only commands that read (list, show, query) run, and none that show keys or secrets.",
    "Commands that would show its tokens (account get-access-token, --expose-token, --debug) are refused.",
  ].join(" "),
  passEnv: name => name.startsWith("AZURE_") || name === "AZDEVOPS_EXT_PAT",
  tokenEnv: ["AZURE_DEVOPS_EXT_PAT"],
  setEnv: { AZURE_CORE_NO_COLOR: "true", AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_CORE_DISABLE_PROGRESS_BAR: "true", AZURE_CORE_SURVEY_MESSAGE: "false",
    PYTHONIOENCODING: "utf-8" },
  refused(original) {
    const args = lower(original);
    const words = positionals(args);
    const prefixOf = (word: string) => words.some(candidate => candidate.length > 0 && word.startsWith(candidate));
    if (prefixOf("account") && prefixOf("get-access-token")) return "az account get-access-token would show a token";
    if (has(args, ["--expose-token"])) return "--expose-token would show a token";
    if (has(args, ["--debug"])) return "--debug would log its requests, with their credentials";
    return undefined;
  },
  writes(original) {
    const args = lower(original);
    if (args.length === 1 && args[0] === "--version") return undefined;
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
