// A shared Pikibun's administrators as the owner typed them: user IDs as they are, and GitHub logins turned into the
// user IDs the server lists (`github:` and the account's numeric ID, which https://api.github.com/users/<login> shows
// as `id`). Pure but for `lookup`, so tests run it without the network.

export type GitHubLookup = (login: string) => Promise<number | undefined>;

export async function resolveAdmins(entries: readonly string[], lookup: GitHubLookup): Promise<{ ok: true; admins: string[] } | { ok: false; error: string }> {
  const admins: string[] = [];
  for (const entry of entries) {
    if (/^(?:github|password):/.test(entry)) { admins.push(entry); continue; }
    const login = entry.replace(/^@/, "");
    let id: number | undefined;
    try { id = await lookup(login); } catch { return { ok: false, error: `GitHub could not be asked for ${login}'s user ID. Check your connection, or enter it as github:12345.` }; }
    if (!id || !Number.isSafeInteger(id) || id < 1) return { ok: false, error: `GitHub has no account ${login}.` };
    admins.push(`github:${id}`);
  }
  return { ok: true, admins: [...new Set(admins)] };
}

/** Looks a login up on GitHub's public API with `fetch` (Electron's net.fetch in the app). */
export function githubLookup(fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>): GitHubLookup {
  return async login => {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { accept: "application/vnd.github+json", "user-agent": "Pikibun-Desktop" } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const body = await response.json() as { id?: unknown; type?: unknown };
    return typeof body.id === "number" && body.type !== "Organization" ? body.id : undefined;
  };
}
