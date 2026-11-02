import { createInterface } from "node:readline";
import { STDIO_FRAME } from "./desktop-protocol.js";

// The IPC channel of a process a desktop app runs (the connector host, the local server): Electron's utilityProcess
// parentPort, or Node's fork channel in tests. Messages are structured-cloned objects, validated by the receiver.
// A host the Windows app runs inside WSL2 (through wsl.exe, which carries only stdio) uses stdioTransport instead.

export interface Transport<Event> {
  send(event: Event): void;
  onMessage(listener: (value: unknown) => void): void;
  onClose(listener: () => void): void;
}

/** Electron's utilityProcess `process.parentPort`. */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

/** Upper bound of one request line; the largest request, an upload chunk, is about 1 MiB of base64 plus its grant. */
const STDIO_LINE_LIMIT = 4 * 1024 * 1024;

/**
 * JSON lines over stdin and stdout, for a host started through a pipe-only launcher (wsl.exe). Requests arrive one per
 * line on stdin; events leave one per line on stdout, each prefixed with STDIO_FRAME. Everything else this process
 * writes to stdout goes to stderr instead, so it can't be taken for a message. The pipe is private to the app: pairing
 * codes cross it as they cross the utility process's port, never argv, environment, files or logs.
 */
export function stdioTransport<Event>(): Transport<Event> {
  // Messages keep stdout's own writer, in order; everyone else's writes to process.stdout (console.log among them) go
  // to stderr from now on.
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  stdout.on("error", () => { /* The app has gone; stdin's end follows. */ });
  stdout.write = ((chunk: unknown, ...rest: unknown[]) => (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof stdout.write;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const closed: (() => void)[] = [];
  lines.once("close", () => { for (const listener of closed.splice(0)) listener(); });
  return {
    send: event => write(`${STDIO_FRAME}${JSON.stringify(event)}\n`),
    onMessage: listener => lines.on("line", line => {
      if (!line.trim()) return;
      if (line.length > STDIO_LINE_LIMIT) { listener(undefined); return; }
      let value: unknown;
      try { value = JSON.parse(line); } catch { value = undefined; }
      listener(value);
    }),
    onClose: listener => { closed.push(listener); },
  };
}

export function parentTransport<Event>(): Transport<Event> {
  const candidate = "parentPort" in process ? process.parentPort : undefined;
  if (candidate && typeof candidate === "object" && "postMessage" in candidate && "on" in candidate) {
    // Shape checked above; Electron documents postMessage and on("message") with MessageEvent-like { data }.
    const port = candidate as ParentPort;
    // Electron tears a utility process down with its parent, so only Node's channel reports a close.
    return { send: event => port.postMessage(event), onMessage: listener => port.on("message", event => listener(event.data)), onClose: () => {} };
  }
  const send = process.send?.bind(process);
  if (!send) throw new Error("This process must be started by the Pikibun app");
  return {
    send: event => { if (process.connected) send(event); },
    onMessage: listener => process.on("message", listener),
    onClose: listener => process.once("disconnect", listener),
  };
}
