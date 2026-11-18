export interface GitHubReachSettings {
  anyRepository: boolean;
}

export const githubReachLocation = "Settings → Workspaces → Your GitHub reach";

export function outsideRepositoryHint(name: string): string {
  return `${name} is not a github.com repository of this workspace. The session owner can let their own messages act on any GitHub repository they can access (${githubReachLocation}), or add it to the workspace.`;
}
