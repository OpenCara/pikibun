import type { GitProvider } from "./repositories.js";

/*
 * Extensions built into the connector (docs/design/builtin-extensions.md): Pi extensions that give sessions a forge's or
 * a cloud's command-line tool as one tool, run on the host with the host's own sign-in to that tool. Every connector
 * that knows one has it, at its own version, so hosts never install them; a workspace runs one like any other
 * extension, as `builtin:<name>`, and gets the one for a forge as soon as it binds a repository there.
 */

export interface BuiltinExtensionInfo {
  /** Its name, as in `builtin:<name>`. */
  name: string;
  source: `builtin:${string}`;
  /** Its tool's name: the command it runs. */
  tool: string;
  title: string;
  description: string;
  /** Where to get the command, and how to sign in to it on the host. */
  install: string;
  signIn: string;
  /** A workspace that binds its first repository of one of these providers gets this extension. */
  providers: readonly GitProvider[];
}

export const builtinExtensions: readonly BuiltinExtensionInfo[] = Object.freeze([
  {
    name: "gh", source: "builtin:gh", tool: "gh", title: "GitHub CLI",
    description: "Runs the GitHub CLI (gh) on the host, with its owner's gh sign-in: pull requests, issues, Actions runs and their logs, releases, and the GitHub API.",
    install: "https://cli.github.com", signIn: "gh auth login", providers: ["github", "github-enterprise"],
  },
  {
    name: "glab", source: "builtin:glab", tool: "glab", title: "GitLab CLI",
    description: "Runs the GitLab CLI (glab) on the host, with its owner's glab sign-in: merge requests, issues, CI/CD pipelines and their logs, releases, and the GitLab API.",
    install: "https://gitlab.com/gitlab-org/cli", signIn: "glab auth login", providers: ["gitlab"],
  },
  {
    name: "azure-cli", source: "builtin:azure-cli", tool: "az", title: "Azure CLI",
    description: "Runs the Azure CLI (az) on the host, with its owner's az sign-in: Azure DevOps pull requests, pipelines and work items (with the azure-devops extension), and Azure resources.",
    install: "https://learn.microsoft.com/cli/azure/install-azure-cli", signIn: "az login (and az extension add --name azure-devops)", providers: ["azure-devops"],
  },
] as const satisfies readonly BuiltinExtensionInfo[]);

/** The built-in extension `source` names, if this version knows it. */
export function builtinExtension(source: string): BuiltinExtensionInfo | undefined {
  return builtinExtensions.find(item => item.source === source);
}

/** The built-in extensions for repositories of `provider`. */
export function builtinExtensionsFor(provider: string): BuiltinExtensionInfo[] {
  return builtinExtensions.filter(item => (item.providers as readonly string[]).includes(provider));
}
