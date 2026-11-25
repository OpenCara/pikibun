// The working directory a session's owner chose on its host, for a session that runs directly on the host (hostEnvironment).
// It stands in for the private, empty worktree such a session starts with otherwise: an absolute path on the host, or one
// under its user's home (~, ~/...). The host checks it exists when the session opens (apps/runner/src/host-workspace.ts).
export const HOST_DIRECTORY_MAX_LENGTH = 1024;

export function validHostDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= HOST_DIRECTORY_MAX_LENGTH && value === value.trim()
    && !/[\x00-\x1f\x7f]/.test(value)
    && (value.startsWith("/") || /^~(?:[\\/]|$)/.test(value) || /^[A-Za-z]:[\\/]/.test(value));
}

export const hostDirectoryRule = "an absolute path on the host (/..., or C:\\... on Windows), or one in its user's home (~ or ~/...)";
