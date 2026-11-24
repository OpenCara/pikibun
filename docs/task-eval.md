# The task-completion eval

A small end-to-end eval of what sessions are told: ten tasks a session should complete, each run several times in a real
session with a real model, each judged by its outcome. Run it before and after a change to the instructions (the
runner's `agentInstructions`, an extension's prompt or skill, a tool's description), and put both tables in the pull
request. Why it is built this way is in [the design note](design/task-eval.md).

## Before you run it

- **It runs the model's commands on your computer, without a sandbox, as your user.** The eval's host is an unsandboxed
  one. Run it in a container, a virtual machine or a Pikibun session, not beside data you care about. It refuses to
  start without `--unsafe-no-sandbox`.
- **It needs a model Pi is configured with on that computer** (`~/.pi/agent`, or `--pi-agent-dir`), named as Pi names
  it: `anthropic/<model>`, `openai/<model>`. A full run is thirty sessions of a few minutes each, and costs what those cost.
- Linux or macOS, with Git and the repository installed (`pnpm install`). It uses no network but the model's, and no
  GitHub: repositories are local fixtures and the forge is a stand-in for `gh`.

## Running it

```sh
pnpm eval --dry-run --unsafe-no-sandbox --runs 1
pnpm eval --model anthropic/<model> --unsafe-no-sandbox --label before
pnpm eval --model anthropic/<model> --unsafe-no-sandbox --label after --compare eval-results/<the first result>.json
```

The first line asks no model: a stand-in answers every message without doing anything, so every task fails. It shows in
under a minute that the eval starts and reports on this computer. The second runs every task three times and writes
`eval-results/<time>-<model>.json` (the directory is ignored by Git). The third does the same after your change and
compares.

| Option | |
|---|---|
| `--runs N` | Runs of each task, 3 by default. More runs tell a flaky task from a broken one |
| `--task ID` | Only this task (repeatable). `--list` names them |
| `--thinking LEVEL` | The reasoning level of every message; otherwise the model's default in Pi |
| `--compare FILE` | An earlier result to compare with |
| `--fail-on-regression` | With `--compare`, exit with status 2 when a task regressed |
| `--out FILE`, `--label TEXT` | Where the result goes, and a note kept in it |
| `--timeout-scale X` | Multiply every task's time limit, for a slow model |
| `--keep` | Keep the temporary directory: the sessions' worktrees, the fixture repositories and the forge's record |
| `--report FILE` | Print a result's table again, with `--compare` against another, without running anything |

Compare like with like: the same model, reasoning level and number of runs, and one change at a time.

## Reading the result

The table looks like this (two rows, with made-up numbers):

```
| Task | Passes | Time | Tokens in / out | Cost | Against the earlier result |
|---|---|---|---|---|---|
| read-only-refusal | 3/3 pass | 9s | 12.4k / 85 | $0.041 | same |
| pr-flow-requested-changes | 1/3 flaky | 141s | 310.2k / 2.1k | $1.20 | **regressed** (pass 3/3 → flaky 1/3) |
```

- **Passes** counts runs whose check found nothing wrong, among the runs that ran. A task is `pass` when all did,
  `fail` when none did, `flaky` otherwise. A run that timed out counts as not passed. A run that ended in an error (the
  provider failed, the harness failed) is not counted, and the row says how many weren't.
- **Time** is the median run; **tokens** are the mean of a run's prompt tokens (cached ones included) and output tokens;
  **cost** is the sum over the task's runs, as Pi prices the model. A dash means the host didn't report it.
- **Against the earlier result** is the flip: `regressed` or `improved` when the status moved, `same` otherwise, with
  the counts when they differ. Below the table, one line lists the tasks that regressed and improved.
- **Runs that did not pass** lists each with what its check found, such as "app's pull request was merged over
  CHANGES_REQUESTED". Read these before the score: they say what the session did.
- **Smallest context** is the context size at the end of the shortest run: an upper bound on what the instructions and
  tool definitions take.

A flip in one run of three is weak evidence. Run the task again (`--task ID --runs 6`) before deciding that a change
helped or hurt. To see what a session did, run with `--keep` and look in the temporary directory:
`host/runner/sessions/<id>/sandbox/worktree` is its worktree, `runs/<task>-<run>-…/remotes` holds the repositories it
pushed to, and `forge/calls.jsonl` the `gh` calls of the last run.

## What the tasks are

`pnpm eval --list` names them, and [the design note](design/task-eval.md#the-tasks) says what each asks and what its
check requires. They cover fixing a failing test, reporting test results, answering without changing anything, a
Read-only message, reading a repository's skill before acting, waiting for checks with `gh`, and the pull request flow:
through to a merge, stopping at a request for changes, skipped when the person asks, and across two repositories.

It doesn't cover what only a sandboxed host or GitHub itself has: the session branch and `git_push`, the
missing-programs advice, `github_read` and the review window's wait. The design note lists these.

## Adding a task

A task is an entry in `scripts/eval/tasks.ts`: its fixtures (files of a repository), the workspace's extensions, the
forge's state, the message, a time limit and a check that returns what is wrong. Give `tests/eval-harness.test.ts` a
scripted session that does the task: the test then holds that it passes, and that a session which only claims to have
done it fails. Keep the set near ten: a few tasks that each tell something beat many that agree.
