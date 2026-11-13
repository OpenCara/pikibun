import { z } from "zod";

export const CALLBACK_LIMIT = 64 * 1024;
export const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const encoder = new TextEncoder();
export const actorSchema = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);

export async function boundedBody(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel();
    throw new Error("Response exceeds connector limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("Response exceeds connector limit");
      chunks.push(value);
    }
    signal?.throwIfAborted();
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class CallbackRefused extends Error {
  constructor(readonly status: number) { super("Scoped connector callback denied or unavailable"); }
}

export const refusedReport = (error: unknown) => error instanceof CallbackRefused && error.status === 400;

export function responseSummary(response: Pick<Response, "status" | "headers">): string {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().replace(/[^\w.+/-]/g, "").slice(0, 100);
  return `${response.status}${type ? ` ${type}` : ""}`;
}

export function decodeJson(bytes: Uint8Array, response?: Pick<Response, "status" | "headers">): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`Invalid control-plane response${response ? ` (${responseSummary(response)})` : ""}`); }
}
