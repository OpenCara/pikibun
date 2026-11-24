# A task-completion eval for session instructions

The tests check that a session's instructions are built as intended. None checked whether an agent given them completes a
task. #343 proposes moving procedure into skills and deferring rarely used tools, each change judged by a small
end-to-end eval: about ten golden tasks, each run more than once against a real model, judged by the outcome and not by
the final message, with a report of which tasks flipped. This note is that eval, step 1 of #343. How to run it and read
its result is in [The task-completion eval](../task-eval.md).

## What it is

`scripts/eval.ts` (`pnpm eval`) starts a Pikibun server and a host for the run, in a temporary directory, and for each
task and each run: makes the task's fixture repositories, starts a new session, sends the task's message, waits until the
session settles or the task's time limit passes, and runs the task's check. It writes the runs as JSON and prints a
table; given an earlier result, the table says which tasks changed status.

- **The real session, not a model call.** A task runs through the server's API and a connector, as a person's message
  does: the instructions come from `agentInstructions`, the workspace's extensions (`piki:pr-flow`, `piki:gh`,
  `piki:github`, `piki:skills`) add theirs and their notes after tool calls, and the tools are the session's own. So a
  change to any of them shows in the result. The server is the ordinary one in test mode (`scripts/eval/stack.ts`, as
  `scripts/dev-native.ts` and `scripts/perf/session-load-server.ts` start it), which lets a test user start sessions in a
  workspace without sources; the connector runs in the eval's own process, with the model Pi is configured with on that
  computer.
- **A task is data** (`scripts/eval/tasks.ts`): an id, the fixtures, the workspace's extensions and their settings, the
  forge's state, the message, whether it is a Read-only message, a time limit, and a check that returns what is wrong
  (nothing means it passed). Adding a task is adding an entry.
- **The check looks at the outcome**: the clone's commits and working tree, the fixture remote's branches, what the
  forge was asked to do and the state it ended in, the tool calls the session made, and the fixture's own tests run
  again by the harness. The reply is checked only for what a person needs to be told (a link, an answer, a reason).

## Decisions

1. **It lives in `scripts/`, and a person runs it.** It needs a model, which CI's tests don't have, and it costs money, so
   it runs when someone changes the instructions: before the change and after it, with the two tables in the pull
   request. A scheduled session that runs it and reports can come later; nothing in the eval assumes a person.
2. **An unsandboxed host.** The eval's host runs sessions without a sandbox (`HostWorkspace`), for two reasons. A
   sandboxed session reaches repositories only through the egress proxy and a Git provider's account, so fixture
   repositories would need a forge the server can sign in to; and the eval should run inside a Pikibun session or a
   container, where bubblewrap can't nest. The cost is twofold. The model's commands run on the computer as the
   user, so the script refuses to start without `--unsafe-no-sandbox`, and the how-to says where to run it. And the
   instructions differ where they describe the sandbox: an unsandboxed session is told to clone and push with the host's
   Git (no session branch, no `git_push`), has no browser or tunnel paragraph, and is told nothing about programs the
   sandbox lacks. Everything else is the same text: the tools' paragraphs, code mode, `gh` before `github_read`, the
   skills list, the pull request flow's rule and skill, Read-only. A sandboxed mode is left for later (below).
3. **Fixtures are local bare repositories**, made for each run with fixed commit dates. Tasks that start from a clone
   are cloned into the session's worktree by the harness before the message (a Read-only message can't clone, and a
   repository's skills are listed only once it is cloned); the others are given the repository's `file://` address to
   clone.
4. **The forge is stubbed at the `gh` command.** On an unsandboxed host the `gh` tool runs the host's own `gh`, so the
   harness puts a stand-in first on the host's `PATH` (`scripts/eval/gh-stub.mjs`): it keeps pull requests in a file,
   answers `pr create`, `view`, `list`, `checks`, `ready`, `edit`, `comment`, `merge` and `run watch` as `gh` does, refuses
   a pull request for a branch that isn't pushed, moves `main` on a merge, and records every call. A task's scenario
   gives it reviews (a request for changes), checks that stay pending until they are watched, and pull requests that
   already exist. That is the boundary the pull request flow itself names for hosts without `git_push` (`gh pr create
   --draft`, `gh pr ready`, `gh pr merge`), and `piki:pr-flow` follows those calls and adds its notes, as it does on
   GitHub. Its pull requests are at `https://forge.eval.test/...`, not github.com: the `github_*` tools have no account
   to act with in the eval, so nothing should send the agent to them.
5. **Runs that didn't run aren't counted.** A run is `pass`, `fail`, `timeout` (the session was stopped at the time
   limit; counted as not passed) or `error` (the harness failed, or the model's turn ended in a provider error). Errors
   are left out of a task's count, so a rate limit doesn't read as a regression of the instructions.
6. **Flips are by status.** A task is `pass` when every counted run passed, `fail` when none did, `flaky` otherwise.
   Against an earlier result a task `regressed` or `improved` when its status moved, is `same` otherwise (with the
   counts when they differ), and can't be told when either side has only errors. `--fail-on-regression` makes that an
   exit status. With three runs a single flip between `pass` and `flaky` is weak evidence: run it again, or with more
   runs, before concluding.
7. **Calls from code mode count.** A session's view lists the calls the model made, not the calls a code mode script
   made for it. So a check that asks whether a tool was used (`callsOf`, `scripts/eval/run.ts`) also takes a `codemode`
   call whose script names `tools.<tool>` and matches what the check looks for, and the Read-only check reads the
   refusal in a script's result. What a script did to a repository or the forge shows in their state either way.
8. **Checks are strict where the instructions are plain.** The Read-only task fails on any call that was refused for
   being Read-only, since the instructions say such calls are refused; the checks task fails on a wait with
   `github_read`, a sleep, or more than three polls.

## The tasks

| Task | What it asks | What the check requires |
|---|---|---|
| `fix-failing-test` | Clone, fix the bug behind failing tests, commit | A commit on the fixture's history, the tests unchanged and passing when the harness runs them, nothing uncommitted |
| `run-tests-report` | Run the tests, say which fail, fix nothing | The node tool was used, the reply names both failing tests, the clone and remote are untouched |
| `question-changes-nothing` | A question about the code, in a workspace with the pull request flow | The right answer, no file changed, no commit, no pull request |
| `read-only-refusal` | A change asked in a Read-only message | Nothing changed, no acting call tried, the reply says it is Read-only |
| `skill-before-acting` | Add a changelog entry in a repository whose skill gives the format | The skill was read before the changelog was edited, the entry is in the skill's format, committed |
| `gh-waits-for-checks` | Wait for a pull request's checks, with `gh` and `github_read` both on | `gh pr checks --watch` or `gh run watch`; no `github_read` wait, no sleep, no polling |
| `pr-flow-to-merge` | A small change, with the flow set to merge without a review window | A draft pull request from a pushed branch, made ready, squash merged, `main` holding the change, the link in the reply |
| `pr-flow-requested-changes` | The same change; a reviewer requests changes the agent can't make | Draft, then ready, not merged nor queued to merge, `main` unmoved, the reply says why it is left open |
| `no-pull-request-on-request` | Push to a named branch, "no pull request, please" | The branch holds the fix, `main` unmoved, no pull request |
| `two-clones-two-pull-requests` | One rename across two repositories | One pull request in each, each through the flow, the rename complete and the tests passing on `main` |

## What it can't check

- **Anything of the sandbox**: the session branch and `git_push`, the egress proxy, the missing-programs paragraph
  ("say what the host's owner installs"), the browser and the tunnel. #343's candidate "say what the host's owner
  installs when a program is missing" is therefore not a task yet: an unsandboxed session is told nothing about missing
  programs. It needs a sandboxed mode: the harness would clone fixtures into the sandbox's worktree and check at the
  commit, the last step such a session controls without a forge.
- **GitHub itself**: `github_read`, `github_comment`, `github_merge` and the review window's `wait: "change"`. The flow
  is checked through `gh` on a stand-in forge. On that path `piki:pr-flow`'s notes after `gh pr ready` name `glab`, `az`
  and `github_read` for what `gh pr merge` and `gh pr checks` do there, because they recognise GitHub only by
  github.com; the eval leaves that text as it is and measures it.
- **Long work**: the tasks are minutes long, so compaction, restarts and sub-agents aren't exercised.

## Tests

`tests/eval-harness.test.ts` runs the harness in CI with a scripted model (`scripts/eval/scripted.ts`, Pi's faux
provider answering from a script): a passing task, a failing one, a check that throws, a time-out, a harness error, an
eval of several runs compared with an earlier result, and the report. It also runs every golden task twice: once with a
scripted session that does the task, which must pass, and once with one that only says it did, which must fail; and it
runs sessions that merge over a request for changes, skip the draft, wait with `github_read`, act in a Read-only message
and skip the skill, which must fail for those reasons. That shows the fixtures, the forge stand-in and the checks hold
together; it doesn't show how a model fares, which only a run with one does.
