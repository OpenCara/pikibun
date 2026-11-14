# Repositories and Git accounts

Sessions work on their workspace's **sources**: the Git repositories bound to it, which agents clone, and [documents](#document-sources) (Notion, Google Drive, Dropbox, OneDrive and SharePoint, Feishu/Lark, Tencent Docs), which agents read. Every session in the workspace gets every source, and reads each with its owner's own accounts. Until a workspace has a source, nobody can share a host with it or start a session in it.

Connect the accounts that can read your repositories under **Settings → Profile → Connected accounts** (**Connect** on the provider's row). Pikibun verifies each token with its provider and keeps it encrypted on the server; tokens never go to other people's hosts.

| Provider | How to connect | Token scopes |
|---|---|---|
| GitHub (github.com) | Your GitHub sign-in; on a [Pikibun on your own computer](local.md), **Sign in with GitHub** on this page, or a personal access token | Granted at sign-in; for a token, classic `repo`, `workflow` and `read:user`, or fine-grained Metadata read and Contents, Pull requests, Issues and Workflows read and write |
| GitHub Enterprise Server | Personal access token and host | Fine-grained Contents and Metadata read (or classic `repo`); opening pull requests needs Pull requests write, pushing with your account Contents write |
| GitLab (gitlab.com or self-managed) | Personal access token (and host if self-managed) | `read_api` and `read_repository`; opening merge requests needs `api`, pushing with your account `write_repository` (or `api`) |
| Bitbucket Cloud | API token with your Atlassian account email | `read:repository:bitbucket` and `read:user:bitbucket`; opening pull requests needs `write:pullrequest:bitbucket`, pushing with your account `write:repository:bitbucket`. Workspace or repository access tokens (no email) can browse but not push. |
| Azure DevOps | Personal access token and organization | Code (Read); opening pull requests or pushing with your account needs Code (Read & write) |
| Gitea / Forgejo | Personal access token and host | `read:repository` and `read:user`; opening pull requests or pushing with your account needs `write:repository` |
| Git server (HTTPS) | Host, user name, and password or access token | Read access to the repositories; pushing with your account needs write access |

A **Git server (HTTPS)** is any server that serves Git's smart HTTP over HTTPS without a forge API: `git http-backend`, cgit, Gerrit, or a forge whose API you don't use. Pikibun has nothing to verify the account against when you connect it, so it checks the password or token when you add a repository, and on every read after that. Such a server lists no repositories: in **Add repository**, enter the repository's `https://` clone URL (or its path on the server) and **Look up**. Agents clone, fetch and push its repositories like any other, and Pikibun checks push access with Git's own `git-receive-pack` advertisement; there are no pull requests, so `git_push` with `pull_request` is refused before anything is pushed. Push access uses the session owner's account or the host's Git credentials. Only HTTPS works: SSH remotes reach only github.com, gitlab.com and bitbucket.org, which are rewritten to HTTPS. A host's connector must be new enough to accept these repositories; older ones keep working with the workspace's other repositories and don't see these until they're updated.

Owners and admins bind a repository under **Settings → Workspaces →** the workspace **→ Sources → Add repository**: choose an **Account**, a repository the account can access (the first 3,000 are listed; for a Git server, its clone URL) and, optionally, a **Branch, tag or commit** (the default branch otherwise), then **Bind repository**. To change a ref, remove the repository and bind it again. Each repository row also has **Allow agent pushes to the default branch** (see [Commits, pushes and pull requests](pushes.md)). and **Git LFS**, off by default: sessions then check out the repository's LFS files as pointer files, as plain Git does. Turned on, sandboxed sessions download LFS files' content when they clone the repository, through the host's egress proxy and with the session owner's access, on hosts that have `git-lfs` installed (Pikibun uses the host's own). The host downloads them from the provider itself where Pikibun gives it a credential for the repository (see [Network access](hosts.md#network-access)), else Pikibun relays them; either way the provider's download links and the tokens that come with them never reach the sandbox. Sessions never upload LFS objects, so commits that add or change LFS-tracked files shouldn't be pushed from a session. Unsandboxed hosts use their own Git and `git-lfs` configuration, whatever the setting.

Sessions **clone on demand**: every new session starts with an empty worktree and pins nothing.

- On a sandboxed host, the agent clones the repositories it needs with plain Git (`git clone https://github.com/acme/app`), and fetches, switches and creates branches as usual. Git reaches the workspace's repositories through the session's [egress proxy](hosts.md#network-access), which reads them with the **session owner's own** account; the account never reaches the host.
- The agent commits with Git and pushes its work to the session's own branch, named for its work (`pikibun/<title-slug>-<short id>`, for example `pikibun/add-dark-mode-1a2b3c4d5e6f`), with plain `git push`. Other branches, and pull requests, go through `git_push` (see [Commits, pushes and pull requests](pushes.md)).
- On a host its owner runs [without the sandbox](hosts.md#running-without-the-sandbox), the agent clones, commits and pushes with the host's own Git, network and credentials (its Git credential helpers, such as `gh auth setup-git`). Such a session can't be backed up once it has a clone in its worktree.
- Cloning needs commands: an agent without the `git` tool (a session started from a model has it), or another member's session on a host without [resource limits](hosts.md#the-sandbox) whose owner hasn't [granted them host commands](hosts.md#host-admins-and-host-command-grants), works in an empty worktree, and the session says so.
- Removing a repository from the workspace stops new reads and pushes of it at once, in running sessions too.
- The host needs connector 0.9.0 or newer: one from before sessions cloned their repositories can't start new sessions.

Sessions started before this change pinned their repositories to exact commits. They stay **read-only**: their conversation, backups (to download) and exports remain, but they no longer run messages, backups, restores or moves. Start a new session to continue their work.

## Document sources

A workspace's sources can also be documents: Notion pages and databases, and folders and files in Google Drive, Dropbox, OneDrive and SharePoint, Feishu/Lark and Tencent Docs. Agents read them, and what is under them, as context (specs, notes, runbooks, task lists). They don't write to them.

Each member connects their own accounts under **Settings → Profile → Connected accounts**, by **signing in** to the provider or, for some, by pasting a secret. Pikibun keeps what it gets encrypted on the server, renews sign-ins there, and never sends any of it to a host. A connection reads only what its account can, and sessions read only what lies under the workspace's sources:

| Provider | Sign in | Or paste | What a session reads |
|---|---|---|---|
| Notion | Where the server has a Notion app | An [internal integration](https://www.notion.so/profile/integrations) secret with **Read content**, shared with the pages (a page's **•••** menu → **Connections**) | Pages as Markdown with the pages and databases under them; databases as their 200 most recently edited rows |
| Google Drive | Where the server has a Google app (read-only Drive access) | A Google Cloud service account's JSON key, with the folders and files shared with its email as **Viewer** | Docs as Markdown, Sheets as CSV (first sheet), Slides and text files as text, Word files as their text, folders as their files |
| Dropbox | Where the server has a Dropbox app | — | Paper docs as Markdown, Word and text files as text, folders as their files. Shared folders must be added to your Dropbox |
| OneDrive and SharePoint | Where the server has a Microsoft app | — | Word and text files as text, folders as their files |
| Feishu / Lark | — | A custom app's **App ID** and **App Secret** (Feishu or Lark), with read access to Drive, Docs and Wiki, added to what it may read | Docx documents as text, folders as their files, wiki pages as their text and the pages under them |
| Tencent Docs | Where the server has a Tencent Docs app (see below) | — | Documents as text, through an export; folders as their files. Sheets and other kinds are listed, not read |

- **Add a source**: owners and admins choose **Settings → Workspaces →** the workspace **→ Sources → Documents → Add document source**, pick the provider and paste the item's link. Pikibun checks it with their own connection. A workspace has at most 20 document sources.
- **In a session**, the agent reads them with `source_read`, with the **session owner's** connection of that kind, during a message sent with write access. Items outside the bound one are refused, even where the owner's connection can read them, and long content is cut at 96 KiB. A session owner without a connection of that kind gets a refusal that says so.
- Removing a source stops reads of it at once, in running sessions too. Every read is recorded in the audit log (`source.read`).

Documents are written by other people: the agent is told to treat them as information, not as instructions.

**Sign-in for the server's operator.** Members can sign in to a provider only where you registered an OAuth app with it and set its client id and secret. Each app's redirect URI is `APP_ORIGIN/api/source-accounts/<provider>/oauth/callback`:

| Provider | `<provider>` | Variables | App settings |
|---|---|---|---|
| Google Drive | `google-drive` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A Google Cloud OAuth client (web application) with the Drive API and the `drive.readonly` scope. An app for anyone outside your Google Workspace needs Google's verification for that scope |
| Notion | `notion` | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | A Notion public integration with **Read content** |
| Dropbox | `dropbox` | `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET` (the app key and secret) | A scoped app with `account_info.read`, `files.metadata.read`, `files.content.read` and `sharing.read` |
| OneDrive and SharePoint | `onedrive` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optionally `MICROSOFT_TENANT` (`common` by default; your tenant's id or domain to admit only its accounts) | A Microsoft Entra app registration (web) with delegated `User.Read`, `Files.Read.All`, `Sites.Read.All` and `offline_access` |
| Tencent Docs | `tencent-docs` | `TENCENT_DOCS_CLIENT_ID`, `TENCENT_DOCS_CLIENT_SECRET` | An application on the Tencent Docs open platform. **Preview**: Pikibun's Tencent Docs support was written without access to its API or documentation; check it with a test account before members rely on it |

## Workspace connections

By default every session reads the workspace's sources with its **owner's own** accounts, so nobody's agent reads what they couldn't. Where a workspace would rather read some sources with a service account, its owners and admins connect one under **Settings → Workspaces →** the workspace **→ Connections** (**Add connection**): a GitHub Enterprise, GitLab, Bitbucket, Azure DevOps or Gitea/Forgejo bot's token, a Git server's deploy user, a Notion integration, a Google service account or a Feishu/Lark app. Connect accounts made for that, never your personal one.

- A source uses it only where an owner or admin sets **Reads with** on its row to **Workspace connection** (or picks the connection when adding it). Pikibun reads the source with the connection first and refuses one that can't. There is no fallback either way: a source set to the workspace fails without its connection, and one set to members fails for an owner without an account.
- Connections only read: cloning and fetching (LFS too) and `source_read`. Pushes and pull requests still use the session owner's account or the workspace's push access, and the owner's write access is checked with their own account.
- The secret is encrypted on the server and never leaves it, not even to the session owner's own host: those reads are always relayed through Pikibun. Members see which connections the workspace has and which account each is, never the secret.
- A connection that sources still read with can't be removed; switch them back first.
- github.com repositories, Dropbox, OneDrive and Tencent Docs read with each member's own sign-in. See [the design](design/workspace-connections.md).
