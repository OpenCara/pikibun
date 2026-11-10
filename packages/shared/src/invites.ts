export interface WorkspaceInviteLink {
  url: string;
  createdAt: string;
}

export type WorkspaceInviteStatus = "none" | "pending" | "member";

export interface WorkspaceInvite {
  workspaceName: string;
  status: WorkspaceInviteStatus;
  workspaceId?: string;
}

export interface WorkspaceJoinRequest {
  userId: string;
  displayName: string;
  username: string | null;
  githubLogin: string | null;
  createdAt: string;
}

export interface OwnJoinRequest {
  workspaceId: string;
  workspaceName: string;
  createdAt: string;
}

export const maxPendingMembers = 200;
