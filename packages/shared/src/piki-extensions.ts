import { gitProviders, type GitProvider } from "./repositories.js";
import type { DocumentKind } from "./sources.js";

export interface PikiExtensionInfo {
  name: string;
  source: `piki:${string}`;
  tool?: string;
  title: string;
  description: string;
  install?: string;
  account?: string;
  signIn?: string;
  providers: readonly GitProvider[];
  sessionTools?: readonly string[];
  failClosed?: boolean;
  core?: boolean;
  retired?: boolean;
  optIn?: boolean;
  replaces?: `piki:${string}`;
  documentKinds?: readonly DocumentKind[];
  workflow?: boolean;
}

function documentSourceExtension(name: string, kind: DocumentKind, title: string): PikiExtensionInfo {
  return {
    name, source: `piki:${name}`, title, sessionTools: ["source_read"], replaces: "piki:sources", documentKinds: [kind],
    description: `The source_read tool for the workspace's ${title} sources: the agent reads them as the session owner. Added with the workspace's first ${title} source.`,
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
    description: "The schedule tool: the agent lists, creates, changes and deletes the session's scheduled prompts when its owner asks, such as a nightly check. Off until added here.",
    providers: [],
  },
  {
    name: "host-shell", source: "piki:host-shell", title: "Host commands", sessionTools: ["host_bash"], failClosed: true, retired: true,
    description: "The host_bash tool, retired: sessions no longer run commands on the host. Connectors from before its removal still offer it unless turned off.",
    providers: [],
  },
  {
    name: "shell", source: "piki:shell", title: "Shell commands", sessionTools: ["bash"], failClosed: true, retired: true,
    description: "The bash tool, retired: sessions clone and commit with git, build and test with node and python, move files with the file tools and chain tools with code mode. Connectors from before its removal still offer it unless turned off.",
    providers: [],
  },
  {
    name: "git", source: "piki:git", title: "Git", sessionTools: ["git", "git_push"],
    description: "The git and git_push tools: the agent runs Git (clone, status, diff, log, commit, switch, fetch, merge, rebase ...) with its arguments as a list, without a shell, and pushes a clone's commit to another branch. Added with the workspace's first repository.",
    providers: gitProviders,
  },
  {
    name: "node", source: "piki:node", title: "Node.js", sessionTools: ["node"],
    description: "The node tool: the agent runs Node.js and its package managers (node, npm, npx, pnpm, yarn, corepack) with their arguments as a list, without a shell, each call approved as a command is. Off until added here.",
    providers: [],
  },
  {
    name: "python", source: "piki:python", title: "Python", sessionTools: ["python"],
    description: "The python tool: the agent runs Python and its package and test tools (python3, pip, pip3, uv, uvx, poetry, pytest) with their arguments as a list, without a shell, each call approved as a command is. Off until added here.",
    providers: [],
  },
  {
    name: "rust", source: "piki:rust", title: "Rust", sessionTools: ["rust"],
    description: "The rust tool: the agent runs cargo, rustc, rustup and rustfmt with their arguments as a list, without a shell, each call approved as a command is. Off until added here.",
    providers: [],
  },
  {
    name: "go", source: "piki:go", title: "Go", sessionTools: ["go"],
    description: "The go tool: the agent runs go and gofmt with their arguments as a list, without a shell, each call approved as a command is. Off until added here.",
    providers: [],
  },
  {
    name: "dotnet", source: "piki:dotnet", title: ".NET", sessionTools: ["dotnet"],
    description: "The dotnet tool: the agent runs the .NET CLI with its arguments as a list, without a shell, each call approved as a command is. Off until added here.",
    providers: [],
  },
  {
    name: "make", source: "piki:make", title: "Make", sessionTools: ["make"],
    description: "The make tool: the agent runs make with its arguments as a list, without a shell of its own, each call approved as a command is (a Makefile's recipes are shell commands). Off until added here.",
    providers: [],
  },
  {
    name: "browser", source: "piki:browser", title: "Browser", sessionTools: ["browser"],
    description: "The browser tool: the agent drives a headless Chromium in the session's sandbox (open a page, click, type, run a script, take a screenshot), serving the web app it works on for the call, each call approved as a command is. Its screenshots show in the session panel's Browser tab. Runs only in the Linux sandbox, with Chromium on the host. Off until added here.",
    providers: [],
  },
  {
    name: "tunnel", source: "piki:tunnel", title: "Tunnel", sessionTools: ["tunnel"], optIn: true,
    description: "The tunnel tool: the agent starts the web server it works on in the session's sandbox, as a service that outlives the call, and puts it online at a public https:// address through a Cloudflare quick tunnel, which cloudflared runs on the host. Each start is approved as a host command is, never automatically. The session panel shows the address with a Stop button. Runs only in the Linux sandbox, with cloudflared on the host. Off until added here.",
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
    description: "The github_read, github_comment, github_issue and github_merge tools: the agent reads issues and pull requests, waits for their checks, and comments, opens issues and merges, as the session owner, through Pikibun's broker. With the GitHub CLI on too, the agent reads and waits for checks with gh instead, sparing the session owner's GitHub rate limit, and uses these where gh can't. Added with the workspace's first GitHub repository.",
    providers: ["github"],
  },
  {
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
    description: "The sessions tool: the agent lists, reads, messages, starts, stops and archives the workspace's other sessions, as the message's sender, with their permissions. Off until added here.",
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

export function pikiExtension(source: string): PikiExtensionInfo | undefined {
  return pikiExtensions.find(item => item.source === source);
}

export function pikiCommandExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.tool !== undefined);
}

export function pikiWorkflowExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.workflow === true);
}

export function pikiSessionToolExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.sessionTools !== undefined);
}

export function pikiExtensionOn(extension: PikiExtensionInfo, workspace: readonly { source: string; enabled: boolean }[]): boolean {
  if (extension.core) return true;
  if (extension.optIn) return workspace.some(item => item.source === extension.source && item.enabled);
  const chosen = workspace.find(item => item.source === extension.source)
    ?? (extension.replaces ? workspace.find(item => item.source === extension.replaces) : undefined);
  return chosen ? chosen.enabled : true;
}

export function extensionSwitchOn(source: string, workspace: readonly { source: string; enabled: boolean }[]): boolean {
  const known = pikiExtension(source);
  return known ? pikiExtensionOn(known, workspace) : !workspace.some(item => item.source === source && !item.enabled);
}

function switchingExtensions(): PikiExtensionInfo[] {
  const replaced = new Set(pikiExtensions.flatMap(item => item.replaces ? [item.replaces] : []));
  return pikiSessionToolExtensions().filter(item => !replaced.has(item.source));
}

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

export function documentKindsOff(workspace: readonly { source: string; enabled: boolean }[]): Set<DocumentKind> {
  const off = new Set<DocumentKind>();
  for (const extension of switchingExtensions()) {
    if (!pikiExtensionOn(extension, workspace)) for (const kind of extension.documentKinds ?? []) off.add(kind);
  }
  return off;
}

export function sessionToolExtensions(tool: string): PikiExtensionInfo[] {
  return switchingExtensions().filter(item => item.sessionTools?.includes(tool));
}

export function documentSourceExtensionOf(kind: DocumentKind): PikiExtensionInfo | undefined {
  return switchingExtensions().find(item => item.documentKinds?.includes(kind));
}

export function sessionToolExtensionOn(workspace: readonly { source: string; enabled: boolean }[], source: string): boolean {
  const extension = pikiExtension(source);
  return !!extension?.sessionTools && pikiExtensionOn(extension, workspace);
}

export function pikiExtensionsFor(provider: string): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => (item.providers as readonly string[]).includes(provider));
}
