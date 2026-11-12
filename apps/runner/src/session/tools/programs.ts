import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema";
import { gitLimits, gitRequest, gitShellCommand, gitSubcommands, type GitRequest } from "../../git-command.js";
import { CALL_TIMEOUT_MAX_SECONDS, callTimeout } from "../../host-config.js";
import { programLimits } from "../../program-command.js";
import { RunnerError } from "../../protocol.js";
import { pythonPrograms, pythonRequest, pythonShellCommand, type PythonRequest } from "../../python-command.js";
import { commandText, type ToolContext } from "./context.js";

export const callTimeoutParameter = () => opt(int({ minimum: 1, maximum: CALL_TIMEOUT_MAX_SECONDS,
  description: "End it after this many seconds, sooner than the host's command time limit (never later)" }));

export function programTools(context: ToolContext): ToolRegistration[] {
  const { calls, hostCommands } = context;
  return [
    defineTool({ name: "git", description: `Run Git in the session worktree without a shell: args is its arguments as a list, starting with the subcommand (${gitSubcommands.join(", ")}), such as ["commit", "-m", "Fix the parser"]; directory is where it runs, a clone such as app (the worktree by default). Git's own options before the subcommand (-C, -c) and options that run other programs (rebase --exec, clone --upload-pack or --config, --template) aren't taken. It runs with no pager, editor or password prompt. It stops at the host's command time limit, or sooner at timeout_seconds.`,
      executionMode: "sequential",
      parameters: obj({ args: arr(str(), { minItems: 1, maxItems: gitLimits.arguments }), directory: opt(str()), timeout_seconds: callTimeoutParameter() }, { open: true }),
      execute: async (args, api, call) => {
        await context.requireSessionTool("git");
        let request: GitRequest;
        let command: string;
        let timeoutSeconds: number | undefined;
        try { request = gitRequest(args); command = gitShellCommand(request); timeoutSeconds = callTimeout(args.timeout_seconds); }
        catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid git call"}. Nothing ran.`); }
        const attribution = await calls.actor(api, true);
        await hostCommands.requireHostEnvironment();
        const { unbounded } = await calls.check(api, "git", { write: true, shell: true });
        return commandText(context, await context.operations.run(attribution.initiatedBy, { kind: "program", tool: "git", command }, String(api.taskId), { unbounded, timeoutSeconds }, call.abortSignal), api, "git");
      } }),
    ...(process.platform === "win32" && context.sandbox.isolated ? [] : [defineTool({ name: "python", description: `Run Python or its package and test tools in the session worktree without a shell: program is one of ${pythonPrograms.join(", ")}; args is its arguments as a list, such as ["-m", "venv", ".venv"], ["install", "-r", "requirements.txt"] or ["-m", "pytest", "-q"]; directory is where it runs, such as the clone app (the worktree by default); venv names a virtual environment there, such as .venv, whose python3, pip and pytest it runs instead of the host's (make one with python3 -m venv .venv first; the host's own Python can't be installed into; if that fails for want of ensurepip, the host lacks python3-venv, which its owner installs). In the Linux sandbox, uv, uvx, poetry and pytest outside a virtual environment are there only where the host installed them for the whole system: a call to one it lacks is refused, saying how the host's owner installs it. It runs with no colours or prompts; commands that act on a package index as an account (uv publish, uv auth, poetry publish, twine upload, poetry config of credentials) aren't taken. It stops at the host's command time limit, or sooner at timeout_seconds: give one to a run that could wait forever, such as a test suite or a server it starts. Make Unix sockets in /tmp (TMPDIR): the worktree's path leaves too little of a socket path's 107 bytes.`,
      executionMode: "sequential",
      parameters: obj({ program: StringEnum(pythonPrograms), args: opt(arr(str(), { maxItems: programLimits.arguments })), directory: opt(str()),
        venv: opt(str()), timeout_seconds: callTimeoutParameter() }, { open: true }),
      execute: async (args, api, call) => {
        await context.requireSessionTool("python");
        let request: PythonRequest;
        let command: string;
        let timeoutSeconds: number | undefined;
        try { request = pythonRequest(args); command = pythonShellCommand(request); timeoutSeconds = callTimeout(args.timeout_seconds); }
        catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid python call"}. Nothing ran.`); }
        const missing = request.venv ? undefined : context.programMissing({ programs: pythonPrograms, path: "/usr/local/bin" }, request.program);
        if (missing) throw new RunnerError(400, `${missing} Nothing ran.`);
        const attribution = await calls.actor(api, true);
        await hostCommands.requireHostEnvironment();
        const { unbounded } = await calls.check(api, "python", { write: true, shell: true });
        return commandText(context, await context.operations.run(attribution.initiatedBy, { kind: "program", tool: "python", command }, String(api.taskId), { unbounded, timeoutSeconds }, call.abortSignal), api, "python");
      } })]),
  ];
}
