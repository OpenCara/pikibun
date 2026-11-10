import type { BrowserServe } from "../../../packages/shared/src/browser.js";
import { tunnelActions, type TunnelAction } from "../../../packages/shared/src/tunnel.js";
import { serveRequest } from "./browser-command.js";

export interface TunnelRequest {
  action: TunnelAction;
  serve?: BrowserServe;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function tunnelRequest(input: unknown): TunnelRequest {
  if (!object(input)) throw new Error("the tunnel tool takes {action, serve?}");
  for (const key of Object.keys(input)) if (key !== "action" && key !== "serve" && input[key] !== undefined) throw new Error(`the tunnel tool takes action and serve, not ${key}`);
  if (typeof input.action !== "string" || !(tunnelActions as readonly string[]).includes(input.action)) throw new Error(`action is one of ${tunnelActions.join(", ")}`);
  const action = input.action as TunnelAction;
  if (action !== "start") {
    if (input.serve !== undefined) throw new Error(`${action} takes nothing else: serve goes with start`);
    return { action };
  }
  if (input.serve === undefined) throw new Error("start needs serve {program, args?, directory?, venv?, port}: the server to put online");
  return { action, serve: serveRequest(input.serve) };
}

export function serveCommand(serve: BrowserServe): string {
  return [serve.program, ...(serve.args ?? [])].join(" ").slice(0, 2000);
}
