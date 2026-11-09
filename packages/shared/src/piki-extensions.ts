import type { GitProvider } from "./repositories.js";
import type { DocumentKind } from "./sources.js";

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
  /**
   * Session tools only: tools every session needs (reading and writing its files), which its workspace can't turn off.
   * The workspace page shows it as always on, and a workspace's choice to turn it off is refused and ignored.
   */
  core?: boolean;
  /**
   * Session tools only: a switch for tools sessions no longer have (bash, host_bash). Kept in the catalogue so the
   * control plane still sends a workspace's choice to connectors that predate the removal, which still offer the tool;
   * workspace pages don't list it.
   */
  retired?: boolean;
  /**
   * Session tools only: off unless the workspace lists it turned on, rather than on unless turned off, for tools that
   * do something a workspace should choose (put a server online). A workspace that never chose, a control plane that
   * predates it and a connector that can't read the workspace's choice all leave it off.
   */
  optIn?: boolean;
  /**
   * Session tools only: the retired extension whose switch this one took a share of (piki:sources, split into one per
   * kind of document source). While the workspace hasn't chosen this one, it follows that one's choice, so a workspace
   * that turned the old one off keeps its tools off.
   */
  replaces?: `piki:${string}`;
  /**
   * Document-source extensions only: the kinds of document source whose items `source_read` reads while this extension
   * is on. `source_read` is offered while any of them is on, and lists and reads only the sources of kinds that are on.
   */
  documentKinds?: readonly DocumentKind[];
  /**
   * A workflow: no tool of its own, but how the agent goes about its work with the session's tools (the pull request
   * flow). The workspace page offers it when adding an extension, as it offers the command-line tools.
   */
  workflow?: boolean;
}

/** A document-source extension, one per kind of source: each turns source_read on for its kind. */
function documentSourceExtension(name: string, kind: DocumentKind, title: string): PikiExtensionInfo {
  return {
    name, source: `piki:${name}`, title, sessionTools: ["source_read"], replaces: "piki:sources", documentKinds: [kind],
    description: `The source_read tool for the workspace's ${title} sources: the agent reads them as the session owner. On unless turned off here.`,
    providers: [],
  };
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
    // Retired with host_bash (#163): kept so connectors still report it and the control plane still sends a workspace's
    // choice to older connectors, which have the tool, and keep it off there; no workspace page lists it.
    name: "host-shell", source: "piki:host-shell", title: "Host commands", sessionTools: ["host_bash"], failClosed: true, retired: true,
    description: "The host_bash tool, retired: sessions no longer run commands on the host. Connectors from before its removal still offer it unless turned off.",
    providers: [],
  },
  {
    // Retired with bash (#163), as piki:host-shell is.
    name: "shell", source: "piki:shell", title: "Shell commands", sessionTools: ["bash"], failClosed: true, retired: true,
    description: "The bash tool, retired: sessions clone and commit with git, build and test with node and python, move files with the file tools and chain tools with code mode. Connectors from before its removal still offer it unless turned off.",
    providers: [],
  },
  {
    name: "git", source: "piki:git", title: "Git", sessionTools: ["git", "git_push"],
    description: "The git and git_push tools: the agent runs Git (clone, status, diff, log, commit, switch, fetch, merge, rebase ...) with its arguments as a list, without a shell, each call approved as a command is, and pushes a clone's commit to another branch with approval. On unless turned off here.",
    providers: [],
  },
  {
    name: "node", source: "piki:node", title: "Node.js", sessionTools: ["node"],
    description: "The node tool: the agent runs Node.js and its package managers (node, npm, npx, pnpm, yarn, corepack) with their arguments as a list, without a shell, each call approved as a command is. On unless turned off here.",
    providers: [],
  },
  {
    name: "python", source: "piki:python", title: "Python", sessionTools: ["python"],
    description: "The python tool: the agent runs Python and its package and test tools (python3, pip, pip3, uv, uvx, poetry, pytest) with their arguments as a list, without a shell, each call approved as a command is. On unless turned off here.",
    providers: [],
  },
  {
    name: "rust", source: "piki:rust", title: "Rust", sessionTools: ["rust"],
    description: "The rust tool: the agent runs cargo, rustc, rustup and rustfmt with their arguments as a list, without a shell, each call approved as a command is. On unless turned off here.",
    providers: [],
  },
  {
    name: "go", source: "piki:go", title: "Go", sessionTools: ["go"],
    description: "The go tool: the agent runs go and gofmt with their arguments as a list, without a shell, each call approved as a command is. On unless turned off here.",
    providers: [],
  },
  {
    name: "dotnet", source: "piki:dotnet", title: ".NET", sessionTools: ["dotnet"],
    description: "The dotnet tool: the agent runs the .NET CLI with its arguments as a list, without a shell, each call approved as a command is. On unless turned off here.",
    providers: [],
  },
  {
    name: "make", source: "piki:make", title: "Make", sessionTools: ["make"],
    description: "The make tool: the agent runs make with its arguments as a list, without a shell of its own, each call approved as a command is (a Makefile's recipes are shell commands). On unless turned off here.",
    providers: [],
  },
  {
    name: "browser", source: "piki:browser", title: "Browser", sessionTools: ["browser"],
    description: "The browser tool: the agent drives a headless Chromium in the session's sandbox (open a page, click, type, run a script, take a screenshot), serving the web app it works on for the call, each call approved as a command is. Its screenshots show in the session panel's Browser tab. Runs only in the Linux sandbox, with Chromium on the host. On unless turned off here.",
    providers: [],
  },
  {
    name: "tunnel", source: "piki:tunnel", title: "Tunnel", sessionTools: ["tunnel"], optIn: true,
    description: "The tunnel tool: the agent starts the web server it works on in the session's sandbox, as a service that outlives the call, and puts it online at a public https:// address through a Cloudflare quick tunnel, which cloudflared runs on the host. Each start is approved as a host command is, never automatically. The session panel shows the address with a Stop button. Runs only in the Linux sandbox, with cloudflared on the host. Off unless turned on here.",
    providers: [],
  },
  {
    name: "files", source: "piki:files", title: "Files", core: true,
    sessionTools: ["identity", "list_files", "read_file", "search", "write_file", "edit_file", "move_file", "copy_file", "delete_file"],
    description: "The file tools: the agent reads, searches, writes, edits, moves, copies and deletes the session's files, and reads who the session is for. Every session needs them, so they are always on.",
    providers: [],
  },
  {
    name: "github", source: "piki:github", title: "GitHub, through Pikibun", sessionTools: ["github_read", "github_comment", "github_issue", "github_merge"],
    description: "The github_read, github_comment, github_issue and github_merge tools: the agent reads issues and pull requests, waits for their checks, and comments, opens issues and merges with approval, as the session owner, through Pikibun's broker. On unless turned off here.",
    providers: [],
  },
  {
    // Retired when split into one extension per kind of source, below: kept so connectors still report it, and the
    // control plane still sends older connectors, which have only it, whether any of those is on (connectorWorkspaceExtensions).
    // A workspace that turned it off keeps every kind it hasn't chosen since off (`replaces`).
    name: "sources", source: "piki:sources", title: "Document sources", sessionTools: ["source_read"], retired: true,
    description: "The source_read tool for every kind of document source, retired: each kind has its own extension now (piki:notion, piki:google-drive, ...). Connectors from before the split still offer it unless turned off.",
    providers: [],
  },
  documentSourceExtension("notion", "notion", "Notion"),
  documentSourceExtension("google-drive", "google-drive", "Google Drive"),
  documentSourceExtension("dropbox", "dropbox", "Dropbox"),
  documentSourceExtension("onedrive", "onedrive", "OneDrive / SharePoint"),
  documentSourceExtension("feishu", "feishu", "Feishu / Lark"),
  documentSourceExtension("tencent-docs", "tencent-docs", "Tencent Docs"),
  {
    name: "sessions", source: "piki:sessions", title: "Other sessions", sessionTools: ["sessions"],
    description: "The sessions tool: the agent lists, reads, messages, starts, stops and archives the workspace's other sessions, as the message's sender, with their permissions. On unless turned off here.",
    providers: [],
  },
  {
    name: "prompt-audit", source: "piki:prompt-audit", title: "Prompt audit",
    description: "Has a model of the host check each message from anyone but the host's owner before it reaches the agent, and refuses ones that reach for the host's credentials, files, environment or network. A message it can't check is refused too.",
    providers: [],
  },
  {
    name: "pr-flow", source: "piki:pr-flow", title: "Pull request flow", workflow: true,
    description: "Has the agent carry each change through a pull request (a merge request on GitLab): a draft as soon as it starts changing a repository's files, ready for review once the change is done, then a review window (review-minutes) in which it fixes the valid review points and waits again for a re-review, then the merge. A review-minutes of 0 merges as soon as it is ready. Each step is the session's own tools, approved as always.",
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

/** The Pikibun workflow extensions (`workflow`), which the workspace page offers when adding an extension. */
export function pikiWorkflowExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.workflow === true);
}

/** The Pikibun extensions that turn on session tools, which the workspace page lists whether or not the workspace chose them. */
export function pikiSessionToolExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.sessionTools !== undefined);
}

/**
 * Whether `workspace` has `extension` on: a core one always; an opt-in one (`optIn`) only where it lists it enabled; one
 * it lists as it lists it; one it doesn't list, as it lists the retired one this one `replaces`, if it does; otherwise on
 * (see `sessionTools`).
 */
export function pikiExtensionOn(extension: PikiExtensionInfo, workspace: readonly { source: string; enabled: boolean }[]): boolean {
  if (extension.core) return true;
  if (extension.optIn) return workspace.some(item => item.source === extension.source && item.enabled);
  const chosen = workspace.find(item => item.source === extension.source)
    ?? (extension.replaces ? workspace.find(item => item.source === extension.replaces) : undefined);
  return chosen ? chosen.enabled : true;
}

/**
 * Whether `workspace` has the extension `source` on: as `pikiExtensionOn` decides for one this version knows, and for one
 * a newer control plane's tool definitions name (tool-definitions.ts), on unless the workspace lists it turned off.
 */
export function extensionSwitchOn(source: string, workspace: readonly { source: string; enabled: boolean }[]): boolean {
  const known = pikiExtension(source);
  return known ? pikiExtensionOn(known, workspace) : !workspace.some(item => item.source === source && !item.enabled);
}

/** The session-tool extensions that switch tools now: not the ones a newer extension `replaces`. */
function switchingExtensions(): PikiExtensionInfo[] {
  const replaced = new Set(pikiExtensions.flatMap(item => item.replaces ? [item.replaces] : []));
  return pikiSessionToolExtensions().filter(item => !replaced.has(item.source));
}

/**
 * The session tools `workspace` turns off: those whose every session-tool extension it has off (one tool may come with
 * several, as source_read does with each kind of document source). One it doesn't list is on (see `sessionTools`), but
 * for an opt-in one (`optIn`), which is off unless it lists it enabled.
 */
export function sessionToolsOff(workspace: readonly { source: string; enabled: boolean }[], options: { failClosedOnly?: boolean } = {}): Set<string> {
  const offering = new Map<string, PikiExtensionInfo[]>();
  for (const extension of switchingExtensions()) {
    for (const tool of extension.sessionTools ?? []) offering.set(tool, [...offering.get(tool) ?? [], extension]);
  }
  const off = new Set<string>();
  for (const [tool, extensions] of offering) {
    if (options.failClosedOnly && !extensions.every(extension => extension.failClosed || extension.optIn)) continue;
    if (extensions.every(extension => !pikiExtensionOn(extension, workspace))) off.add(tool);
  }
  return off;
}

/** The kinds of document source `workspace` turns off, whose sources source_read neither lists nor reads. */
export function documentKindsOff(workspace: readonly { source: string; enabled: boolean }[]): Set<DocumentKind> {
  const off = new Set<DocumentKind>();
  for (const extension of switchingExtensions()) {
    if (!pikiExtensionOn(extension, workspace)) for (const kind of extension.documentKinds ?? []) off.add(kind);
  }
  return off;
}

/** The session-tool extensions that offer `tool` now (several for source_read), for naming them where it is off. */
export function sessionToolExtensions(tool: string): PikiExtensionInfo[] {
  return switchingExtensions().filter(item => item.sessionTools?.includes(tool));
}

/** The document-source extension of `kind`. */
export function documentSourceExtensionOf(kind: DocumentKind): PikiExtensionInfo | undefined {
  return switchingExtensions().find(item => item.documentKinds?.includes(kind));
}

/** Whether the workspace whose extensions are `workspace` has the session-tool extension `source` on, as sessionToolsOff decides. */
export function sessionToolExtensionOn(workspace: readonly { source: string; enabled: boolean }[], source: string): boolean {
  const extension = pikiExtension(source);
  return !!extension?.sessionTools && pikiExtensionOn(extension, workspace);
}

/** The Pikibun extensions for repositories of `provider`. */
export function pikiExtensionsFor(provider: string): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => (item.providers as readonly string[]).includes(provider));
}
