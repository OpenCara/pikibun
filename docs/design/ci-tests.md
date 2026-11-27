# CI's tests in parallel jobs

CI's `tests` job was the critical path of every run: 466-648 seconds over eight runs, while the next slowest job
(`client`) took about three minutes. 85% of it was one step, `pnpm test:coverage`, which ran all of `tests/*.test.ts`
three files at a time (Node's default on the runner's four CPUs): the files' own times added up to 984 seconds in
434 of wall time. No single file dominated: the ten slowest held about half the time, `host-extensions`,
`extension-process`, `managed-extensions` and `runner-queue` first, at 44-62 seconds each. The slow runs were slower in
every file alike, the runner's variance rather than a test's.

## The split

`tests` is a matrix of five jobs, each with the Linux sandbox's prerequisites and Postgres as before:

- `shard-1` to `shard-4` split `tests/*.test.ts` by the time each file took (`scripts/test-shards.mjs pick N/4`): the
  slowest first, each to the shard with the least time so far. A file `tests/timings.json` doesn't name, such as a new
  one, weighs as the median.
- `sandbox` runs `tests/sandbox-conformance.test.ts` (each sandbox's implementation of a session's files against one
  table of cases, about 35 seconds) and then `pnpm test:connected` (the end-to-end suite, about 45 seconds), the two
  that need a working bubblewrap the most, out of the shards' way.
- `tests/no-comments.test.ts` and `tests/pinned-dependencies.test.ts` run in the `checks` job only: they ran in both,
  and `no-comments` alone took 19-27 seconds.

Node's own `--test-shard` was tried first: it takes every Nth file of the sorted list, balancing by count, and the slow
files fell together. Four shards took 77, 93, 143 and 193 seconds of tests, the longest worse than three shards; split by
time, the same files add up to about 360 seconds in each.

`tests/timings.json` holds each file's own time in seconds, as Node's runner reports its `test:complete` (the process
with its imports and its tests), recorded by `scripts/test-times-reporter.mjs` in every test job. The `coverage` job
merges them into the run's `test-timings` artifact. The table only balances the shards, so a stale one costs time,
not correctness: when the shards' times drift apart, replace it with `test-timings` from a recent run on `main`.
`tests/test-shards.test.ts` fails while it names a file that no longer exists.

Per-file selection from a pull request's diff was considered and left out: the slow files depend on
`packages/shared`, so a typical pull request still selected 150-185 of the 233 files, and tests that spawn processes,
read migrations or scan the repository need rules an import graph can't give.

## Coverage

Each job writes its own lcov report; the `coverage` job merges them (`scripts/merge-lcov.mjs`, adding up hits per file,
line and function) into the one `lcov.info` and the summary table as before.

Coverage costs 17-36% of the tests' time, measured on the same runner with and without it (three shards: 109 against
80 seconds, 161 against 132, 162 against 128). With the shards that is about 30 seconds of the critical path, kept for
the summary on every pull request; dropping `--experimental-test-coverage` from pull requests' runs is the step to take
if those seconds matter more.

The merge is exact only where every report agrees on a file's structure. Lines are counted from each process's own
ranges, and the merged count stayed within a tenth of a point of one run's. Branches are not: V8 leaves out a block
whose count equals its parent's, so a file's branches differ between processes, and lcov keeps no ranges to align them
by. The merge pairs a line's branches in order, which leaves some blocks one shard never ran uncovered where one run
would have merged them into a covered parent: branches read about a point lower (86.0% against 87.0% on the first run).
Node's test runner merges the processes' V8 ranges themselves, but only those of the processes it started; it doesn't
report on raw coverage files left in `NODE_V8_COVERAGE` by other runs, so it can't merge across jobs.
