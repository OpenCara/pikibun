export interface AdminOverview {
  users: number;
  suspendedUsers: number;
  workspaces: number;
  hosts: number;
  onlineHosts: number;
  sessions: number;
  activeSessions: number;
}

export interface AdminUser {
  id: string;
  githubLogin: string | null;
  displayName: string;
  createdAt: string;
  instanceAdmin: boolean;
  suspendedAt: string | null;
  workspaces: number;
  hosts: number;
  sessions: number;
}

export interface AdminWorkspace {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerGithubLogin: string | null;
  createdAt: string;
  members: number;
  repositories: number;
  hosts: number;
  sessions: number;
}

export interface AdminHost {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerGithubLogin: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  online: boolean;
  workspaces: number;
  sessions: number;
}

export interface AdminList<T> {
  items: T[];
  truncated: boolean;
}

export const adminListLimit = 1000;
