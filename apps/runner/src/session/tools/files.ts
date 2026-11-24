import { defineTool, type JsonObject, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { fileOperationLimits, fileOperationRequest, type FileOperationRequest } from "../../file-operations.js";
import { configuredLimits } from "../../host-config.js";
import { conversationImageLimits, prepareImage, type FileContent } from "../../images.js";
import { RunnerError } from "../../protocol.js";
import { editTarget, findText, GREP_LINE_CHARS, PI_OUTPUT_LIMITS, grepText, imageText, LS_DEFAULT_ENTRIES, lsText, outsideWorktree, PathRefusal, piParameters, prepareEditArguments, readText, runPiEdit,
  worktreePath, type EditInput } from "../../pi-file-tools.js";
import { inScriptCall } from "../../script-output.js";
import { findLimits, findRequest, searchLimits, searchRequest, type FindRequest, type SearchRequest } from "../../search.js";
import { text, type ToolContext } from "./context.js";
import type { ToolAttribution } from "./calls.js";

const OUTSIDE_IN_SANDBOX = ". Every file tool sees only the session's worktree.";
const OUTSIDE_ON_HOST = ". This session runs on its host: read takes an absolute or ~ path to a host file in a message that may run host commands, "
  + "and the other file tools stay in the worktree; reach other host files with a command tool such as python or node.";

const READ_ON_HOST = "Read a worktree file, or, with an absolute or ~ path, a file on this host, as the host's commands would: that only in a message that may "
  + "run host commands (the host's owner's, or a member's they granted host commands), never a Read-only one.";

function worktreeArgument(path: string, onHost: boolean): string {
  try { return worktreePath(path, onHost ? OUTSIDE_ON_HOST : OUTSIDE_IN_SANDBOX); }
  catch (error) { if (error instanceof PathRefusal) throw new RunnerError(400, error.message); throw error; }
}

function rawPath(input: unknown, check: (path: string) => string): void {
  const path = (input as { path?: unknown }).path;
  if (typeof path === "string" && path) check(path);
}

function piResult(attribution: ToolAttribution, text: string, details?: object) {
  return { output: [{ type: "text" as const, text }], details: JSON.parse(JSON.stringify({ ...details, pikibun: attribution })) as JsonObject };
}

export function fileTools(context: ToolContext): ToolRegistration[] {
  const { calls, sandbox, hostCommands } = context;
  const hostReads = context.onHost && !sandbox.isolated && typeof sandbox.readHostContent === "function";
  const inWorktree = (path: string) => worktreeArgument(path, hostReads);
  const readHost = async (path: string, api: ToolExecutionApi) => {
    const attribution = await calls.actor(api, false);
    await calls.check(api, "read", { host: true });
    const what = "Reading a file outside the worktree";
    const recheck = async () => {
      await hostCommands.requireHostEnvironment();
      await hostCommands.require(attribution.initiatedBy, what);
      await calls.recheck(attribution);
    };
    return { attribution, file: await sandbox.readHostContent!(path, recheck) };
  };
  return [
    defineTool({ name: "identity", description: "Return immutable session owner identity and sanitized session environment, not collaborator credentials.", parameters: obj({}, { open: true }), execute: async (_args, api, _call) => {
      const attribution = await calls.actor(api, false);
      await calls.check(api, "identity");
      const config = await context.hostConfig();
      const caches = context.buildCaches ? await context.buildCaches().catch(() => []) : [];
      const commands = { ...(config.commandTimeoutUnlimited ? { timeLimit: "none" } : { timeoutSeconds: configuredLimits(config).seconds }), gpu: config.gpu && !context.onHost,
        ...(context.onHost ? { onHost: true } : {}),
        ...(caches.length ? { buildCaches: caches.map(cache => ({ name: cache.name, env: cache.env, path: cache.target, scope: cache.scope })) } : {}) };
      return text({ ...await sandbox.identity(() => calls.recheck(attribution)), commands, ...attribution });
    } }),
    defineTool({ name: "read", parameters: piParameters.read, outputLimits: PI_OUTPUT_LIMITS,
      description: `${hostReads ? READ_ON_HOST : "Read a confined worktree file."} A text file comes as it is, cut at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever comes first, with a note that says where to continue; offset (the first line, from 1) and limit (how many lines) read only part of it. PNG, JPEG, GIF and WebP images are returned as images, scaled to fit. Use grep to find where to look, then read around it.`,
      execute: async (input, api, _call) => {
        const args = input as { path: string; offset?: number; limit?: number };
        let attribution: ToolAttribution;
        let file: FileContent;
        if (hostReads && outsideWorktree(args.path)) ({ attribution, file } = await readHost(args.path, api));
        else {
          const path = inWorktree(args.path);
          attribution = await calls.actor(api, false);
          await calls.check(api, "read");
          file = await sandbox.readContent(path, () => calls.recheck(attribution));
        }
        if ("text" in file) {
          let read: ReturnType<typeof readText>;
          try { read = readText(file.text, args.offset, args.limit, inScriptCall()); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid range"); }
          return piResult(attribution, read.text, read.details);
        }
        const prepared = await prepareImage(file.image, await conversationImageLimits(api));
        if ("error" in prepared) return { output: [], isError: true, diagnostics: [{ severity: "error" as const, code: "image", message: prepared.error }] };
        const { image } = prepared;
        return { output: [{ type: "text" as const, text: imageText(image.mimeType) }, { type: "image" as const, data: image.data, mimeType: image.mimeType }], details: { pikibun: attribution } };
      } }),
    defineTool({ name: "ls", parameters: piParameters.ls, outputLimits: PI_OUTPUT_LIMITS,
      description: `List a worktree directory, the worktree's top by default: one entry a line, sorted without regard to case, with / after a directory, dotfiles included. Links are listed as they are, never followed. At most ${LS_DEFAULT_ENTRIES} entries unless limit says otherwise.`,
      execute: async (input, api, _call) => {
        const args = input as { path?: string; limit?: number };
        inWorktree(args.path ?? ".");
        const attribution = await calls.actor(api, false);
        await calls.check(api, "ls");
        const listed = lsText(await sandbox.listEntries(inWorktree(args.path?.replace(/\/+$/, "") || "."), () => calls.recheck(attribution)), args.limit);
        return piResult(attribution, listed.text, listed.details);
      } }),
    defineTool({ name: "grep", parameters: piParameters.grep, outputLimits: PI_OUTPUT_LIMITS,
      description: `Search the worktree's text files for a regular expression (or, with literal, exact text), as grep -rn does, without a shell. path narrows it to a directory or one file; glob picks files relative to path: one without / matches file names at any depth (*.ts), one with / matches paths (src/**/*.ts). context adds up to ${searchLimits.context} lines around each match; ignoreCase; limit (${searchLimits.defaultResults} matches by default, at most ${searchLimits.maxResults}). It skips .git directories as it walks, and node_modules unless all is true; links, binary and non-UTF-8 files and files over 1 MB are skipped, and .gitignore isn't read. Each match is path:line: text and each context line path-line- text, with paths relative to path; lines over ${GREP_LINE_CHARS} characters are cut. Then read with offset and limit reads around a match.`,
      execute: async (input, api, _call) => {
        let request: SearchRequest;
        try { rawPath(input, inWorktree); request = searchRequest(input as Record<string, unknown>); inWorktree(request.path); }
        catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid search"); }
        const attribution = await calls.actor(api, false);
        await calls.check(api, "grep");
        const found = grepText(await sandbox.search(request, () => calls.recheck(attribution)), request.path, request.maxResults, searchLimits.maxResults);
        return piResult(attribution, found.text, found.details);
      } }),
    defineTool({ name: "find", parameters: piParameters.find, outputLimits: PI_OUTPUT_LIMITS,
      description: `Find files and directories in the worktree by glob, without a shell. A pattern without / matches names at any depth (*.ts, *.{ts,tsx}); one with / matches paths below path (src/**/*.spec.ts); an all-lowercase pattern matches either case. path is the directory to search (the worktree's top by default). Each result is a path from path, one a line, with / after a directory; ${findLimits.defaultResults} unless limit (at most ${findLimits.maxResults}). It skips .git directories, and node_modules unless all is true; links are listed, never followed, and .gitignore isn't read.`,
      execute: async (input, api, _call) => {
        let request: FindRequest;
        try { rawPath(input, inWorktree); request = findRequest(input as Record<string, unknown>); inWorktree(request.path); }
        catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid find"); }
        const attribution = await calls.actor(api, false);
        await calls.check(api, "find");
        const found = findText(await sandbox.find(request, () => calls.recheck(attribution)), request.maxResults, findLimits.maxResults);
        return piResult(attribution, found.text, found.details);
      } }),
    defineTool({ name: "write", executionMode: "sequential", parameters: piParameters.write,
      description: "Write a confined worktree file: it is created if it doesn't exist and overwritten if it does, and the directories it needs are made. A Read-only message's call is refused.",
      execute: async (input, api, _call) => {
        const args = input as { path: string; content: string };
        const attribution = await calls.actor(api, true);
        await calls.check(api, "write", { write: true });
        await sandbox.writeFile(inWorktree(args.path), args.content, () => calls.recheck(attribution));
        return piResult(attribution, `Successfully wrote to ${args.path}`);
      } }),
    defineTool({ name: "edit", executionMode: "sequential", parameters: piParameters.edit, prepareArguments: prepareEditArguments as never,
      description: "Edit a confined worktree text file by exact replacement, without rewriting it. Each edits[].oldText must match a unique, non-overlapping region of the file as it was, and the edits apply together; if two changes touch the same block or nearby lines, merge them into one edit. Where oldText isn't found as it is, it is tried again ignoring trailing whitespace and quote and dash styles. The file keeps its line endings and byte order mark, and the result has the diff. A Read-only message's call is refused.",
      execute: async (input, api, call) => {
        const args = input as EditInput;
        try { editTarget(args.path); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid path"); }
        const attribution = await calls.actor(api, true);
        await calls.check(api, "edit", { write: true });
        const recheck = () => calls.recheck(attribution);
        const edited = await runPiEdit(args, { read: () => sandbox.readFile(args.path, recheck), write: content => sandbox.writeFile(args.path, content, recheck) }, call.abortSignal);
        return piResult(attribution, edited.text, edited.details);
      } }),
    ...(["move_file", "copy_file"] as const).map(name => defineTool({ name, executionMode: "sequential",
      description: name === "move_file"
        ? "Move or rename a file, directory or link in the worktree, without a shell (like write): from and to are worktree paths. A link is moved itself, never what it points to. The destination must not exist, its directories are made, and a directory can't go inside itself; nothing in .git is moved. A Read-only message's call is refused."
        : `Copy a file, or a directory with everything in it, in the worktree, without a shell (like write): from and to are worktree paths. Links are copied as links. The destination must not exist and its directories are made; at most ${fileOperationLimits.entries} entries and ${fileOperationLimits.bytes / 1024 / 1024} MB of files, never a repository's .git (clone it again instead). A Read-only message's call is refused.`,
      parameters: obj({ from: str(), to: str() }, { open: true }),
      execute: async (args, api, _call) => {
        let request: FileOperationRequest;
        try { request = fileOperationRequest(name === "move_file" ? "move" : "copy", args); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid file operation"); }
        const attribution = await calls.actor(api, true);
        await calls.check(api, name, { write: true });
        const result = await sandbox.fileOperation(request, () => calls.recheck(attribution));
        return text({ ...attribution, ...(name === "move_file" ? { moved: args.from, to: args.to } : { copied: args.from, to: args.to, ...result }) });
      } })),
    defineTool({ name: "delete_file", executionMode: "sequential",
      description: "Delete a file, link or directory in the worktree, without a shell (like write). A link is deleted itself, never what it points to. A directory with anything in it is deleted only with recursive: true, everything in it included. Never .git or the worktree itself. A Read-only message's call is refused.",
      parameters: obj({ path: str(), recursive: opt(bool()) }, { open: true }),
      execute: async (args, api, _call) => {
        let request: FileOperationRequest;
        try { request = fileOperationRequest("delete", args); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid file operation"); }
        const attribution = await calls.actor(api, true);
        await calls.check(api, "delete_file", { write: true });
        const result = await sandbox.fileOperation(request, () => calls.recheck(attribution));
        return text({ ...attribution, deleted: args.path, entries: result.entries });
      } }),
  ];
}
