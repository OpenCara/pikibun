# Models and tools

You can use the models of your own hosts and of hosts shared with the workspace, except those the host's owner or an admin [disabled](hosts.md#models). A session starts from a host and one of its models, and its agent gets every tool that host supports, with no extra instructions. The access you choose for each message (see [Chat options](sessions.md#chat-options)) decides what runs without asking.

The tools an agent can use:

| Tool | What it does | Needs |
|---|---|---|
| `identity` | Tells the agent the session owner's identity and `APP_` environment | Nothing |
| `list_files`, `read_file` | List and read session files; images (PNG, JPEG, GIF, WebP) go to the model as images. `read_file` with `offset` and `limit` reads only those lines of a text file | Nothing |
| `search` | Search the worktree's text files for a regular expression or literal text, like `grep -rn`: narrowed by `path` and `glob`, with up to 5 lines of `context` and up to 500 results. It never follows links, skips `.git` directories as it walks (a `path` inside `.git` reads it, as `read_file` can), skips `node_modules` unless `all` is set, and skips binary files and files over 1 MB | Nothing |
| `write_file`, `edit_file` | Write a whole file, or replace exact text in place | Permission in **Read only** messages |
| `bash` | Run a shell command in the sandbox | Approval |
| `git` | Run Git in the sandbox without a shell: its arguments as a list (`["commit", "-m", "Fix it"]`) and the clone's `directory`. Only version-control subcommands (clone, status, diff, log, commit, switch, fetch, merge, rebase, push, ...), and none of the options that run another program (`rebase --exec`, `clone --upload-pack` or `--config`, `--template`, Git's own `-c` and `-C`). Its card shows the exact Git command; a workspace turns it off by turning off [`piki:git`](extensions.md#session-tools-pikischedule-pikihost-shell-and-pikigit) | Approval, as for `bash` |
| `git_push` | Push a clone's checked-out commit to a branch, optionally opening a pull request, or tag a commit already on a branch | Approval |
| `github_read` | Read a GitHub issue or pull request | Nothing, during a shared message |
| `github_comment` | Comment on a GitHub issue or pull request | Approval |
| `github_merge` | Merge a GitHub pull request | Approval |
| `github_issue` | Open a GitHub issue | Approval |
| `source_read` | Read an item of one of the workspace's [document sources](repositories.md#document-sources), with the session owner's connection | Nothing, during a shared message |
| `schedule` | List, create, change or delete the session's [scheduled prompts](sessions.md#scheduled-prompts); a workspace turns it off by turning off [`piki:schedule`](extensions.md#session-tools-pikischedule-pikihost-shell-and-pikigit) | A message from the session owner; Auto-approve for auto-approved schedules |
| `sessions` | List, read, message, start, stop and archive the workspace's other sessions, as the message's sender (see [Working across sessions](sessions.md#working-across-sessions)) | A shared message; permission in **Read only** messages for changes, and to pass content between sessions whose readers differ |
| `host_bash` | Run a command on the host, outside the sandbox; a workspace turns it off by turning off [`piki:host-shell`](extensions.md#session-tools-pikischedule-pikihost-shell-and-pikigit) | The approval of the host owner, or of a member they [granted host commands](hosts.md#host-admins-and-host-command-grants) |
| Extension tools | Whatever the workspace's [extensions](extensions.md) offer, run on the host outside the sandbox | Decided like `host_bash`, unless the workspace runs the extension's tools automatically and the host's owner allows that |

"Approval" is skipped for messages the session owner sends with **Auto-approve**: always for commands, pushes, GitHub comments, merges and issues, and for `host_bash` only on the owner's own host or one whose owner granted them automatic host commands. Side asks offer only the read-only tools.

Sessions started from a saved agent, before agents were removed, keep that agent's instructions and tools; any other tool they call first asks the session owner with a [permission request](approvals.md#permission-requests).
