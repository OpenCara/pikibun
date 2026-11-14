import { createServer, type Socket } from "node:net";
import { ExtensionWorker } from "./worker.js";
import type { ExtensionMethod } from "./protocol.js";
import { lineReader } from "./lines.js";

type Incoming = { id: number; method: ExtensionMethod; params: Record<string, unknown> } | { cancel: number };
type Outgoing = { id?: number } & Record<string, unknown>;

const CONNECT_TIMEOUT_MS = 60_000;
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const directory = process.argv.at(-1);
const socketAt = process.argv.indexOf("--socket");
const socketPath = socketAt >= 0 ? process.argv[socketAt + 1] : undefined;
if (!directory || (!socketPath && !process.send)) {
  process.stderr.write("The extension process is started by the connector, with an IPC channel or a socket, and its session's directory.\n");
  process.exit(2);
}

function serve(handle: (message: Incoming) => void, connected: (write: (message: Outgoing) => void) => void): void {
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
    socket.on("data", lineReader(line => {
      let message: Incoming;
      try { message = JSON.parse(line) as Incoming; } catch { return; }
      handle(message);
    }, () => socket.destroy()));
    socket.on("close", () => process.exit(0));
    socket.on("error", () => process.exit(0));
    connected(message => { socket.write(`${JSON.stringify(message)}\n`); });
  });
  const waiting = setTimeout(() => process.exit(3), CONNECT_TIMEOUT_MS);
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
const worker = new ExtensionWorker({ directory, warn: (source, message) => send({ warn: { source, message } }) });
const running = new Map<number, AbortController>();

serve(message => {
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
