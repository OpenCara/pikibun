import type { WorkspaceRole } from "../../shared/src/types";

/**
 * Someone an app names: their user ID and, when known, their username: the one they chose on this server (unique here),
 * or else their GitHub login.
 */
export interface Person {
  id: string;
  /** The username they chose on this server; a password account's is the name in its ID. */
  username?: string | null;
  githubLogin?: string | null;
  /** Their role in the workspace, when they are known as one of its members. */
  role?: WorkspaceRole;
}

/** A workspace member as `GET /api/workspaces/:id/members` lists them. */
export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  displayName?: string;
  username?: string | null;
  githubLogin?: string | null;
}

export function memberPerson(member: WorkspaceMember): Person {
  return { id: member.userId, ...(member.username ? { username: member.username } : {}), githubLogin: member.githubLogin, role: member.role };
}

/** The name a person goes by: the username they chose here, their GitHub login, or null when they have neither. */
function handle(person: Person): string | null {
  return person.username || person.githubLogin || null;
}

/** A person's username: the one they chose here, else their GitHub login, or their user ID when they have neither. */
export function username(person: Person): string {
  return handle(person) || person.id;
}

/**
 * "username(id)", for where the exact person matters: GitHub logins aren't unique once someone renames their GitHub
 * account. Just the user ID when there is no username.
 */
export function usernameWithId(person: Person): string {
  const name = handle(person);
  return name ? `${name}(${person.id})` : person.id;
}

/** Looks people up by user ID; anyone not listed is known only by their ID. */
export function peopleDirectory(people: readonly Person[]): (id: string) => Person {
  const byId = new Map(people.map(person => [person.id, person]));
  return id => byId.get(id) ?? { id };
}

/**
 * The user ID a typed or pasted value names: the ID in "username(id)", the ID of the person in `people` with that
 * username (unique here), or of the one with that GitHub login (usernames and logins ignore case; a leading @ is
 * allowed), or else the trimmed value itself, such as a user ID. An ambiguous or unknown name comes back as typed, for
 * the server to refuse.
 */
export function userIdFromInput(value: string, people: readonly Person[] = []): string {
  const text = value.trim();
  const labelled = /^@?[^\s()]*\s*\(\s*([^\s()]+)\s*\)$/.exec(text);
  if (labelled) return labelled[1];
  const login = text.replace(/^@/, "").toLowerCase();
  if (!login) return text;
  const chosen = people.filter(person => person.username?.toLowerCase() === login);
  if (chosen.length === 1) return chosen[0].id;
  const matches = people.filter(person => person.githubLogin?.toLowerCase() === login);
  return matches.length === 1 ? matches[0].id : text;
}

/** A JSON value with every string that is a known person's user ID written as "username(id)", for showing details. */
export function withUsernames(value: unknown, person: (id: string) => Person): unknown {
  if (typeof value === "string") return usernameWithId(person(value));
  if (Array.isArray(value)) return value.map(item => withUsernames(item, person));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withUsernames(item, person)]));
  return value;
}
