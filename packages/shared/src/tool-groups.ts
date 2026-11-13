import { canonicalToolName, canonicalToolNames, groupedToolNames, legacyToolNames, toolNames, toolsGroupedUnder, type WorkspaceRole } from "./types.js";

export const groupTools = [
  "identity", "ls", "read", "grep", "write", "edit", "move_file", "copy_file", "delete_file",
  "git", "git_push", "node", "python", "rust", "go", "dotnet", "make", "browser", "tunnel",
  "github_read", "github_comment", "github_issue", "github_merge", "source_read", "schedule", "sessions",
] as const;
export type GroupTool = (typeof groupTools)[number];

export const forgeWriteTools: readonly GroupTool[] = ["git_push", "github_comment", "github_issue", "github_merge"];

export const groupToolInfo: Record<GroupTool, { label: string; kind: "files" | "commands" | "publish" | "workspace" }> = {
  identity: { label: "Session identity", kind: "files" },
  ls: { label: "List files", kind: "files" },
  read: { label: "Read files", kind: "files" },
  grep: { label: "Search files", kind: "files" },
  write: { label: "Write files", kind: "files" },
  edit: { label: "Edit files", kind: "files" },
  move_file: { label: "Move files", kind: "files" },
  copy_file: { label: "Copy files", kind: "files" },
  delete_file: { label: "Delete files", kind: "files" },
  git: { label: "Git (clone, commit, push to the session branch)", kind: "commands" },
  node: { label: "Node.js", kind: "commands" },
  python: { label: "Python", kind: "commands" },
  rust: { label: "Rust", kind: "commands" },
  go: { label: "Go", kind: "commands" },
  dotnet: { label: ".NET", kind: "commands" },
  make: { label: "Make", kind: "commands" },
  browser: { label: "Browser", kind: "commands" },
  git_push: { label: "Push to other branches, open pull requests", kind: "publish" },
  tunnel: { label: "Put web apps online (tunnel)", kind: "publish" },
  github_read: { label: "Read GitHub issues and pull requests", kind: "publish" },
  github_comment: { label: "Comment on GitHub", kind: "publish" },
  github_issue: { label: "Open GitHub issues", kind: "publish" },
  github_merge: { label: "Merge pull requests", kind: "publish" },
  source_read: { label: "Read document sources", kind: "workspace" },
  schedule: { label: "Scheduled prompts", kind: "workspace" },
  sessions: { label: "Work with other sessions", kind: "workspace" },
};

const readTools: readonly GroupTool[] = ["identity", "ls", "read", "grep"];
const sandboxTools: readonly GroupTool[] = [...readTools, "write", "edit", "move_file", "copy_file", "delete_file",
  "git", "node", "python", "rust", "go", "dotnet", "make", "browser", "github_read", "source_read"];

export const roleTools: Readonly<Record<WorkspaceRole, readonly GroupTool[]>> = {
  owner: groupTools,
  admin: groupTools,
  collaborator: groupTools.filter(tool => tool !== "github_merge" && tool !== "tunnel"),
  member: sandboxTools,
  viewer: readTools,
};

export const roleGroupNames: Readonly<Record<WorkspaceRole, string>> = {
  owner: "Owners and admins", admin: "Owners and admins", collaborator: "Collaborators", member: "Members", viewer: "Viewers",
};

export const toolGroupLimits = { groups: 50, name: 80 } as const;

export interface ToolGroup {
  id: string;
  name: string;
  tools: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ToolGroupMember {
  userId: string;
  displayName: string;
  username: string | null;
  githubLogin: string | null;
  role: WorkspaceRole;
  groupId: string | null;
}

export interface ToolGroupSettings {
  groups: ToolGroup[];
  members: ToolGroupMember[];
  roles: Record<WorkspaceRole, string[]>;
  tools: string[];
  admin: boolean;
}

export interface MemberToolGroup {
  name: string;
  off: string[];
}

export function isGroupTool(value: unknown): value is GroupTool {
  return typeof value === "string" && (groupTools as readonly string[]).includes(value);
}

export function canonicalGroupTools(value: readonly unknown[]): GroupTool[] {
  const canonical = value.map(item => typeof item === "string" ? canonicalToolName(item) : item);
  return groupTools.filter(tool => canonical.includes(tool));
}

export function parseGroupTools(value: unknown): GroupTool[] {
  if (!Array.isArray(value) || value.length > groupTools.length * 2) throw new Error("Tools are a list of Pikibun's session tools.");
  const unknown = value.find(item => !isGroupTool(typeof item === "string" ? canonicalToolName(item) : item));
  if (unknown !== undefined) throw new Error(`${typeof unknown === "string" ? unknown : "That"} isn't one of Pikibun's session tools.`);
  return canonicalGroupTools(value);
}

export function legacyGroupToolNames(tools: readonly string[]): string[] {
  return tools.map(tool => legacyToolNames(tool)[0] ?? tool);
}

export function memberTools(role: WorkspaceRole, group?: { tools: readonly string[] } | null): GroupTool[] {
  return group ? canonicalGroupTools(group.tools) : [...roleTools[role]];
}

export function toolsLeftOut(tools: readonly string[]): GroupTool[] {
  const canonical = canonicalToolNames(tools);
  return groupTools.filter(tool => !canonical.includes(tool));
}

export const retiredGroupTools: readonly string[] = toolNames.filter(tool => !isGroupTool(tool) && !(tool in groupedToolNames));

export function toolsOff(tools: readonly string[]): string[] {
  const out = toolsLeftOut(tools).flatMap(tool => [tool, ...toolsGroupedUnder(tool)]);
  return out.length ? [...out, ...retiredGroupTools] : [];
}

export const unknownToolGroup: MemberToolGroup = { name: "not known yet: Pikibun hasn't answered", off: toolsOff(roleTools.viewer) };

export function parseMemberToolGroups(value: unknown): Record<string, MemberToolGroup> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tool groups");
  const result: Record<string, MemberToolGroup> = {};
  for (const [userId, group] of Object.entries(value as Record<string, unknown>)) {
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("Invalid tool groups");
    const { name, off } = group as Record<string, unknown>;
    if (typeof name !== "string" || name.length > toolGroupLimits.name || !Array.isArray(off) || off.some(tool => typeof tool !== "string" || tool.length > 64)) {
      throw new Error("Invalid tool groups");
    }
    const canonical = canonicalToolNames(off as string[]);
    result[userId] = { name, off: [...new Set([...canonical, ...canonical.flatMap(toolsGroupedUnder)])] };
  }
  return result;
}
