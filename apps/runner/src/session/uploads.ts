import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../../../../packages/shared/src/crypto.js";
import { ATTACHMENTS_DIRECTORY, fileUploadLimits, type UploadChunk, type UploadResult } from "../../../../packages/shared/src/file-uploads.js";
import { RunnerError, stableJson } from "../protocol.js";
import type { SandboxAuthorize } from "../sandbox.js";
import type { SessionWorkspace } from "../workspace.js";

export const MAX_STAGED_UPLOAD_BYTES = 4 * fileUploadLimits.maxBytes;
export const MAX_STAGED_UPLOADS = 2 * fileUploadLimits.count;
export const STALE_UPLOAD_MS = 60 * 60 * 1000;

export class SessionUploads {
  #turn: Promise<void> = Promise.resolve();

  constructor(readonly directory: string, private readonly workspace: Pick<SessionWorkspace, "importFile">) {}

  receive(actorId: string, chunk: UploadChunk, authorize: SandboxAuthorize): Promise<UploadResult> {
    const turn = this.#turn.then(() => this.#receive(actorId, chunk, authorize));
    this.#turn = turn.then(() => {}, () => {});
    return turn;
  }

  async #receive(actorId: string, chunk: UploadChunk, authorize: SandboxAuthorize): Promise<UploadResult> {
    const key = (await sha256(stableJson({ actor: actorId, uploadId: chunk.uploadId, name: chunk.name, size: chunk.size }))).slice(0, 43);
    const part = join(this.directory, `${key}-${chunk.size}.part`);
    const data = Buffer.from(chunk.data, "base64");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (chunk.offset === 0) await this.#sweep(`${key}-${chunk.size}.part`, chunk.size);
    else {
      let staged: number;
      try { staged = (await lstat(part)).size; }
      catch { throw new RunnerError(409, "That upload is no longer on the host. Attach the file again"); }
      if (staged !== chunk.offset) throw new RunnerError(409, "Upload chunks arrived out of order. Attach the file again");
    }
    const file = await open(part, chunk.offset === 0 ? "w" : "a", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally { await file.close(); }
    const received = chunk.offset + data.length;
    if (received < chunk.size) return { received };
    try {
      const bytes = await readFile(part);
      if (bytes.length !== chunk.size) throw new RunnerError(409, "Upload chunks arrived out of order. Attach the file again");
      let path: string;
      try { path = await this.workspace.importFile(ATTACHMENTS_DIRECTORY, chunk.name, bytes, authorize); }
      catch (error) { throw importFailure(error); }
      return { received, path };
    } finally {
      await rm(part, { force: true }).catch(() => {});
    }
  }

  async #sweep(own: string, size: number): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch { return; }
    let declared = 0;
    let uploads = 0;
    for (const name of names) {
      if (name === own) continue;
      const path = join(this.directory, name);
      const match = /^[A-Za-z0-9_-]{43}-(\d{1,12})\.part$/.exec(name);
      try {
        const info = await lstat(path);
        if (!match || !info.isFile() || Date.now() - info.mtimeMs > STALE_UPLOAD_MS) await rm(path, { force: true, recursive: true });
        else { declared += Number(match[1]); uploads++; }
      } catch { }
    }
    if (uploads + 1 > MAX_STAGED_UPLOADS || declared + size > MAX_STAGED_UPLOAD_BYTES) {
      throw new RunnerError(429, "Too many files are being uploaded to this session at once. Try again shortly");
    }
  }
}

function importFailure(error: unknown): RunnerError {
  if (error instanceof RunnerError) return error;
  const message = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}`.toLowerCase() : "";
  if (/too many files with this name/.test(message)) return new RunnerError(422, "The attachments directory has too many files of that name. Rename the file and attach it again");
  if (/not a directory|symlinks are not followed|too many levels of symbolic links|path component is not a real directory|not a real directory/.test(message)) {
    return new RunnerError(422, "The worktree's attachments path isn't a directory the file can go into");
  }
  if (/no space|quota|file too large|exceeds size limit/.test(message)) return new RunnerError(422, "The session has no room for that file");
  return new RunnerError(422, "The file could not be written into the worktree");
}
