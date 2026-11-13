import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { browserActions, browserKeys, browserLimits, browserUnavailableText, type BrowserRequest } from "../../../../../packages/shared/src/browser.js";
import { tunnelActions, tunnelUnavailableText } from "../../../../../packages/shared/src/tunnel.js";
import { EXTENSION_ARGUMENTS_SHOWN, type ExtensionToolOperation } from "../../../../../packages/shared/src/types.js";
import { browserRequest, browserShellCommand, servePrograms } from "../../browser-command.js";
import { programLimits } from "../../program-command.js";
import { RunnerError } from "../../protocol.js";
import { tunnelAccesses, tunnelRequest, type TunnelRequest } from "../../tunnel-command.js";
import { approvalText, text, type ToolContext } from "./context.js";

export function browserTool(context: ToolContext): ToolRegistration {
  const { calls, hostCommands, sandbox } = context;
  return defineTool({ name: "browser", description: "Drive a headless Chromium in the session's sandbox. It opens url (http, https, file, or about:blank; "
    + "without one, the page the last call left), runs actions in order, and answers with the page as it ends: a screenshot, its URL, title, "
    + "HTTP status, visible text, interactive elements each with a CSS selector, console messages, page errors and failed requests. Actions: "
    + "goto {url}; click or hover {selector, or x and y}; type {text, selector?, submit?, clear?}; press {key}; select {selector, value}; "
    + "scroll {selector, or x and y}; wait {selector, text or ms}; evaluate {expression} (JavaScript in the page; its value comes back); "
    + "screenshot {full_page?}; back; forward; reload. A selector is CSS, or text=<visible text>. A failed action stops the rest. "
    + "Each call starts the browser afresh with the session's own profile: cookies and storage persist, open pages and their state don't, "
    + "so do a whole flow in one call. Its network is the sandbox's: other hosts through the session's proxy, as the workspace allows, and "
    + "localhost only within the call, so start the web app under test with serve {program, args, directory?, venv?, port}: one of the node and "
    + `python tools' programs (${servePrograms.join(", ")}), checked as those tools check them and started without a shell, which runs from before `
    + "the page opens until the call ends. Each call's screenshots and report are kept in browser-output/, which the session panel's Browser tab shows. "
    + "It stops at the host's command time limit.",
    executionMode: "sequential",
    parameters: obj({
      url: opt(str()),
      actions: opt(arr(obj({
        action: StringEnum(browserActions),
        selector: opt(str()), url: opt(str()), text: opt(str()),
        key: opt(str({ description: `${browserKeys.join(", ")}, or a single character` })), value: opt(str()), expression: opt(str()),
        x: opt(int()), y: opt(int()), ms: opt(int({ minimum: 0, maximum: browserLimits.waitMs })),
        full_page: opt(bool()), submit: opt(bool()), clear: opt(bool()),
      }, { open: true }), { maxItems: browserLimits.actions })),
      viewport: opt(obj({ width: int(), height: int() }, { open: true })),
      full_page: opt(bool()),
      timeout_seconds: opt(int({ minimum: browserLimits.timeoutSeconds.min, maximum: browserLimits.timeoutSeconds.max })),
      serve: opt(obj({ program: StringEnum([...servePrograms]), args: opt(arr(str(), { maxItems: programLimits.arguments })),
        directory: opt(str()), venv: opt(str()), port: int({ minimum: 1, maximum: 65535 }),
        timeout_seconds: opt(int({ minimum: browserLimits.serveSeconds.min, maximum: browserLimits.serveSeconds.max })) }, { open: true })),
    }, { open: true }),
    execute: async (args, api, call) => {
      await context.requireSessionTool("browser");
      const browser = sandbox.browser;
      if (!browser) throw new RunnerError(400, `This session has no browser: ${browserUnavailableText(context.browserUnavailable() ?? "missing")} Nothing ran.`);
      let request: BrowserRequest;
      let command: string;
      try {
        request = browserRequest(args as Record<string, unknown>);
        command = browserShellCommand(request, browser, { seconds: (await calls.commandOptions()).limits.seconds, nodeBin: sandbox.nodeBin });
      } catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid browser call"}. Nothing ran.`); }
      const attribution = await calls.actor(api, true);
      await hostCommands.requireHostEnvironment();
      const { unbounded } = await calls.check(api, "browser", { write: true, shell: true });
      const approval = await context.operations.run(attribution.initiatedBy, { kind: "program", tool: "browser", command }, String(api.taskId), { unbounded }, call.abortSignal);
      return calls.browserOutcome(approval, () => calls.recheck(attribution), approvalText);
    } });
}

export function tunnelTool(context: ToolContext): ToolRegistration {
  const { calls, hostCommands } = context;
  return defineTool({ name: "tunnel", description: "Put the web server you work on online at a public https:// address, through a Cloudflare quick tunnel (https://<name>.trycloudflare.com). "
    + "start {serve: {program, args, directory?, venv?, port, timeout_seconds?}} runs the server in the session's sandbox as a service that keeps running after the call: "
    + `one of the node and python tools' programs (${servePrograms.join(", ")}), checked as those tools check them and started without a shell, `
    + "listening on port on localhost; once the port answers (within timeout_seconds, 60 by default) cloudflared, on the host, puts it online, and the call answers with the address. "
    + "A start replaces the one online. status gives the address, whether cloudflared is connected, the uptime and the server's last lines of output; stop takes it offline. "
    + "It stays online until stopped, until someone stops the session's work, until the session closes or is archived, or for the host's service lifetime at most. "
    + "It starts only for the host's owner or a member they granted host commands, and isn't taken in a read-only request. "
    + "Only the declared port is reachable through it. By default (access: link) only its link opens it: the address the call answers with carries a secret, which a browser that opens it keeps as a cookie for a day, and the bare address answers 401; anyone the link is given to, and everyone who can read this session, can open it. "
    + "access: public makes it open to anyone with the address, for clients that can't follow a link, such as webhooks.",
    executionMode: "sequential",
    parameters: obj({
      action: StringEnum(tunnelActions),
      access: opt(StringEnum(tunnelAccesses)),
      serve: opt(obj({ program: StringEnum([...servePrograms]), args: opt(arr(str(), { maxItems: programLimits.arguments })),
        directory: opt(str()), venv: opt(str()), port: int({ minimum: 1, maximum: 65535 }),
        timeout_seconds: opt(int({ minimum: browserLimits.serveSeconds.min, maximum: browserLimits.serveSeconds.max })) }, { open: true })),
    }, { open: true }),
    execute: async (args, api, call) => {
      await context.requireSessionTool("tunnel");
      let request: TunnelRequest;
      try { request = tunnelRequest(args); }
      catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid tunnel call"}. Nothing ran.`); }
      if (request.action === "status") {
        const attribution = await calls.actor(api, false);
        return text({ ...attribution, ...(context.tunnel()?.status() ?? { online: false }) });
      }
      const attribution = await calls.actor(api, true);
      if (request.action === "stop") {
        const tunnel = context.tunnel();
        const stopped = tunnel ? await tunnel.stop("stop", attribution.initiatedBy) : { stopped: false };
        return text({ ...attribution, ...stopped, ...(stopped.stopped ? {} : { note: "Nothing was online." }) });
      }
      await context.requireSenderTool("tunnel", attribution.initiatedBy);
      const unavailable = context.tunnelUnavailable() ?? (context.config.tunnels ? undefined : "missing");
      if (unavailable) throw new RunnerError(400, `This session can't put a server online: ${tunnelUnavailableText(unavailable)} Nothing ran.`);
      const state = await context.metadata();
      const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
      if (run.options?.access === "read") {
        throw new RunnerError(403, "Putting a server online is an effect a Read-only message doesn't take: ask in a message that may act. Nothing ran.");
      }
      const json = JSON.stringify({ action: "start", serve: request.serve, access: request.access });
      const operation: ExtensionToolOperation = { kind: "extension.tool", source: "piki:tunnel", tool: "tunnel",
        arguments: json.length > EXTENSION_ARGUMENTS_SHOWN ? `${json.slice(0, EXTENSION_ARGUMENTS_SHOWN)}…` : json,
        digest: createHash("sha256").update(json).digest("hex") };
      await hostCommands.require(attribution.initiatedBy, "Putting a server online with cloudflared");
      const approval = await context.operations.run(attribution.initiatedBy, operation, String(api.taskId), { hostChecked: true }, call.abortSignal);
      if (approval.status !== "executing") throw new RunnerError(409, approval.result ?? "The tunnel didn't start.");
      const id = approval.id;
      try {
        await calls.recheck(attribution);
        const started = await context.startTunnel().start(request.serve!, attribution.initiatedBy, call.abortSignal, request.access);
        await context.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executed", result: context.wholeResults.kept(id, `Online at ${started.url}`) }); });
        return text({ ...attribution, ...started });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await context.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "failed", result: context.wholeResults.kept(id, message) }); }).catch(() => {});
        throw new RunnerError(error instanceof RunnerError ? error.status : 409, message);
      }
    } });
}
