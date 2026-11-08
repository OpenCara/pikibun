import { utilityProcess } from "electron";
import { lines, outputLine, type HostChild } from "./host-process.js";

// The connector host in an Electron utility process: Electron's embedded Node, independent of the RunAsNode fuse, and
// torn down with the app.

/** The host in an Electron utility process, over its parent port. */
export function utilityHost(entry: string, args: string[], env?: NodeJS.ProcessEnv): HostChild {
  const child = utilityProcess.fork(entry, args, { serviceName: "Pikibun Host", stdio: "pipe", ...(env ? { env } : {}) });
  return {
    get pid() { return child.pid; },
    postMessage: message => child.postMessage(message),
    onMessage: listener => { child.on("message", listener); },
    onOutput: listener => { for (const stream of [child.stdout, child.stderr]) lines(stream, outputLine(listener)); },
    // A fatal V8 error (an out-of-memory, say) arrives as "error" before "exit"; unhandled, it would throw in the main process.
    onError: listener => { child.on("error", (type, location) => listener(`The host process failed: ${type} at ${location}`)); },
    onceExit: listener => { child.once("exit", listener); },
    terminate: () => { child.kill(); },
    kill: () => { try { if (child.pid !== undefined) process.kill(child.pid, "SIGKILL"); } catch { /* Already gone. */ } },
  };
}
