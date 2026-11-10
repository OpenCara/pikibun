import type { WorkspaceRole } from "../../shared/src/types";

export interface Person {
  id: string;
  username?: string | null;
  githubLogin?: string | null;
  role?: WorkspaceRole;
}

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

function handle(person: Person): string | null {
  return person.username || person.githubLogin || null;
}

export function username(person: Person): string {
  return handle(person) || person.id;
}

export function usernameWithId(person: Person): string {
  const name = handle(person);
  return name ? `${name}(${person.id})` : person.id;
}

export function peopleDirectory(people: readonly Person[]): (id: string) => Person {
  const byId = new Map(people.map(person => [person.id, person]));
  return id => byId.get(id) ?? { id };
}

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

export function withUsernames(value: unknown, person: (id: string) => Person): unknown {
  if (typeof value === "string") return usernameWithId(person(value));
  if (Array.isArray(value)) return value.map(item => withUsernames(item, person));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withUsernames(item, person)]));
  return value;
}
