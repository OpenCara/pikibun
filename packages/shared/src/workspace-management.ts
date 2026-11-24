import type { BrokeredToolDefinition } from "./tool-definitions.js";
import { assignableWorkspaceRoles } from "./types.js";
import { gitProviders } from "./repositories.js";
import { networkModes } from "./network.js";

export const workspaceReadActions = ["get", "members", "repositories", "sources", "extensions", "tool_groups", "network", "join_requests"] as const;
export const workspaceWriteActions = [
  "rename", "add_member", "set_role", "remove_member", "accept_join_request", "decline_join_request", "set_tool_group",
  "add_repository", "remove_repository", "set_extension", "remove_extension", "set_network_mode", "allow_domain", "disallow_domain",
] as const;
export const workspaceToolActions = [...workspaceReadActions, ...workspaceWriteActions] as const;
export type WorkspaceReadAction = (typeof workspaceReadActions)[number];
export type WorkspaceWriteAction = (typeof workspaceWriteActions)[number];
export type WorkspaceToolAction = (typeof workspaceToolActions)[number];

export function isWorkspaceWriteAction(action: string): action is WorkspaceWriteAction {
  return (workspaceWriteActions as readonly string[]).includes(action);
}

export const workspaceToolParameters = ["action", "user", "role", "name", "repository", "repository_id", "provider", "host", "ref", "extension", "enabled",
  "settings", "group", "domain", "mode"] as const;
export type WorkspaceToolParameter = (typeof workspaceToolParameters)[number];

export const workspaceActionFields: Readonly<Record<WorkspaceToolAction, { required: readonly WorkspaceToolParameter[]; optional?: readonly WorkspaceToolParameter[] }>> = {
  get: { required: [] }, members: { required: [] }, repositories: { required: [] }, sources: { required: [] }, extensions: { required: [] },
  tool_groups: { required: [] }, network: { required: [] }, join_requests: { required: [] },
  rename: { required: ["name"] },
  add_member: { required: ["user", "role"] },
  set_role: { required: ["user", "role"] },
  remove_member: { required: ["user"] },
  accept_join_request: { required: ["user"], optional: ["role"] },
  decline_join_request: { required: ["user"] },
  set_tool_group: { required: ["user", "group"] },
  add_repository: { required: ["repository"], optional: ["provider", "host", "repository_id", "ref"] },
  remove_repository: { required: ["repository"] },
  set_extension: { required: ["extension"], optional: ["enabled", "settings"] },
  remove_extension: { required: ["extension"] },
  set_network_mode: { required: ["mode"] },
  allow_domain: { required: ["domain"] },
  disallow_domain: { required: ["domain"] },
};

export const workspaceToolLimits = Object.freeze({ settingsChars: 16 * 1024, listed: 200 });

export const workspaceToolDescription = "Manage this Pikibun workspace (the one this session is in) as the person whose message you are working on, "
  + "with exactly their workspace role: what their role can't do here is refused. "
  + "Reads: get (the workspace, their role), members, repositories, sources (document sources), extensions, tool_groups, network (its network access), join_requests (people asking to join; owners and admins). "
  + "Changes (owners and admins, not in a Read-only message): rename {name}; add_member {user, role} and set_role {user, role} (role viewer, member, collaborator or admin; only the owner makes admins); "
  + "remove_member {user}; accept_join_request {user, role?} (member by default) and decline_join_request {user}; "
  + "set_tool_group {user, group} (a tool group's id from tool_groups, or role to follow their role's tools); "
  + "add_repository {repository, provider?, host?, repository_id?, ref?} (repository as its URL, such as https://github.com/owner/name, or owner/name; any repository the sender's account for that provider can read, "
  + "whose id it looks up with that account; provider github by default, or the URL's for github.com, gitlab.com, bitbucket.org and dev.azure.com; host the URL's for self-hosted providers) "
  + "and remove_repository {repository} (its id or owner/name); "
  + "set_extension {extension, enabled?, settings?} (an extension's source as extensions lists it, such as piki:node or npm:<package>@<version>; enabled and settings, a JSON object of its options, never secrets, "
  + "are kept as they are when left out. It adds only Pikibun's own extensions, piki:<name>, which are added on. An npm: or git: source the workspace doesn't list yet, or another version or commit of one it lists, "
  + "is refused: that is third-party code for every session, which a person adds or updates under Settings → Workspaces → Extensions, so tell them that instead) and remove_extension {extension}; "
  + "set_network_mode {mode} (off, allowlist or open), allow_domain {domain} and disallow_domain {domain} (a host name, or *.example.com; they matter in allowlist mode). "
  + "user is a member's id (such as github:123) as members or join_requests list it. "
  + "Change the workspace only when the person asked for it, and say what you changed.";

const userPattern = "^(?:github:[1-9][0-9]{0,19}|test:[A-Za-z0-9_-]{1,128}|password:[A-Za-z0-9_-]{1,128})$";

export const workspaceToolDefinition: BrokeredToolDefinition = {
  kind: "brokered", name: "workspace", extensions: ["piki:workspace"],
  description: workspaceToolDescription,
  parameters: {
    action: { type: "string", required: true, enum: [...workspaceToolActions], invalid: `action is one of ${workspaceToolActions.join(", ")}` },
    user: { type: "string", pattern: userPattern, maxLength: 140, description: "A member's id, as members or join_requests list it (github:123).", invalid: "user is a member's id, as members or join_requests list it (github:123)" },
    role: { type: "string", enum: [...assignableWorkspaceRoles], description: "viewer, member, collaborator or admin.", invalid: `role is one of ${assignableWorkspaceRoles.join(", ")}` },
    name: { type: "string", line: true, maxLength: 200, description: "The workspace's new name.", invalid: "name is one line of at most 200 characters" },
    repository: { type: "string", line: true, maxLength: 512, description: "A repository: its URL or owner/name to add; its id or owner/name to remove.", invalid: "repository is a repository's URL, owner/name, or a repository's id" },
    repository_id: { type: "string", pattern: "^[A-Za-z0-9_.:/-]{1,256}$", description: "The provider's id of the repository; looked up with the sender's account when left out.", invalid: "repository_id is the provider's id of the repository" },
    provider: { type: "string", enum: [...gitProviders], description: "The repository's Git provider, github by default.", invalid: `provider is one of ${gitProviders.join(", ")}` },
    host: { type: "string", pattern: "^[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?$", description: "The Git server's host name, for self-hosted providers.", invalid: "host is a host name" },
    ref: { type: "string", line: true, maxLength: 255, description: "The branch sessions clone, the repository's default branch when left out.", invalid: "ref is a branch, tag or commit of one line" },
    extension: { type: "string", line: true, maxLength: 512, description: "An extension's source: piki:<name>, or an npm:<package>@<version> or git:<https URL>@<commit> source exactly as extensions lists it.", invalid: "extension is an extension's source, such as piki:node or npm:<package>@<version>" },
    enabled: { type: "boolean", description: "Whether the extension is on; when left out, as it is, or on for a piki: extension the workspace doesn't have yet." },
    settings: { type: "string", maxLength: workspaceToolLimits.settingsChars, description: "The extension's settings as a JSON object of true, false or text values; never secrets.", invalid: "settings is a JSON object of the extension's options" },
    group: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$", description: "A tool group's id from tool_groups, or role for the member's role's tools.", invalid: "group is a tool group's id, or role" },
    domain: { type: "string", pattern: "^(?:\\*\\.)?[A-Za-z0-9.-]{1,253}$", description: "A host name the sandbox may reach, or *.example.com for its subdomains.", invalid: "domain is a host name, or *.example.com" },
    mode: { type: "string", enum: [...networkModes], description: "off, allowlist or open.", invalid: `mode is one of ${networkModes.join(", ")}` },
  },
  target: ["action", "user", "repository", "extension", "domain"],
  route: "workspace", write: false,
  instructions: "The workspace tool manages this session's own workspace (members, repositories, extensions, tool groups, network access) as the person whose message you are working on, "
    + "with their workspace role. Read with it freely; change the workspace only when the person asks for that change, and tell them what changed.",
};
