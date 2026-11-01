# Workspace connections

Sessions read a workspace's sources with their owner's own accounts: a member who can't open a repository or a
document can't have an agent open it either. That keeps access exact, but every member has to connect every provider,
and many document connections are service identities anyway (a Notion integration, a Google service account, a
Feishu/Lark app), as is a Git server's deploy user.

A **workspace connection** is such a service identity, connected by a workspace owner or admin for the workspace
itself. A source reads with it only where an owner or admin set it to.

## What it is

- `workspace_connections`: per workspace, one per Git provider, host and Azure DevOps organization (GitHub Enterprise
  Server, GitLab, Bitbucket Cloud, Azure DevOps, Gitea/Forgejo, Git servers), and one per pasted-secret document provider
  (Notion, Google Drive, Feishu/Lark). It is verified with the provider like a member's own account (Git servers: when a
  repository is first read). The secret is vault-encrypted with `workspace-connection:<id>` as associated data, so it
  decrypts only as that connection. Reconnecting replaces it in place and keeps the id. At most 20 per workspace.
- `source_read_settings`: per source, `read_as` is `members` (no row: each session owner's own account, as before) or
  `workspace`. Sources are immutable, so this lives beside them, like a repository's push policy and Git LFS switch.

Not covered: github.com, whose reads use each member's GitHub sign-in (a workspace read identity there would be the
GitHub App's, through `mintRepositoryReadToken`), and the sign-in document providers (Dropbox, OneDrive, Tencent Docs),
where "the workspace's account" would be whoever signed in.

## Rules

1. **Opt-in per source, never a fallback.** A source reads with exactly the identity its setting names. A missing
   connection, or a session owner without an account, fails with its own error (`workspace_connection_required`,
   `git_account_required`, `source_account_required`); neither falls back to the other.
2. **Checked when chosen.** Setting a source to `workspace` reads it with the connection first (the repository's metadata,
   or the document item), and adding a source with `readAs: workspace` checks it with the connection instead of the
   admin's own account, in the same write as the setting.
3. **Reads only.** The Git relay (info/refs, upload-pack, LFS) and `source_read` honour the setting. Pushes (the session
   branch, `git_push`), pull requests and the GitHub API access sessions get through the egress proxy keep using the session
   owner's account or the workspace's push access, and the owner's write permission is still checked with the owner's
   account.
4. **Never on a host.** A workspace connection stays on the control plane: direct Git grants refuse it on every host,
   the session owner's own included, so its reads are relayed.
5. **Visible, not readable.** Every member sees the workspace's connections (provider, host, the account's name, how many
   sources read with them), never their secrets. Only owners and admins add, replace or remove one, and one that sources
   still read with can't be removed: they are switched back first, on purpose.
6. **Audited.** `workspace.connection.connected` and `.removed`, `workspace.source.read_as`, and `source.read` records
   `readAs`.

## Where it is

- Server: `apps/server/src/workspace-connections.ts` (routes, `repositoryReadAccess`, `workspaceGitAccess`,
  `workspaceDocumentAccount`); `network.ts` picks the read identity in `gitAuthority`; `sources.ts` in `sourceRead`.
  A connection's Git credential is a `LoadedCredential` with `workspaceId`, rechecked against its own row.
- Migrations: SQLite `0042_workspace_connections.sql`, Postgres `0035_workspace_connections.sql`.
- Web: Settings → Workspaces → the workspace → **Connections**, and **Reads with** on each repository and document row
  of **Sources**; the repository picker and **Add document source** offer the workspace's connections.
