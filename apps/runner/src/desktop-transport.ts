import { createInterface } from "node:readline";
import { STDIO_FRAME } from "./desktop-protocol.js";

// The channel between the Pikibun app and the connector host it runs (`pikibun host --stdio`): JSON lines over stdin
// and stdout. Messages are plain JSON objects, validated by the receiver.

export interface Transport<Event> {
  send(event: Event): void;
  onMessage(listener: (value: unknown) => void): void;
  onClose(listener: () => void): void;
}

/** Upper bound of one request line; the largest request, an upload chunk, is about 1 MiB of base64 plus its grant. */
const STDIO_LINE_LIMIT = 4 * 1024 * 1024;

/**
 * JSON lines over stdin and stdout. Requests arrive one per line on stdin; events leave one per line on stdout, each
 * prefixed with STDIO_FRAME. Everything else this process writes to stdout goes to stderr instead, so it can't be taken
 * for a message. The pipe is private to the app: pairing codes cross it, never argv, environment, files or logs.
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
