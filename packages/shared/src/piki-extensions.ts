import type { GitProvider } from "./repositories.js";

/*
 * Extensions built into the connector (docs/design/piki-extensions.md): Pi extensions that give sessions a forge's
 * command-line tool as one tool, run in the session's sandbox as the session owner, with the owner's account in
 * Pikibun added to its API requests by the session's egress proxy, and guards such as the prompt audit, which checks
 * messages before they reach the agent. Every connector that knows one has it, at its own version, so hosts never
 * install them; a workspace runs one like any other extension, as `piki:<name>`, and gets the one for a forge as soon
 * as it binds a repository there; a host's owner can require one of every session on it.
 */

export interface PikiExtensionInfo {
  /** Its name, as in `piki:<name>`. */
  name: string;
  source: `piki:${string}`;
  /** Its tool's name, the command it runs; none for a guard, which offers no tool. */
  tool?: string;
  title: string;
  description: string;
  /** Command-line tools only: where to get the command, which the host installs where its sandbox finds it (its /usr). */
  install?: string;
  /** Command-line tools only: the session owner's account in Pikibun the command acts with. */
  account?: string;
  /**
   * Command-line tools only: how the host's owner signs in to it on the host, for their own sessions where they let it
   * use that (PIKIBUN_PIKI_HOST_SIGN_IN).
   */
  signIn?: string;
  /** A workspace that binds its first repository of one of these providers gets this extension. */
  providers: readonly GitProvider[];
  /**
   * Session tools only: the session's own tools this extension turns on (docs/design/piki-extensions.md, "Session
   * tools"). They keep running as the session's own, under its permissions and approvals, never as `extension.tool`
   * cards; the workspace only decides whether its sessions offer them. They are on unless the workspace lists the
   * extension turned off, so a workspace that never chose, or a control plane that predates it, keeps them.
   */
  sessionTools?: readonly string[];
  /**
   * Session tools only: whose being off protects something (a shell). Then it is off, too, while the last answer the
   * connector read from the control plane turned it off, however old, rather than on once that answer is too old to use.
   */
  failClosed?: boolean;
}

export const pikiExtensions: readonly PikiExtensionInfo[] = Object.freeze([
  {
    name: "gh", source: "piki:gh", tool: "gh", title: "GitHub CLI",
    description: "Runs the GitHub CLI (gh) in the session's sandbox, as the session owner: pull requests, issues, Actions runs and their logs, releases, and the GitHub API.",
    install: "https://cli.github.com", account: "their GitHub sign-in", signIn: "gh auth login", providers: ["github", "github-enterprise"],
  },
  {
    name: "glab", source: "piki:glab", tool: "glab", title: "GitLab CLI",
    description: "Runs the GitLab CLI (glab) in the session's sandbox, as the session owner: merge requests, issues, CI/CD pipelines and their logs, releases, and the GitLab API of gitlab.com.",
    install: "https://gitlab.com/gitlab-org/cli", account: "their GitLab (gitlab.com) access token under Git accounts", signIn: "glab auth login", providers: ["gitlab"],
  },
  {
    name: "azure-cli", source: "piki:azure-cli", tool: "az", title: "Azure CLI",
    description: "Runs the Azure CLI (az) in the session's sandbox, as the session owner: Azure DevOps pull requests, pipelines and work items (with the azure-devops extension).",
    install: "https://learn.microsoft.com/cli/azure/install-azure-cli", account: "their Azure DevOps access token for the organization under Git accounts",
    signIn: "az login (and az extension add --name azure-devops)", providers: ["azure-devops"],
  },
  {
    name: "schedule", source: "piki:schedule", title: "Scheduled prompts", sessionTools: ["schedule"],
    description: "The schedule tool: the agent lists, creates, changes and deletes the session's scheduled prompts when its owner asks, such as a nightly check. On unless turned off here.",
    providers: [],
  },
  {
    name: "host-shell", source: "piki:host-shell", title: "Host commands", sessionTools: ["host_bash"], failClosed: true,
    description: "The host_bash tool: the agent runs commands on the host, outside the sandbox, each approved by the host's owner or a member they granted host commands. Recent sessions used it only for the GitHub CLI, which piki:gh covers. On unless turned off here.",
    providers: [],
  },
  {
    name: "git", source: "piki:git", title: "Git", sessionTools: ["git"],
    description: "The git tool: the agent runs Git (clone, status, diff, log, commit, switch, fetch, merge, rebase ...) with its arguments as a list, without a shell, each call approved as a command is. On unless turned off here.",
    providers: [],
  },
  {
    name: "node", source: "piki:node", title: "Node.js", sessionTools: ["node"],
    description: "The node tool: the agent runs Node.js and its package managers (node, npm, npx, pnpm, yarn, corepack) with their arguments as a list, without a shell, each call approved as a command is. On unless turned off here.",
    providers: [],
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

/** The Pikibun extensions that turn on session tools, which the workspace page lists whether or not the workspace chose them. */
export function pikiSessionToolExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.sessionTools !== undefined);
}

/**
 * The session tools `workspace` turns off: those of the session-tool extensions it lists disabled. One it doesn't list
 * is on (see `sessionTools`).
 */
export function sessionToolsOff(workspace: readonly { source: string; enabled: boolean }[], options: { failClosedOnly?: boolean } = {}): Set<string> {
  const off = new Set<string>();
  for (const extension of pikiSessionToolExtensions()) {
    if (options.failClosedOnly && !extension.failClosed) continue;
    if (workspace.some(item => item.source === extension.source && !item.enabled)) for (const tool of extension.sessionTools ?? []) off.add(tool);
  }
  return off;
}

/** The Pikibun extensions for repositories of `provider`. */
export function pikiExtensionsFor(provider: string): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => (item.providers as readonly string[]).includes(provider));
}
