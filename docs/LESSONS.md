# Lessons from recent sessions

This file is maintained by a daily scheduled session, which distils lessons from the workspace's recent sessions. It is not loaded into new sessions automatically: read it at the start of a task. For the commands and layout, see [development.md](development.md).

## Words and architecture

- Say "Pikibun server" or "host", never just "server": people ask which one is meant.
- Hosts send the whole transcript; redaction and brief mode run on the Pikibun server, redaction first. Anything derived from a tool result there must be built from the redacted text.
- Hosts update their connectors slowly. Keep on the host only what nothing else can recover, and put logic that changes often in the Pikibun server or the client.
- When a feature needs a new connector as well as a new server, keep older hosts working (a fallback, or a refusal before anything is created) and tell the person that hosts must update to get it.
- Code that the server and the client both need goes in `packages/shared`.
- `apps/nsh` is the only client. The Electron, React and Expo apps are gone, so check that a file still exists before citing or editing it.
- A rendering or runtime bug in the client may be in NSH (Native Shell) itself. Check its source before changing ours; if it is upstream, add a small workaround and a tracking issue for removing it.

## Building and testing

- For one test, run `node --import tsx --test --test-name-pattern "<words>" tests/<file>.test.ts` instead of the whole suite.
- The network-proxy tests fail when the temporary directory's path is too long for their sockets, or when there is no usable temporary directory. Run them with a short `TMPDIR` before treating that as a regression. In the Linux sandbox, `TMPDIR` is `/tmp` (the session's `~/.tmp`) on connectors from #264 on; older ones give the long `~/.tmp` and no `/tmp`. `/tmp` is a symlink there, so don't `realpath` a temporary directory you will put sockets in: that gives the long path back.
- Tests that start a Linux sandbox skip themselves where bubblewrap can't make one (`linuxSandboxMissing()` in `tests/helpers/workspaces.ts`), as inside a session's own sandbox. Gate new ones on that probe, not on `bwrap --version`.
- A sandbox may not reach the npm registry. If dependencies can't be installed, say so in the pull request and treat its CI as the only typecheck and full test run.
- `node --check` finds syntax errors only. A duplicate declaration or a type error shows up first in CI's typecheck, so reread new code for names already used in the same block.
- To show that a new test covers a fix, run it once with the fix removed and see it fail.
- Chromium needs `--no-sandbox` inside a session's sandbox. Python Playwright downloads its own browser unless it is given the system Chromium's path.
- The node tool can't set environment variables. When a script needs one, start it from Python with the variable set.
- When a clone fails, the repository can still be read through `gh api` (trees and raw file contents). This also works for public repositories outside the workspace, which git can't reach.

## CI and logs

- Wait for CI with `gh pr checks <n> --watch` and a long timeout. If the watch stops on a proxy or authentication error, that is not a failed check: poll the run's status from a codemode script that prints only the result, at most once a minute. Every read counts against GitHub rate limits that all of the owner's sessions share, and `gh run watch` on its own reads every 3 seconds (the gh tool makes it 30).
- A check may not be registered right after a push. Find the run with `gh run list` and watch that.
- Long tool output is cut, and `gh run view --log-failed` can end before the failure. Filter the log for the failing lines in a codemode script, or fetch the job's log through `gh api`.
- GitHub runs no pull request checks on a branch that conflicts with `main`. Merge `main` in and resolve the conflicts first.
- The browser driver test and the web smoke test fail now and then on CI. Before blaming your change, see whether the same commit passed in another run, and say in your reply that the failure was intermittent.

## Pull requests and releases

- `main` takes one squashed commit per pull request. Merge at the head commit that was reviewed and that CI passed on.
- After fixing review points, update the pull request's description too: it often still says what couldn't be run or describes the first version.
- Search the existing issues before opening one. If creating an issue returns an unclear result, search again before retrying, so no duplicate is filed.
- There is no "web" release line: the `server-v` tag ships the web client with the backend. Installed apps get a client change only from an `app-v` tag.
- Before tagging, look at what changed since each line's last tag to decide which lines need a release, and follow the earlier bumps (a minor version for a feature).
- A release step that succeeds may not have delivered: an upload can be accepted and still be held by the store. Check the outcome where it lands before saying it shipped.
- When git, `gh` and `github_read` all fail with "access could not be verified", the session's GitHub access is stale and the session can't repair it. Keep the commit, save any drafted text in the worktree, and tell the person to reconnect their GitHub account.
- When they say GitHub no longer accepts Pikibun's sign-in, or that the owner has no GitHub connection, only the owner can fix it, by signing in to Pikibun with GitHub again. Say so and stop retrying. A "rate limit" that never lifts, with requests going "without a credential", is the same thing on servers from before #288.
- When they fail because the owner's GitHub rate limit is used up, nothing in the session can fix it either: retrying only spends the next hour's quota. Stop reading GitHub, say when it resets (`gh api rate_limit` shows `reset`, in Unix seconds), and carry on with work that doesn't need it.

## Sessions and schedules

- A `sessions` read returns only a session's latest 50 entries, each cut short. To learn why another session failed, read its last entries. A read of an archived session can also fail outright: skip it.
- In a workspace with many sessions, the `sessions` list is cut off before its models section, so a model's id may not be visible there. Ask the person for the id rather than guess one.
- A schedule belongs to its session and can't be managed from another one. Give a recurring job its own session: a busy session skips its runs, and missed runs aren't caught up.
- A scheduled run uses its session's current model, and a child session inherits it unless a model is named.
- An unattended schedule acts as the session's owner, so only the owner's messages may create one, and never a Read-only message.

## Writing for people

- Don't say something succeeded when it was only started: "compaction started" is not "compacted".
- Don't report what you only inferred, such as from a job's name. Read what the step printed, or say it is an assumption.
- Say plainly what you couldn't check: not seen on screen, not tried on a real device, full suite not run.
- Explain what a suggested term means when it can be misread. "Summary" was taken to mean a model-written one when it meant a formatting rule.
- Before proposing new code, check whether an existing mechanism (a schedule, a setting, an extension that already exists) does the job.
- When a problem can't be reproduced, report what was checked and ask what the person saw, rather than change code on a guess.
