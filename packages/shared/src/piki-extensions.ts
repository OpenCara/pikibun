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
  controlPlane?: boolean;
  needs?: readonly `piki:${string}`[];
  settings?: readonly PikiExtensionSetting[];
}

export interface PikiExtensionSetting {
  name: string;
  type: "boolean" | "string";
  description?: string;
  default?: boolean | string;
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
    signIn: "az login (and sudo az extension add --name azure-devops --system)", providers: ["azure-devops"],
  },
  {
    name: "schedule", source: "piki:schedule", title: "Scheduled prompts", sessionTools: ["schedule"],
    description: "The schedule tool: the agent lists, creates, changes and deletes scheduled prompts when its owner asks, such as a nightly check: ones that wake the session, and the workspace's that start a new session each run. New workspaces start with it; older ones add it here.",
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
    description: "The git and git_push tools: the agent runs Git (clone, status, diff, log, commit, switch, fetch, merge, rebase ...) with its arguments as a list, without a shell, and pushes a clone's commit to another branch. New workspaces start with it; older ones get it with their first repository.",
    providers: gitProviders,
  },
  {
    name: "node", source: "piki:node", title: "Node.js", sessionTools: ["node"],
    description: "The node tool: the agent runs Node.js and its package managers (node, npm, npx, pnpm, yarn, corepack) with their arguments as a list, without a shell, each call checked as a command is. New workspaces start with it; older ones add it here.",
    providers: [],
  },
  {
    name: "python", source: "piki:python", title: "Python", sessionTools: ["python"],
    description: "The python tool: the agent runs Python and its package and test tools (python3, pip, pip3, uv, uvx, poetry, pytest) with their arguments as a list, without a shell, each call checked as a command is. New workspaces start with it; older ones add it here.",
    providers: [],
  },
  {
    name: "rust", source: "piki:rust", title: "Rust", sessionTools: ["rust"],
    description: "The rust tool: the agent runs cargo, rustc, rustup and rustfmt with their arguments as a list, without a shell, each call checked as a command is. Off until added here.",
    providers: [],
  },
  {
    name: "go", source: "piki:go", title: "Go", sessionTools: ["go"],
    description: "The go tool: the agent runs go and gofmt with their arguments as a list, without a shell, each call checked as a command is. Off until added here.",
    providers: [],
  },
  {
    name: "dotnet", source: "piki:dotnet", title: ".NET", sessionTools: ["dotnet"],
    description: "The dotnet tool: the agent runs the .NET CLI with its arguments as a list, without a shell, each call checked as a command is. Off until added here.",
    providers: [],
  },
  {
    name: "make", source: "piki:make", title: "Make", sessionTools: ["make"],
    description: "The make tool: the agent runs make with its arguments as a list, without a shell of its own, each call checked as a command is (a Makefile's recipes are shell commands). Off until added here.",
    providers: [],
  },
  {
    name: "browser", source: "piki:browser", title: "Browser", sessionTools: ["browser"],
    description: "The browser tool: the agent drives a headless Chromium in the session's sandbox (open a page, click, type, run a script, take a screenshot), serving the web app it works on for the call, each call checked as a command is. Its screenshots show in the session panel's Browser tab. Runs only in the Linux sandbox, with Chromium on the host. Off until added here.",
    providers: [],
  },
  {
    name: "tunnel", source: "piki:tunnel", title: "Tunnel", sessionTools: ["tunnel"], optIn: true,
    description: "The tunnel tool: the agent starts the web server it works on in the session's sandbox, as a service that outlives the call, and puts it online at a public https:// address through a Cloudflare quick tunnel, which cloudflared runs on the host. It starts only for the host's owner or a member they granted host commands. The session panel shows the address with a Stop button. Runs only in the Linux sandbox, with cloudflared on the host. Off until added here.",
    providers: [],
  },
  {
    name: "files", source: "piki:files", title: "Files", core: true,
    sessionTools: ["identity", "ls", "read", "grep", "find", "write", "edit", "move_file", "copy_file", "delete_file"],
    description: "The file tools: the agent reads, searches, writes, edits, moves, copies and deletes the session's files, and reads who the session is for. Every session needs them, so they are always on.",
    providers: [],
  },
  {
    name: "github", source: "piki:github", title: "GitHub, through Pikibun", sessionTools: ["github_read", "github_comment", "github_issue", "github_merge"],
    description: "The github_read, github_comment, github_issue and github_merge tools: the agent reads issues and pull requests, waits for their checks, and comments, opens issues and merges, as the session owner, through Pikibun's broker. With the GitHub CLI on too, the agent reads and waits for checks with gh instead, sparing the session owner's GitHub rate limit, and uses these where gh can't. New workspaces start with it; older ones get it with their first GitHub repository.",
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
    description: "The sessions tool: the agent lists, reads, messages, starts, stops and archives the workspace's other sessions, as the message's sender, with their permissions. New workspaces start with it; older ones add it here.",
    providers: [],
  },
  {
    name: "workspace", source: "piki:workspace", title: "Workspace management", sessionTools: ["workspace"], optIn: true,
    description: "The workspace tool: the agent reads the session's workspace (members, join requests, repositories, document sources, extensions, tool groups, network access) and, when asked, changes it (renames it, adds, removes and changes members, accepts join requests, adds and removes repositories and extensions, sets tool groups and network access), as the message's sender, with exactly their workspace role. New workspaces start with it; older ones add it here.",
    providers: [],
  },
  {
    name: "memory", source: "piki:memory", title: "Workspace memory", sessionTools: ["memory"], optIn: true,
    description: "A memory and instructions for the whole workspace, as Claude Projects keep a project's knowledge: every session's agent starts with them in its instructions, proposes notes with the memory tool (decisions, conventions, lessons, what a finished sub-task found), and owners and admins keep the notes worth keeping, here or from a session. Agents also search the workspace's earlier sessions. Off until added here.",
    providers: [],
  },
  {
    name: "artifacts", source: "piki:artifacts", title: "Artifacts", sessionTools: ["publish_artifact"], optIn: true,
    description: "The publish_artifact tool: the agent publishes something people should look at (a report, a chart, a UI mock, a diagram) as a versioned HTML, SVG, Markdown or text artifact kept with the session, shown as a card in the transcript and in the session panel's Artifacts tab to whoever may read the session. HTML and SVG run sandboxed, with no network. New workspaces start with it; older ones add it here.",
    providers: [],
  },
  {
    name: "prompt-audit", source: "piki:prompt-audit", title: "Prompt audit",
    description: "Has a model of the host check each message from anyone but the host's owner before it reaches the agent, and refuses ones that reach for the host's credentials, files, environment or network. A message it can't check is refused too.",
    providers: [],
  },
  {
    name: "pr-flow", source: "piki:pr-flow", title: "Pull request flow", workflow: true,
    description: "Has the agent carry each change through a pull request (a merge request on GitLab): a draft as soon as it starts changing a repository's files, ready for review once the change is done, then a review window (review-minutes) in which it fixes the valid review points and waits again for a re-review, then the merge. A review-minutes of 0, or wait-for-review off, merges as soon as it is ready; auto-merge off leaves the merge to people; require-approval merges only approved ones; draft-first off opens it only once the change is done. Each step is the session's own tools, under the session's usual rules.",
    providers: [],
  },
  {
    name: "context-files", source: "piki:context-files", title: "Context files",
    description: "Adds the files its context-files setting names to each message's system prompt, as Pi does with a project's AGENTS.md: each clone's AGENTS.md or CLAUDE.md by default, other files in a clone, host:<name> files from the host owner's context directory, or https:// pages.",
    providers: [],
  },
  {
    name: "skills", source: "piki:skills", title: "Skills", sessionTools: [], optIn: true,
    description: "Lists the skills of the repositories in each session's worktree (Agent Skills: SKILL.md files under .pi/skills, .agents/skills or .claude/skills) in each message's system prompt, by name and description, so the agent reads one when a task matches it, as Pi does. A skill is its repository's text, so this reaches the model whatever repository was cloned. The session does it itself, with no package and no tools. Off, skills still answer to /skill:name. New workspaces start with it; older ones add it here.",
    providers: [],
  },
  {
    name: "sub-agents", source: "piki:sub-agents", title: "Sub-agents", workflow: true, needs: ["piki:sessions"],
    description: "Has the agent hand sub-tasks to sub-agents, sessions it starts with the sessions tool (adding it adds Other sessions too): independent parts that can run at once, or parts that need hardware or a model its host lacks. Pikibun places each on the least loaded host that meets its conditions (a GPU, CPUs, memory, disk, platform, models), with the workspace's placement and models settings added where the agent sets none; max-sub-agents bounds each message, and each reports back when it finishes.",
    providers: [],
  },
  {
    name: "auto-mode", source: "piki:auto-mode", title: "Auto mode", controlPlane: true, optIn: true,
    description: "Adds Auto to the host and model dropdowns: Pikibun picks the session's host, model and reasoning level for the task, from how complex it looks (simple ones get a light model, complex ones a frontier model with more reasoning) and the hosts' details (online, shared here, yours, sandboxed, with a GPU where the task needs one, how busy). Its models setting limits which models Auto may choose. Pikibun runs it itself: hosts install nothing. Without it, the dropdowns have no Auto.",
    providers: [],
    settings: [{
      name: "models", type: "string", default: "",
      description: "The only models Auto may choose, and judge messages with, separated by commas: model ids (claude-sonnet-4-5), provider/model (anthropic/claude-sonnet-4-5), or globs such as anthropic/* or *sonnet*. Empty lets Auto choose any model the session's host offers",
    }],
  },
] as const satisfies readonly PikiExtensionInfo[]);

export function neededExtensions(source: string): PikiExtensionInfo[] {
  return (pikiExtension(source)?.needs ?? []).flatMap(needed => pikiExtension(needed) ?? []);
}

export function missingNeeds(source: string, workspace: readonly { source: string; enabled: boolean }[]): PikiExtensionInfo[] {
  return neededExtensions(source).filter(needed => !needed.core && !workspace.some(item => item.source === needed.source && item.enabled));
}

export function pikiExtension(source: string): PikiExtensionInfo | undefined {
  return pikiExtensions.find(item => item.source === source);
}

export function pikiCommandExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.tool !== undefined);
}

export function pikiWorkflowExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.workflow === true);
}

export function pikiControlPlaneExtensions(): PikiExtensionInfo[] {
  return pikiExtensions.filter(item => item.controlPlane === true);
}

export function isControlPlaneExtension(source: string): boolean {
  return pikiExtension(source)?.controlPlane === true;
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
