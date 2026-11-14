import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_TOO_LARGE, MAX_BACKUP_BYTES, backupRefusal, boundedBackup } from "../apps/runner/src/backup.js";
import { RunnerError } from "../apps/runner/src/protocol.js";

const shown = /^[\w .,:'()-]{1,300}$/;

test("the snapshot's refusals of a backup become reasons the session's owner can act on", () => {
  for (const [message, reason] of [
    ["Sandbox process failed (exit 1): sandbox: file exceeds size limit", /too large to back up/],
    ["sandbox: file exceeds size limit", /too large to back up/],
    ["Sandbox exceeded 50331648 byte output limit", /too large to back up/],
    ["Sandbox process failed (exit 1): sandbox: the clones' local work exceeds the backup size limit", /too large to back up/],
    ["Sandbox process failed (exit 1): sandbox: snapshot refuses symlinks and special files", /symlinks or special files/],
    ["Sandbox process failed (exit 1): sandbox: only regular, non-hardlinked files are supported", /hardlinked files/],
    ["Sandbox process failed (exit 1): sandbox: snapshot has too many files", /too many files/],
    ["Sandbox process failed (exit 1): sandbox: directory has too many entries", /too many files/],
    ["sandbox: backups of sessions with a clone in the worktree need a host with the sandbox; push the clone's work instead", /only a host with the sandbox/],
    ["Sandbox process failed (exit 1): sandbox: the clone app borrows objects from the host cache that this session can't read now", /repository cache/],
    ["Sandbox process failed (exit 1): sandbox: the clone app has too many branches to back up", /too many branches/],
    ["Sandbox process failed (exit 1): sandbox: the clone app has a branch whose name can't be backed up", /branch whose name/],
    ["Sandbox process failed (exit 1): sandbox: the clone app/x could not be backed up", /clones can't be backed up/],
  ] as const) {
    const error = backupRefusal(new Error(message));
    assert.ok(error instanceof RunnerError && error.status === 422 && reason.test(error.message) && shown.test(error.message), message);
  }
  const other = new Error("Sandbox launcher is unavailable; refusing unsandboxed execution");
  assert.equal(backupRefusal(other), other);
  const refusal = new RunnerError(409, "Backup requires an idle session including queued work");
  assert.equal(backupRefusal(refusal), refusal);
});

test("a backup larger than a restore takes is refused before it leaves the host", () => {
  const small = { files: ["x"] };
  assert.equal(boundedBackup(small), small);
  const data = "x".repeat(MAX_BACKUP_BYTES);
  assert.throws(() => boundedBackup({ files: [data] }), (error: unknown) => error instanceof RunnerError && error.status === 422 && error.message === BACKUP_TOO_LARGE);
  assert.throws(() => boundedBackup({ sqlite: data, conversationOnly: true }),
    (error: unknown) => error instanceof RunnerError && error.status === 422 && /conversation is too large to back up/.test(error.message) && shown.test(error.message));
  assert.ok(shown.test(BACKUP_TOO_LARGE));
});
