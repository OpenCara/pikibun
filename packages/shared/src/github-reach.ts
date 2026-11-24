export interface GitHubReachSettings {
  anyRepository: boolean;
}

export const defaultGitHubReach: GitHubReachSettings = Object.freeze({ anyRepository: true });

export const githubReachLocation = "Settings → Workspaces → Agents → Your GitHub reach";

export function outsideRepositoryHint(name: string): string {
  return `${name} is not a github.com repository of this workspace. Only the session owner's own messages act on other GitHub repositories they can access, and only while they leave that on (${githubReachLocation}); otherwise add it to the workspace.`;
}
