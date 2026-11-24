# Lessons enforced in code

`docs/LESSONS.md` collects what sessions learned the hard way. A lesson is text an agent must remember to read and
follow; where a check, a tool or a hook can do the same, it is cheaper and surer to have it done. This note maps the
lessons that moved into code to what now enforces them, and why each took the form it did. The lessons file keeps a
line for each, naming the mechanism, so an agent that meets the refusal knows why.

## The repository's own checks

| Lesson | Now |
|---|---|
| Sources carry no comments; run `tests/no-comments.test.ts` before pushing | CI's fast `checks` job runs it (`pnpm check:comments`) besides the `tests` job, so it fails within minutes; `pnpm check:fast` runs it with lint locally; `piki:pr-flow`'s `pre-push-check` can refuse a push before it passed |
| The `@earendil-works` packages pin each other exactly: upgrade them together, in both manifests and both lockfiles | `tests/pinned-dependencies.test.ts`, in `checks` too |
| `pnpm --filter pikibun run shrinkwrap` fails under npm 12 | `packages/cli/scripts/shrinkwrap.mjs` copies `package-lock.json` to `npm-shrinkwrap.json` instead of running `npm shrinkwrap`, which npm 12 dropped. The two are the same file under another name since npm 7 |
| Release the connector before the server that raises `MINIMUM_CONNECTOR_VERSION`; pin only an extension version npm has | `release-server.yml`'s `prerequisites` job (`scripts/release-prerequisites.ts`) fails the release while npm lacks either, before the image is built |

`pre-push-check` gates a `git_push` or `git push` that pushes a branch; one of only tags or deletions, or a dry run,
passes ([its design](piki-extensions.md), note 40).

The prerequisites check runs only for a server release, not on pull requests: a pull request that raises the minimum
is merged before the connector it names is released, and that order is right.

Already enforced before this note, so their lessons only point at the check: migrations for both providers
(`tests/migrations.test.ts`), a bundled extension's version from its latest release tag (`scripts/set-release-version.mjs`), the
upstream workarounds list (`tests/upstream-workarounds.test.ts`), the Native Shell pin (`tests/nsh-download.test.ts`) and
the old file tool names (`tests/pi-tool-names.test.ts`).

## The program tools

See [Tool definitions](tool-definitions.md), notes 11 to 14: a default time limit for test suites and servers, `env`,
the hint to give `directory` when a call failed at the worktree's top for want of a clone's manifest, and the hint that
a process ending with exit 137 was killed, most likely for want of memory. Each is the
connector's, so it reaches hosts with a `cli-v` release.

## GitHub

- **An unclear merge settles itself.** When GitHub doesn't confirm a merge (a timeout, a 5xx, an answer without
  `merged`), the broker reads the pull request again before saying anything. Merged: it reports the merge, with the
  merge commit, but only when the merged head is the commit this call named (a person may have merged another head
  meanwhile, which stays unknown). Not merged, open or closed: a definite refusal (422), so the agent knows nothing was merged and can read
  it and try again. Only a read that fails too leaves the outcome unknown. The capability stays consumed either way: the
  settled answer describes that attempt.
- **An unclear issue settles itself, and a duplicate isn't filed.** An issue's unclear outcome looks for an open issue
  with the exact title, opened by the owner since a minute before the attempt; one found is the answer. Before
  opening, the broker refuses (422 `github_issue_duplicate`, a definite refusal, the tool call not consumed) when the owner opened an open
  issue with the same title in that repository in the last 15 minutes, naming it. Together they make a retry after an
  unclear answer safe, which the lesson "search again before retrying" asked agents to do by hand. An exact title and a
  short window keep it from refusing a different issue.
- **The runner keeps the broker's words.** A GitHub effect the broker refused before reaching GitHub (4xx but 409) is
  `failed` with the broker's reason, such as the rate limit, rather than "outcome is ambiguous", which sent agents
  inspecting GitHub for an effect that never left Pikibun. A 409 (already attempted) and a 5xx stay `interrupted`, now
  with the broker's message. So a refusal the agent should act on, such as a duplicate issue, is a 422, never a 409.
- **What it doesn't see.** A program tool's `git push` of a new branch prints no commit, so that first push isn't
  recognised as the session's own and still ends a `wait: "change"`. Reading the clone's remote-tracking ref instead
  would also take in commits fetched from others; `git_push` names its commit, and a pull request's branch has
  usually been pushed before the wait.
- **A used-up rate limit is remembered.** When GitHub answers an owner's request with its rate limit (`429`, or `403`
  with `x-ratelimit-remaining: 0` or `retry-after`), the server remembers, per token, until `retry-after`, else
  `x-ratelimit-reset`, else a minute, and at most an hour. Until then its reads with that token (`github_read`, the
  repository checks behind `git` and `gh`, pull request states) are refused at once with the reset time, without asking
  GitHub. Agents kept retrying, which spent nothing but a model turn each time and told them nothing new; now each
  refusal says when to come back. It is in memory, like the reads cache, so a restart forgets it.
- **`wait: "change"` past the session's own changes.** A wait returned at once after the agent's own comment or push,
  and agents were told to look and wait again. The waiter now leaves out comments the session posted (`github_comment`,
  `gh pr comment`) and, while the head is a commit it pushed (`git_push`, `git push`), the head and its checks, from
  both the first read and the current one. Anyone else's comment, review or push still ends the wait; checks on the
  session's own push are what `wait: "checks"` is for. What the session did is read from its own operation records, so
  nothing new is stored.
- **`gh` gets past a token a push reset** (#480). A `git_push` with the owner's account resets the owner's GitHub
  token afterwards, and each host's API proxy kept the old one for up to a minute: `gh` answered `401 Bad credentials`
  some seconds after a push, in that session and the owner's others, and agents reported release runs as unchecked.
  The proxy now drops a token the API refuses, asks the Pikibun server for the current one and sends the request
  again, so the command never sees that `401` ([its design](egress.md), "A token the API refuses is dropped at
  once"). It is the connector's, so it reaches hosts with a `cli-v` release.

## The gh tool

A CLI definition (`packages/shared/src/cli-definitions.ts`) carries `hints` beside `refuse`: each names calls as a
refusal does (`words`, `options`, `short`, `argPattern`), an `outputPattern`, or both, and the text to add. The engine
(`cliRules().hints`) picks them, and the tool adds each as a `Hint:` line after the output, only for a run that ended on
its own with a non-zero exit, or printed nothing: a run that succeeded may quote an error (an issue about it), and one
the tool stopped or a signal ended names its own reason. A result takes at most four hints, so a faulty served
definition can't crowd out the output, and a hint's patterns are bounded like a refusal's (their number, their length,
the output they read and the time they take: [extension planes](extension-planes.md#phase-4-as-built), "Patterns run
bounded"), so one can't stall the connector either.

- **A TLS certificate failure** (#434). Output with `tls: failed to verify certificate` or `x509: ` gets a hint: the
  host's certificate store or an intercepting proxy refused GitHub's certificate, retrying won't help, the brokered
  tools (`github_read` with `wait`, `github_comment`, `github_issue`, `github_merge`) still reach GitHub through the
  Pikibun server, and the host's owner fixes the host. Agents had taken it for GitHub being down or a failed check.
  It isn't reported in the host's health: that needs a report field and a place in Settings → Hosts, more than a hint.
- **`view --comments`** (#466). `gh issue view` and `gh pr view` with both `--comments` and `--json` are refused before
  anything runs, naming `--json comments` alone; a view with `--comments` that fails or prints nothing gets a hint
  naming `--json comments` and `gh api repos/<owner>/<name>/issues/<n>/comments`.
- **`401 Bad credentials`** (#480). Output with `Bad credentials` or `HTTP 401` gets a hint: usually a `git_push`
  just reset the owner's token and the host still held the old one, which is not a lost sign-in and passes within a
  minute; git still works (`git ls-remote --tags origin` confirms pushed tags), `github_read` reads a pull request and
  waits for its checks, and a `401` that lasts minutes is one to tell the person about. On a connector whose proxy
  replaces a refused token itself (under GitHub, above) the hint is for what is left: a token the Pikibun server keeps
  giving though GitHub refuses it.

Served definitions add hints as they add refusals: a connector applies its own and the served ones, each text once.
A connector's parser passes over a whole definition with a key it doesn't know (silently before the review's finding 72
was fixed; since then the host's log names the definition and the key), so one from before `hints` would lose every
served `gh` rule. The Pikibun server therefore serves `hints` only to a connector that asks
(`cliHints: true` in the body of `/api/connectors/self/tools`) and leaves the key out otherwise. The new refusal is an
ordinary `refuse` rule, so older connectors apply it once the Pikibun server is deployed; the hints need a `cli-v`
release.

## What stays text

Lessons that need judgement stay in `docs/LESSONS.md`: how to word things for people, which release lines a fix needs,
when to stop for a decision, what to say was checked and what wasn't.
