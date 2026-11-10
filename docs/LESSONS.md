# Lessons from recent sessions

This file is maintained by a daily scheduled session, which distils lessons from the workspace's recent sessions. It is not loaded into new sessions automatically: read it at the start of a task. For the commands and layout, see [development.md](development.md).

## Words and architecture

- Say "Pikibun server" or "host", never just "server": people ask which one is meant.
- Hosts send the whole transcript; redaction and brief mode run on the Pikibun server, redaction first. Anything derived from a tool result there must be built from the redacted text.
- Hosts update their connectors slowly. Keep on the host only what nothing else can recover, and put logic that changes often in the Pikibun server or the client.
- Code that the server and the client both need goes in `packages/shared`.
- `apps/nsh` is the only client. The Electron, React and Expo apps are gone, so check that a file still exists before citing or editing it.

## Building and testing

- For one test, run `node --import tsx --test --test-name-pattern "<words>" tests/<file>.test.ts` instead of the whole suite.
- The network-proxy tests fail when the temporary directory's path is too long for their sockets. Run them with a short `TMPDIR` before treating that as a regression.
- A sandbox may not reach the npm registry. If dependencies can't be installed, say so in the pull request and treat its CI as the only typecheck and full test run.
- Wait for CI with `gh pr checks <n> --watch` and a long timeout, not by polling.
- When a clone fails, the repository can still be read through `gh api` (trees and raw file contents).

## Sessions and schedules

- A `sessions` read returns only a session's latest 50 entries, each cut short. To learn why another session failed, read its last entries.
- In a workspace with many sessions, the `sessions` list is cut off before its models section, so a model's id may not be visible there. Ask the person for the id rather than guess one.
- A schedule belongs to its session and can't be managed from another one. Give a recurring job its own session: a busy session skips its runs, and missed runs aren't caught up.
- A scheduled run uses its session's current model, and a child session inherits it unless a model is named.
- An unattended schedule needs auto-approve, which only the session owner's own auto-approved message can grant.

## Writing for people

- Don't say something succeeded when it was only started: "compaction started" is not "compacted".
- Explain what a suggested term means when it can be misread. "Summary" was taken to mean a model-written one when it meant a formatting rule.
- Before proposing new code, check whether an existing mechanism (a schedule, a setting, an extension that already exists) does the job.
