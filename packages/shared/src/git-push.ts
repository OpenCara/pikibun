export function sessionBranch(session: { id: string; branch?: string | null }): string {
  return session.branch || `pikibun/${session.id}`;
}

export const SESSION_BRANCH_SLUG_LIMIT = 48;
export const SESSION_BRANCH_ID_DIGITS = 12;
const SESSION_BRANCH = new RegExp(`^pikibun/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{${SESSION_BRANCH_ID_DIGITS}}$`);

function sessionBranchId(sessionId: string): string {
  return sessionId.replace(/[^0-9a-f]/gi, "").slice(0, SESSION_BRANCH_ID_DIGITS).toLowerCase().padEnd(SESSION_BRANCH_ID_DIGITS, "0");
}

export function sessionBranchName(title: string, sessionId: string): string {
  let slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > SESSION_BRANCH_SLUG_LIMIT) {
    const cut = slug.slice(0, SESSION_BRANCH_SLUG_LIMIT + 1);
    const boundary = cut.lastIndexOf("-");
    slug = (boundary >= SESSION_BRANCH_SLUG_LIMIT / 2 ? cut.slice(0, boundary) : cut.slice(0, SESSION_BRANCH_SLUG_LIMIT)).replace(/-+$/, "");
  }
  if (!slug || slug === "untitled-session") slug = "session";
  return `pikibun/${slug}-${sessionBranchId(sessionId)}`;
}

export function validSessionBranch(branch: unknown, sessionId: string): branch is string {
  return typeof branch === "string" && branch.length <= "pikibun/".length + SESSION_BRANCH_SLUG_LIMIT + 1 + SESSION_BRANCH_ID_DIGITS
    && SESSION_BRANCH.test(branch) && branch.endsWith(`-${sessionBranchId(sessionId)}`);
}

export interface PushCommand { old: string; new: string; ref: string }

export const PUSH_COMMANDS_BYTES = 64 * 1024;
export const PUSH_REQUEST_BYTES = 2 * 1024 * 1024 * 1024;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ZERO_OBJECT = /^0+$/;

export class PushRequestError extends Error {
  constructor(message: string) { super(message); this.name = "PushRequestError"; }
}

export function parsePushCommands(bytes: Uint8Array): { commands: PushCommand[]; capabilities: string[]; end: number } | undefined {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let position = 0;
  for (;;) {
    if (bytes.length < position + 4) return undefined;
    const header = String.fromCharCode(...bytes.subarray(position, position + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new PushRequestError("Invalid Git push request");
    const length = parseInt(header, 16);
    if (length === 0) return { commands, capabilities, end: position + 4 };
    if (length < 5) throw new PushRequestError("Invalid Git push request");
    if (bytes.length < position + length) return undefined;
    let line = new TextDecoder("latin1").decode(bytes.subarray(position + 4, position + length));
    position += length;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (!commands.length) capabilities = line.slice(nul + 1).split(" ").filter(Boolean);
      line = line.slice(0, nul);
    }
    if (line.startsWith("shallow ")) continue;
    if (line.startsWith("push-cert")) throw new PushRequestError("Signed pushes are not supported");
    const [old, next, ref, ...rest] = line.split(" ");
    if (rest.length || !OID.test(old ?? "") || !OID.test(next ?? "") || !ref) throw new PushRequestError("Invalid Git push request");
    commands.push({ old: old!, new: next!, ref });
  }
}

export async function readPushCommands(body: ReadableStream<Uint8Array>): Promise<{ commands: PushCommand[]; capabilities: string[]; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  let parsed: ReturnType<typeof parsePushCommands>;
  try {
    while (!(parsed = parsePushCommands(head))) {
      if (head.length > PUSH_COMMANDS_BYTES) throw new PushRequestError("The Git push request is invalid or too large");
      const part = await reader.read();
      if (part.done) throw new PushRequestError("The Git push request ended early");
      const next = new Uint8Array(head.length + part.value.length);
      next.set(head);
      next.set(part.value, head.length);
      head = next;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  let first = true;
  return {
    commands: parsed.commands,
    capabilities: parsed.capabilities,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first) { first = false; controller.enqueue(head); return; }
        const part = await reader.read();
        if (part.done) controller.close();
        else controller.enqueue(part.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    }),
  };
}

export async function drainStream(body: ReadableStream<Uint8Array>, limit: number): Promise<boolean> {
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return true;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return false; }
    }
  } catch { return false; }
}

export function boundedStream(body: ReadableStream<Uint8Array>, limit: number, message: string): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) controller.error(new PushRequestError(message));
      else controller.enqueue(chunk);
    },
  }));
}

export function sessionBranchRefusal(commands: readonly PushCommand[], branch: string): string | undefined {
  const ref = `refs/heads/${branch}`;
  const other = commands.find(command => command.ref !== ref);
  if (other?.ref.startsWith("refs/tags/")) {
    return `Tags can't be pushed with plain git, not ${other.ref.slice("refs/tags/".length, 200)}; use the git_push tool with a tag for a commit already on its branch`;
  }
  if (other) return `Only this session's branch ${branch} can be pushed with plain git, not ${other.ref.replace(/^refs\/heads\//, "").slice(0, 200)}; use the git_push tool for other branches`;
  if (commands.length > 1) return `Push ${branch} once per push`;
  if (commands.some(command => ZERO_OBJECT.test(command.new))) return `The session branch ${branch} can't be deleted`;
  return undefined;
}

function pktLine(payload: Uint8Array): Uint8Array {
  const line = new Uint8Array(payload.length + 4);
  line.set(new TextEncoder().encode((payload.length + 4).toString(16).padStart(4, "0")));
  line.set(payload, 4);
  return line;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

export function pushRejection(commands: readonly PushCommand[], capabilities: readonly string[], reason: string): Uint8Array | undefined {
  if (!capabilities.includes("report-status") && !capabilities.includes("report-status-v2")) return undefined;
  const text = reason.replace(/[^\x20-\x7e]/g, " ").slice(0, 400);
  const encoder = new TextEncoder();
  const flush = encoder.encode("0000");
  const report = concat([pktLine(encoder.encode("unpack ok\n")),
    ...commands.map(command => pktLine(encoder.encode(`ng ${command.ref} ${text}\n`))), flush]);
  if (!capabilities.includes("side-band-64k") && !capabilities.includes("side-band")) return report;
  const size = capabilities.includes("side-band-64k") ? 65515 : 995;
  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < report.length; offset += size) packets.push(pktLine(concat([new Uint8Array([1]), report.subarray(offset, offset + size)])));
  return concat([...packets, flush]);
}
