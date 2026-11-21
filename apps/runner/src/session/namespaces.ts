import { defineExtension, type Extension, type ToolNamespace, type ToolRegistration } from "@earendil-works/pi-durable";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { ToolDefinition } from "../../../../packages/shared/src/tool-definitions.js";
import { remoteMcpRoutePrefix, type RemoteMcpServerSummary } from "../../../../packages/shared/src/remote-mcp.js";

export const WORKSPACE_TOOLS = "workspace-tools";

export const sessionNamespaces = Object.freeze({
  files: { name: "files", description: "Read, list, search, write, edit, move, copy and delete the session's files; identity says whose session this is." },
  programs: { name: "programs", description: "Run Git, Python, Node.js and the other toolchains (Rust, Go, .NET, make) in the worktree, each with its arguments as a list, without a shell." },
  github: { name: "github", description: "GitHub as the session owner: read, comment on and merge issues and pull requests, open issues, run gh; git_push publishes a clone's commit to a branch and opens its pull request." },
  sessions: { name: "sessions", description: "The workspace's other sessions (list, read, ask, message, start sub-agents) and scheduled prompts that run later or on a schedule." },
  browser: { name: "browser", description: "Drive a headless browser in the sandbox to look at or test a web page, and put a web server the session runs online through a tunnel." },
  artifacts: { name: "artifacts", description: "Publish a report, chart, mock or diagram for people to look at, kept with the session outside the transcript." },
  documents: { name: "documents", description: "Read the workspace's document sources (Notion, Google Drive, Dropbox, OneDrive, Feishu, Tencent Docs) as the session owner." },
  workspace: { name: "workspace", description: "Read the session's workspace and, when asked, change it: members, repositories, sources, extensions, tool groups, network access." },
} satisfies Record<string, ToolNamespace>);

type SessionNamespace = keyof typeof sessionNamespaces;

const ownTools: Readonly<Record<string, SessionNamespace>> = Object.freeze({
  identity: "files", ls: "files", read: "files", grep: "files", find: "files", write: "files", edit: "files", move_file: "files", copy_file: "files", delete_file: "files",
  git: "programs", python: "programs", node: "programs", rust: "programs", go: "programs", dotnet: "programs", make: "programs",
  git_push: "github", github_read: "github", github_comment: "github", github_merge: "github", github_issue: "github",
  sessions: "sessions", schedule: "sessions",
  browser: "browser", tunnel: "browser",
  publish_artifact: "artifacts",
  source_read: "documents",
  workspace: "workspace",
});

const pikiNamespaces: Readonly<Record<string, ToolNamespace>> = Object.freeze({
  "piki:gh": sessionNamespaces.github,
  "piki:glab": { name: "gitlab", description: "GitLab as the session owner through the glab CLI: merge requests, issues, CI/CD pipelines and their logs, releases and the GitLab API." },
  "piki:azure-cli": { name: "azure", description: "Azure DevOps as the session owner through the az CLI: pull requests, pipelines and work items." },
});

const DESCRIPTION_LIMIT = 300;
const NAME_LIMIT = 64;

const oneLine = (text: string, limit: number) => {
  const line = text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
};

const namespaceKey = (name: string) => toCodemodeIdentifier(name.toLowerCase());

export const reservedNamespaceKeys: ReadonlySet<string> = new Set([...Object.values(sessionNamespaces), ...Object.values(pikiNamespaces)].map(item => namespaceKey(item.name)));

export function remoteNamespaces(servers: readonly RemoteMcpServerSummary[], prefixes: Iterable<string>): Map<string, ToolNamespace> {
  const named = new Map(servers.map(server => [server.prefix, server.name]));
  const taken = new Set(reservedNamespaceKeys);
  const namespaces = new Map<string, ToolNamespace>();
  for (const prefix of [...new Set(prefixes)].sort()) {
    const label = oneLine(named.get(prefix) ?? "", NAME_LIMIT);
    let name = label && !taken.has(namespaceKey(label)) ? label : `mcp_${prefix}`;
    for (let suffix = 2; taken.has(namespaceKey(name)); suffix++) name = `mcp_${prefix}_${suffix}`;
    taken.add(namespaceKey(name));
    namespaces.set(prefix, { name, description: oneLine(`The workspace's remote MCP server ${label || prefix}: its tools, named ${prefix}_*, run through Pikibun with credentials no session sees.`, DESCRIPTION_LIMIT) });
  }
  return namespaces;
}

export function toolNamespaces(tools: readonly ToolRegistration[], definitions: readonly ToolDefinition[], servers: readonly RemoteMcpServerSummary[]): Map<string, ToolNamespace> {
  const defined = new Map(definitions.map(definition => [definition.name, definition]));
  const prefixOf = (name: string) => {
    const definition = defined.get(name);
    return definition?.kind === "brokered" && definition.inputSchema ? remoteMcpRoutePrefix(definition.route) : undefined;
  };
  const remote = remoteNamespaces(servers, tools.flatMap(tool => prefixOf(tool.name) ?? []));
  const namespaces = new Map<string, ToolNamespace>();
  for (const tool of tools) {
    const own = ownTools[tool.name];
    const prefix = prefixOf(tool.name);
    const namespace = own ? sessionNamespaces[own] : prefix ? remote.get(prefix) : defined.get(tool.name)?.kind === "program" ? sessionNamespaces.programs : undefined;
    if (namespace) namespaces.set(tool.name, namespace);
  }
  return namespaces;
}

export function namespaceExtensions(tools: readonly ToolRegistration[], namespaces: ReadonlyMap<string, ToolNamespace>): Extension[] {
  const groups = new Map<string, { namespace: ToolNamespace; tools: ToolRegistration[] }>();
  for (const tool of tools) {
    const namespace = namespaces.get(tool.name);
    if (!namespace) continue;
    const group = groups.get(namespace.name) ?? { namespace, tools: [] };
    group.tools.push(tool);
    groups.set(namespace.name, group);
  }
  return [...groups.values()].sort((a, b) => a.namespace.name < b.namespace.name ? -1 : a.namespace.name > b.namespace.name ? 1 : 0)
    .map(group => defineExtension({ name: `${WORKSPACE_TOOLS}:${group.namespace.name}`, namespace: group.namespace, tools: group.tools }));
}

export function selectedNamespaces(groups: readonly Extension[], enabled: Iterable<string>): Extension[] {
  const on = new Set(enabled);
  return groups.filter(group => (group.tools ?? []).some(tool => on.has(tool.name)));
}

export function extensionNamespace(source: string, summary: { name?: string; description?: string }, taken: ReadonlySet<string>): ToolNamespace | undefined {
  const piki = pikiNamespaces[source];
  if (piki) return piki;
  const name = oneLine(summary.name ?? "", NAME_LIMIT);
  if (!name || taken.has(namespaceKey(name))) return undefined;
  const description = oneLine(summary.description ?? "", DESCRIPTION_LIMIT) || `The tools of the Pi extension ${name}.`;
  return { name, description };
}

export { namespaceKey };
