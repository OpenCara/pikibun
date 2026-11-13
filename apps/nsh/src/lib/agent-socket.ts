const SESSION_LOOKUP: Record<string, string> = {
  macos: "launchctl getenv SSH_AUTH_SOCK 2>/dev/null",
  linux: "systemctl --user show-environment 2>/dev/null | sed -n 's/^SSH_AUTH_SOCK=//p'",
};

export function agentSocketImport(os: string): string {
  const lookup = SESSION_LOOKUP[os];
  if (!lookup) return "";
  return `[ -n "$SSH_AUTH_SOCK" ] || SSH_AUTH_SOCK=$(${lookup}); `
    + `case "$SSH_AUTH_SOCK" in /*) export SSH_AUTH_SOCK ;; *) unset SSH_AUTH_SOCK ;; esac; `;
}
