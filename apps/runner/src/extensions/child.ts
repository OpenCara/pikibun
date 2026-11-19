import "./jiti-environment.js";
import { createServer, Socket } from "node:net";
import { ExtensionWorker } from "./worker.js";
import type { CompleteAnswer, CompleteRequest, ExtensionMethod } from "./protocol.js";
import { lineReader } from "./lines.js";

type Incoming = { id: number; method: ExtensionMethod; params: Record<string, unknown> } | { cancel: number }
  | { answered: number; value?: CompleteAnswer; error?: string };
type Outgoing = { id?: number } & Record<string, unknown>;

const CONNECT_TIMEOUT_MS = 60_000;
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const directory = process.argv.at(-1);
const socketAt = process.argv.indexOf("--socket");
const socketPath = socketAt >= 0 ? process.argv[socketAt + 1] : undefined;
const piped = process.argv.includes("--pipe");
if (!directory || (!socketPath && !piped && !process.send)) {
  process.stderr.write("The extension process is started by the connector, with an IPC channel, a pipe or a socket, and its session's directory.\n");
  process.exit(2);
}

function speak(socket: Socket, handle: (message: Incoming) => void): (message: Outgoing) => void {
  socket.on("data", lineReader(line => {
    let message: Incoming;
    try { message = JSON.parse(line) as Incoming; } catch { return; }
    handle(message);
  }, () => socket.destroy()));
  socket.on("close", () => process.exit(0));
  socket.on("error", () => process.exit(0));
  return message => { socket.write(`${JSON.stringify(message)}\n`); };
}

function serve(handle: (message: Incoming) => void, connected: (write: (message: Outgoing) => void) => void): void {
  if (piped) {
    connected(speak(new Socket({ fd: 3, readable: true, writable: true }), handle));
    return;
  }
  if (!socketPath) {
    process.on("message", handle);
    process.on("disconnect", () => process.exit(0));
    connected(message => { process.send?.(message); });
    return;
  }
  let peer: Socket | undefined;
  const server = createServer(socket => {
    if (peer) {
      socket.destroy();
      return;
    }
    peer = socket;
    server.close();
    clearTimeout(waiting);
    connected(speak(socket, handle));
  });
  const waiting = setTimeout(() => process.exit(3), CONNECT_TIMEOUT_MS);
  server.on("error", error => {
    process.stderr.write(`The extension process couldn't listen on its socket: ${describe(error)}\n`);
    process.exit(4);
  });
  server.listen(socketPath);
}

let write: (message: Outgoing) => void = () => {};
const send = (message: Outgoing) => {
  try { write(message); }
  catch (error) {
    const reason = `its answer couldn't be sent: ${describe(error)}`;
    write(message.id !== undefined ? { id: message.id, error: reason } : { warn: { source: "", message: reason } });
  }
};
const asked = new Map<number, { resolve(answer: CompleteAnswer): void; reject(error: Error): void }>();
let nextAsk = 1;
const complete = (request: CompleteRequest, signal: AbortSignal) => new Promise<CompleteAnswer>((resolve, reject) => {
  const ask = nextAsk++;
  const aborted = () => {
    if (!asked.delete(ask)) return;
    send({ cancelAsk: ask });
    reject(new Error("The model call was aborted"));
  };
  asked.set(ask, { resolve: answer => { signal.removeEventListener("abort", aborted); resolve(answer); },
    reject: error => { signal.removeEventListener("abort", aborted); reject(error); } });
  signal.addEventListener("abort", aborted, { once: true });
  send({ ask, complete: request });
  if (signal.aborted) aborted();
});
const worker = new ExtensionWorker({ directory, warn: (source, message) => send({ warn: { source, message } }), complete });
const running = new Map<number, AbortController>();

serve(message => {
  if ("answered" in message) {
    const waiting = asked.get(message.answered);
    asked.delete(message.answered);
    if (!waiting) return;
    if (message.error !== undefined || !message.value) waiting.reject(new Error(message.error ?? "The model call gave no answer"));
    else waiting.resolve(message.value);
    return;
  }
  if ("cancel" in message) {
    running.get(message.cancel)?.abort();
    return;
  }
  const controller = new AbortController();
  running.set(message.id, controller);
  worker.handle(message.method, message.params as never, controller.signal)
    .then(answer => send({ id: message.id, ...answer }), (error: unknown) => send({ id: message.id, error: describe(error) }))
    .finally(() => running.delete(message.id));
}, connected => { write = connected; });
process.on("unhandledRejection", reason => send({ warn: { source: "", message: `a promise failed and nothing handled it: ${describe(reason)}` } }));
