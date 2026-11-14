import { ExtensionWorker } from "./worker.js";
import type { ExtensionMethod } from "./protocol.js";

type Incoming = { id: number; method: ExtensionMethod; params: Record<string, unknown> } | { cancel: number };

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const directory = process.argv.at(-1);
if (!directory || !process.send) {
  process.stderr.write("The extension process is started by the connector, with an IPC channel and its session's directory.\n");
  process.exit(2);
}

const send = (message: { id?: number } & Record<string, unknown>) => {
  try { process.send?.(message); }
  catch (error) {
    const reason = `its answer couldn't be sent: ${describe(error)}`;
    process.send?.(message.id !== undefined ? { id: message.id, error: reason } : { warn: { source: "", message: reason } });
  }
};
const worker = new ExtensionWorker({ directory, warn: (source, message) => send({ warn: { source, message } }) });
const running = new Map<number, AbortController>();

process.on("message", (message: Incoming) => {
  if ("cancel" in message) {
    running.get(message.cancel)?.abort();
    return;
  }
  const controller = new AbortController();
  running.set(message.id, controller);
  worker.handle(message.method, message.params as never, controller.signal)
    .then(answer => send({ id: message.id, ...answer }), (error: unknown) => send({ id: message.id, error: describe(error) }))
    .finally(() => running.delete(message.id));
});
process.on("unhandledRejection", reason => send({ warn: { source: "", message: `a promise failed and nothing handled it: ${describe(reason)}` } }));
process.on("disconnect", () => process.exit(0));
