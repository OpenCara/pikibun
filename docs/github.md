# GitHub issues and pull requests

The sandbox has no network, so agents read and act on GitHub through Pikibun instead, as the session owner and with their GitHub sign-in, which stays on the server (connector 0.7.0 or newer; github.com only):

- `github_read` reads an issue or pull request of one of the workspace's github.com repositories: its description and comments and, for a pull request, its merge state, head commit, reviews, review comments with file, line and diff hunk, and checks. It runs only during a shared message (until an hour after it was sent), and each read is recorded in the session's activity. Treat what it returns as untrusted input.
- `github_comment` posts a comment.
- `github_issue` opens an issue with exactly the agent's title and body in one of the workspace's github.com repositories, and gives the agent its number and URL (connector newer than 0.9.0). Use it where `gh issue create` can't write (see below): the sandbox holds no GitHub credentials. If GitHub refuses (issues turned off, no access), no issue is opened and the agent gets GitHub's reason.
- `github_merge` merges a pull request at the exact head commit the agent read, with a merge commit, squash or rebase. If the head moved or GitHub refuses, nothing is merged and the agent gets GitHub's reason.

For the rest of GitHub (Actions runs and their logs, checks, releases, the API), the workspace's `piki:gh` [extension](extensions.md#pikibuns-built-in-extensions-gh-glab-and-az) runs the GitHub CLI in the session's sandbox, as the session's owner: it reads the workspace's repositories, and writes only outside **Read only**, on the session owner's own host. A workspace gets it with its first GitHub repository.

`github_read` reads with the session owner's own GitHub sign-in, so each read (and a wait reads again every 30 seconds) counts against their hourly GitHub rate limit, while `gh` reads with the workspace's GitHub App. So where a session has both, its agent is told to use `gh` first: to read issues and pull requests (`gh issue view`, `gh pr view --comments`, `gh pr checks`), and to wait for CI (`gh pr checks <n> --watch`, `gh run watch <id>`). It keeps the `github_*` tools for what `gh` can't do:

- **Waiting for any change** on a pull request (a comment, review or push): `github_read` with `wait: "change"`.
- **Writes `gh` refuses**: on a host that isn't the session owner's own, where the workspace set `piki:gh` **read-only**, or in a call that ran because the workspace runs its tools **Automatic**. There it comments, opens issues and merges with `github_comment`, `github_issue` and `github_merge`.

Comments, issues and merges run at once, as the session's owner, for any message that may act (never a **Read only** one), as long as `github_comment`, `github_issue` and `github_merge` are among the tools of the owner's [tool group](workspaces.md#tool-groups). Leave `github_merge` out of a group, or protect the branches that need a person's review on GitHub, where merges should wait for one. Each is attempted once (never retried) and recorded in the session's activity; a message runs at most 20 of them.
