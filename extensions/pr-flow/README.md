# Pull request flow, a Pi extension

Has the agent carry each change to a repository through a pull request (a merge request on GitLab), from the first edit
to the merge:

1. **A draft at the first change.** As soon as the session starts changing files in a clone, it commits, pushes to the
   session's branch and opens a draft pull request.
2. **Ready for review once done.** When the change is complete and its tests pass, it marks the draft ready for review.
3. **A review window.** It waits up to `review-minutes` for reviews. It fixes the review points it judges valid, pushes,
   and answers each point (with why, for one it judges invalid). Each pushed fix starts the window again, for a
   re-review. It merges once the pull request is approved with nothing left to address, or once the window ends with
   nothing new to address; never over a reviewer's request for changes it didn't make, which it leaves to the people.
4. **`review-minutes` of 0 merges at once** (or, with `auto-merge` off, hands it over), as soon as the pull request is
   ready, without waiting for reviews.
5. **`auto-merge` off leaves the merge to people.** The agent still works the review window, but where it would merge
   it tells the person the pull request is ready for them to merge, and leaves it open.

It registers no tool: the agent does each step with its own tools, each approved as it always is (in Pikibun:
`git`, `git_push` with `pull_request.draft`, `github_read` with `wait`, `github_comment`, `github_merge`; elsewhere the
forge's CLI). It adds the flow to the system prompt of each message (`before_agent_start`), and a note to a tool's
result where a step is due (`tool_result`): the first change in a clone without a pull request, a draft opened, a pull
request made ready (with the time its review window ends), a push after that, a merge.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `review-minutes` | `30` | How long to wait for reviews once the pull request is ready, and again after each pushed fix, in minutes (up to a week). `0` merges it as soon as it is ready (with `auto-merge` off, hands it over) |
| `merge-method` | `squash` | `squash`, `merge` or `rebase`; unused with `auto-merge` off |
| `wait-for-checks` | on | Let the pull request's checks finish, and fix failing ones, before merging. Turn it off with a `review-minutes` of 0 to merge the moment it is ready |
| `auto-merge` | on | Merge once approved, or once the review window ends with nothing left to address. Off, the agent never merges (nor queues an automatic merge) unless the person asks: it tells them the pull request is ready for them to merge |

## In Pikibun

Every connector has it built in as `piki:pr-flow`, at the connector's version. A workspace's owners and admins add it
under **Settings → Workspaces →** the workspace **→ Extensions → Add extension → Workflows**, then set its settings
with **Edit**. See [the design](../../docs/design/piki-extensions.md#the-pull-request-flow-pikipr-flow).

## In Pi

```bash
pi install npm:@pikibun/pi-pr-flow   # from npm
pi install ./extensions/pr-flow      # from a clone of this repository
pi -e ./extensions/pr-flow           # or for one run only
```

Its settings are Pi flags (`--review-minutes 60`). Pi's own tools don't include Pikibun's `git_push`, so there the
agent opens, readies and merges with the forge's CLI (`gh pr create --draft`, `gh pr ready`, `gh pr merge`).
