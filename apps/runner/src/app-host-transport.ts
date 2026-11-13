import { createInterface } from "node:readline";
import { STDIO_FRAME } from "../../../packages/shared/src/app-host-protocol.js";

export interface Transport<Event> {
  send(event: Event): void;
  onMessage(listener: (value: unknown) => void): void;
  onClose(listener: () => void): void;
}

const STDIO_LINE_LIMIT = 4 * 1024 * 1024;

export function stdioTransport<Event>(): Transport<Event> {
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  stdout.on("error", () => { });
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
