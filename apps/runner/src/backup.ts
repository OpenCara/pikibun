import { RunnerError } from "./protocol.js";

export const MAX_BACKUP_BYTES = 24 * 1024 * 1024;

const OR_CONVERSATION = "or back up its conversation only";
export const BACKUP_TOO_LARGE = `This session is too large to back up or move: a backup holds at most 24 MiB. Remove files you don't need, ${OR_CONVERSATION}`;
const CONVERSATION_TOO_LARGE = "This session's conversation is too large to back up: a backup holds at most 24 MiB";

export function backupRefusal(error: unknown): unknown {
  if (error instanceof RunnerError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/refuses symlinks and special files/.test(message)) {
    return new RunnerError(422, `This session has symlinks or special files outside its clones, which a backup can't keep. Remove them, ${OR_CONVERSATION}`);
  }
  if (/non-hardlinked files/.test(message)) {
    return new RunnerError(422, `This session has hardlinked files outside its clones, which a backup can't keep. Remove them, ${OR_CONVERSATION}`);
  }
  if (/too many files|too many entries|nesting limit/.test(message)) {
    return new RunnerError(422, `This session has too many files to back up: a backup holds at most 10,000 files outside its clones. Remove the ones you don't need, ${OR_CONVERSATION}`);
  }
  if (/size limit|byte output limit/.test(message)) return new RunnerError(422, BACKUP_TOO_LARGE);
  if (/need a host with the sandbox/.test(message)) {
    return new RunnerError(422, `This session has a clone in its worktree, which only a host with the sandbox can back up. Push the clone's work, ${OR_CONVERSATION}`);
  }
  if (/borrows objects from the host cache/.test(message)) {
    return new RunnerError(422, "One of this session's clones borrows from the host's repository cache, which it can't read now, so the session can't be backed up yet");
  }
  if (/too many branches|branch whose name/.test(message)) {
    return new RunnerError(422, "One of this session's clones has too many branches, or a branch whose name a backup can't keep");
  }
  if (/the clone .* could not be backed up/.test(message)) return new RunnerError(422, "One of this session's clones can't be backed up");
  return error;
}

export function boundedBackup<T extends object>(backup: T): T {
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) {
    throw new RunnerError(422, (backup as { conversationOnly?: unknown }).conversationOnly === true ? CONVERSATION_TOO_LARGE : BACKUP_TOO_LARGE);
  }
  return backup;
}
