import type { BrowserServe } from "../../../packages/shared/src/browser.js";
import { tunnelActions, type TunnelAction } from "../../../packages/shared/src/tunnel.js";
import { serveRequest } from "./browser-command.js";

export const tunnelAccesses = Object.freeze(["link", "public"] as const);
export type TunnelAccess = (typeof tunnelAccesses)[number];

export interface TunnelRequest {
  action: TunnelAction;
  serve?: BrowserServe;
  access?: TunnelAccess;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function tunnelRequest(input: unknown): TunnelRequest {
  if (!object(input)) throw new Error("the tunnel tool takes {action, serve?, access?}");
  for (const key of Object.keys(input)) if (key !== "action" && key !== "serve" && key !== "access" && input[key] !== undefined) throw new Error(`the tunnel tool takes action, serve and access, not ${key}`);
  if (typeof input.action !== "string" || !(tunnelActions as readonly string[]).includes(input.action)) throw new Error(`action is one of ${tunnelActions.join(", ")}`);
  const action = input.action as TunnelAction;
  if (action !== "start") {
    if (input.serve !== undefined || input.access !== undefined) throw new Error(`${action} takes nothing else: serve and access go with start`);
    return { action };
  }
  if (input.serve === undefined) throw new Error("start needs serve {program, args?, directory?, venv?, port}: the server to put online");
  if (input.access !== undefined && !(tunnelAccesses as readonly unknown[]).includes(input.access)) throw new Error(`access is ${tunnelAccesses.join(" or ")}`);
  return { action, serve: serveRequest(input.serve), access: (input.access as TunnelAccess | undefined) ?? "link" };
}

export function serveCommand(serve: BrowserServe): string {
  return [serve.program, ...(serve.args ?? [])].join(" ").slice(0, 2000);
}
