import type { GitProvider } from "./repositories.js";

/*
 * Extensions built into the connector (docs/design/piki-extensions.md): Pi extensions that give sessions a forge's or
 * a cloud's command-line tool as one tool, run on the host with the host's own sign-in to that tool, and guards such as
 * the prompt audit, which checks messages before they reach the agent. Every connector that knows one has it, at its
 * own version, so hosts never install them; a workspace runs one like any other extension, as `piki:<name>`, and gets
 * the one for a forge as soon as it binds a repository there; a host's owner can require one of every session on it.
 */

export interface PikiExtensionInfo {
  /** Its name, as in `piki:<name>`. */
  name: string;
  source: `piki:${string}`;
  /** Its tool's name, the command it runs; none for a guard, which offers no tool. */
  tool?: string;
  title: string;
  description: string;
  /** Where to get the command, and how to sign in to it on the host; command-line tools only. */
  install?: string;
  signIn?: string;
  /** A workspace that binds its first repository of one of these providers gets this extension. */
  providers: readonly GitProvider[];
}

export const pikiExtensions: readonly PikiExtensionInfo[] = Object.freeze([
  {
    name: "gh", source: "piki:gh", tool: "gh", title: "GitHub CLI",
    description: "Runs the GitHub CLI (gh) on the host, with its owner's gh sign-in: pull requests, issues, Actions runs and their logs, releases, and the GitHub API.",
    install: "https://cli.github.com", signIn: "gh auth login", providers: ["github", "github-enterprise"],
  },
  {
    name: "glab", source: "piki:glab", tool: "glab", title: "GitLab CLI",
    description: "Runs the GitLab CLI (glab) on the host, with its owner's glab sign-in: merge requests, issues, CI/CD pipelines and their logs, releases, and the GitLab API.",
    install: "https://gitlab.com/gitlab-org/cli", signIn: "glab auth login", providers: ["gitlab"],
  },
  {
    name: "azure-cli", source: "piki:azure-cli", tool: "az", title: "Azure CLI",
    description: "Runs the Azure CLI (az) on the host, with its owner's az sign-in: Azure DevOps pull requests, pipelines and work items (with the azure-devops extension), and Azure resources.",
    install: "https://learn.microsoft.com/cli/azure/install-azure-cli", signIn: "az login (and az extension add --name azure-devops)", providers: ["azure-devops"],
  },
  {
    name: "prompt-audit", source: "piki:prompt-audit", title: "Prompt audit",
    description: "Has a model of the host check each message from anyone but the host's owner before it reaches the agent, and refuses ones that reach for the host's credentials, files, environment or network. A message it can't check is refused too.",
    providers: [],
  },
] as const satisfies readonly PikiExtensionInfo[]);

/** The Pikibun extension `source` names, if this version knows it. */
export function pikiExtension(source: string): PikiExtensionInfo | undefined {
  return pikiExtensions.find(item => item.source === source);
}

/** The Pikibun extensions that run a command-line tool, which the workspace page offers as such. */
export function pikiCommandExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.tool !== undefined);
}

/** The Pikibun extensions for repositories of `provider`. */
export function pikiExtensionsFor(provider: string): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => (item.providers as readonly string[]).includes(provider));
}
