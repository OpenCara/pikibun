import type { GitProvider } from "./repositories.js";

/*
 * Extensions built into the connector (docs/design/cli-extensions.md): Pi extensions that give sessions a forge's or
 * a cloud's command-line tool as one tool, run on the host with the host's own sign-in to that tool. Every connector
 * that knows one has it, at its own version, so hosts never install them; a workspace runs one like any other
 * extension, as `cli:<name>`, and gets the one for a forge as soon as it binds a repository there.
 */

export interface CliExtensionInfo {
  /** Its name, as in `cli:<name>`. */
  name: string;
  source: `cli:${string}`;
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

export const cliExtensions: readonly CliExtensionInfo[] = Object.freeze([
  {
    name: "gh", source: "cli:gh", tool: "gh", title: "GitHub CLI",
    description: "Runs the GitHub CLI (gh) on the host, with its owner's gh sign-in: pull requests, issues, Actions runs and their logs, releases, and the GitHub API.",
    install: "https://cli.github.com", signIn: "gh auth login", providers: ["github", "github-enterprise"],
  },
  {
    name: "glab", source: "cli:glab", tool: "glab", title: "GitLab CLI",
    description: "Runs the GitLab CLI (glab) on the host, with its owner's glab sign-in: merge requests, issues, CI/CD pipelines and their logs, releases, and the GitLab API.",
    install: "https://gitlab.com/gitlab-org/cli", signIn: "glab auth login", providers: ["gitlab"],
  },
  {
    name: "azure-cli", source: "cli:azure-cli", tool: "az", title: "Azure CLI",
    description: "Runs the Azure CLI (az) on the host, with its owner's az sign-in: Azure DevOps pull requests, pipelines and work items (with the azure-devops extension), and Azure resources.",
    install: "https://learn.microsoft.com/cli/azure/install-azure-cli", signIn: "az login (and az extension add --name azure-devops)", providers: ["azure-devops"],
  },
] as const satisfies readonly CliExtensionInfo[]);

/** The CLI extension `source` names, if this version knows it. */
export function cliExtension(source: string): CliExtensionInfo | undefined {
  return cliExtensions.find(item => item.source === source);
}

/** The CLI extensions for repositories of `provider`. */
export function cliExtensionsFor(provider: string): CliExtensionInfo[] {
  return cliExtensions.filter(item => (item.providers as readonly string[]).includes(provider));
}
