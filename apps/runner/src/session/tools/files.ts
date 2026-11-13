import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { fileOperationLimits, fileOperationRequest, type FileOperationRequest } from "../../file-operations.js";
import { commandLimits } from "../../host-config.js";
import { prepareImage } from "../../images.js";
import { RunnerError } from "../../protocol.js";
import { editTarget, GREP_LINE_CHARS, PI_OUTPUT_LIMITS, grepText, imageText, LS_DEFAULT_ENTRIES, lsText, PathRefusal, piParameters, prepareEditArguments, readText, runPiEdit,
  worktreePath, type EditInput } from "../../pi-file-tools.js";
import { inScriptCall } from "../../script-output.js";
import { searchLimits, searchRequest, type SearchRequest } from "../../search.js";
import { text, type ToolContext } from "./context.js";
import type { ToolAttribution } from "./calls.js";

function worktreeArgument(path: string): string {
  try { return worktreePath(path); } catch (error) { if (error instanceof PathRefusal) throw new RunnerError(400, error.message); throw error; }
}

function piResult(attribution: ToolAttribution, text: string, details?: object) {
  return { output: [{ type: "text" as const, text }], details: JSON.parse(JSON.stringify({ ...details, pikibun: attribution })) as JsonObject };
}

export function fileTools(context: ToolContext): ToolRegistration[] {
  const { calls, sandbox } = context;
  return [
    defineTool({ name: "identity", description: "Return immutable session owner identity and sanitized session environment, not collaborator credentials.", parameters: obj({}, { open: true }), execute: async (_args, api, _call) => {
      const attribution = await calls.actor(api, false);
      await calls.check(api, "identity");
      const config = await context.hostConfig();
      const commands = { timeoutSeconds: commandLimits(config.commandTimeoutSeconds).seconds, gpu: config.gpu && !context.onHost,
        ...(context.onHost ? { onHost: true } : {}) };
      return text({ ...await sandbox.identity(() => calls.recheck(attribution)), commands, ...attribution });
    } }),
    defineTool({ name: "read_file", parameters: piParameters.read, outputLimits: PI_OUTPUT_LIMITS,
      description: `Read a confined worktree file. A text file comes as it is, cut at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever comes first, with a note that says where to continue; offset (the first line, from 1) and limit (how many lines) read only part of it. PNG, JPEG, GIF and WebP images are returned as images, scaled to fit. Use search to find where to look, then read around it.`,
      execute: async (input, api, _call) => {
        const args = input as { path: string; offset?: number; limit?: number };
        const attribution = await calls.actor(api, false);
        await calls.check(api, "read_file");
        const file = await sandbox.readContent(worktreeArgument(args.path), () => calls.recheck(attribution));
        if ("text" in file) {
          let read: ReturnType<typeof readText>;
          try { read = readText(file.text, args.offset, args.limit, inScriptCall()); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid range"); }
          return piResult(attribution, read.text, read.details);
        }
        const prepared = await prepareImage(file.image, file.mimeType);
        if ("error" in prepared) return { output: [], isError: true, diagnostics: [{ severity: "error" as const, code: "image", message: prepared.error }] };
        const { image } = prepared;
        return { output: [{ type: "text" as const, text: imageText(image.mimeType) }, { type: "image" as const, data: image.data, mimeType: image.mimeType }], details: { pikibun: attribution } };
      } }),
    defineTool({ name: "list_files", parameters: piParameters.ls, outputLimits: PI_OUTPUT_LIMITS,
      description: `List a worktree directory, the worktree's top by default: one entry a line, sorted without regard to case, with / after a directory, dotfiles included. Links are listed as they are, never followed. At most ${LS_DEFAULT_ENTRIES} entries unless limit says otherwise.`,
      execute: async (input, api, _call) => {
        const args = input as { path?: string; limit?: number };
        const attribution = await calls.actor(api, false);
        await calls.check(api, "list_files");
        const listed = lsText(await sandbox.listEntries(worktreeArgument(args.path?.replace(/\/+$/, "") || "."), () => calls.recheck(attribution)), args.limit);
        return piResult(attribution, listed.text, listed.details);
      } }),
    defineTool({ name: "search", parameters: piParameters.grep, outputLimits: PI_OUTPUT_LIMITS,
      description: `Search the worktree's text files for a regular expression (or, with literal, exact text), as grep -rn does, without a shell. path narrows it to a directory or one file; glob picks files relative to path: one without / matches file names at any depth (*.ts), one with / matches paths (src/**/*.ts). context adds up to ${searchLimits.context} lines around each match; ignoreCase; limit (${searchLimits.defaultResults} matches by default, at most ${searchLimits.maxResults}). It skips .git directories as it walks, and node_modules unless all is true; links, binary and non-UTF-8 files and files over 1 MB are skipped, and .gitignore isn't read. Each match is path:line: text and each context line path-line- text, with paths relative to path; lines over ${GREP_LINE_CHARS} characters are cut. Then read_file with offset and limit reads around a match.`,
      execute: async (input, api, _call) => {
        let request: SearchRequest;
        try { request = searchRequest(input as Record<string, unknown>); worktreeArgument(request.path); }
        catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid search"); }
        const attribution = await calls.actor(api, false);
        await calls.check(api, "search");
        const found = grepText(await sandbox.search(request, () => calls.recheck(attribution)), request.path, request.maxResults, searchLimits.maxResults);
        return piResult(attribution, found.text, found.details);
      } }),
    defineTool({ name: "write_file", executionMode: "sequential", parameters: piParameters.write,
      description: "Write a confined worktree file: it is created if it doesn't exist and overwritten if it does, and the directories it needs are made. A Read-only message's call is refused.",
      execute: async (input, api, _call) => {
        const args = input as { path: string; content: string };
        const attribution = await calls.actor(api, true);
        await calls.check(api, "write_file", { write: true });
        await sandbox.writeFile(worktreeArgument(args.path), args.content, () => calls.recheck(attribution));
        return piResult(attribution, `Successfully wrote to ${args.path}`);
      } }),
    defineTool({ name: "edit_file", executionMode: "sequential", parameters: piParameters.edit, prepareArguments: prepareEditArguments as never,
      description: "Edit a confined worktree text file by exact replacement, without rewriting it. Each edits[].oldText must match a unique, non-overlapping region of the file as it was, and the edits apply together; if two changes touch the same block or nearby lines, merge them into one edit. Where oldText isn't found as it is, it is tried again ignoring trailing whitespace and quote and dash styles. The file keeps its line endings and byte order mark, and the result has the diff. A Read-only message's call is refused.",
      execute: async (input, api, call) => {
        const args = input as EditInput;
        try { editTarget(args.path); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid path"); }
        const attribution = await calls.actor(api, true);
        await calls.check(api, "edit_file", { write: true });
        const recheck = () => calls.recheck(attribution);
        const edited = await runPiEdit(args, { read: () => sandbox.readFile(args.path, recheck), write: content => sandbox.writeFile(args.path, content, recheck) }, call.abortSignal);
        return piResult(attribution, edited.text, edited.details);
      } }),
    ...(["move_file", "copy_file"] as const).map(name => defineTool({ name, executionMode: "sequential",
      description: name === "move_file"
        ? "Move or rename a file, directory or link in the worktree, without a shell (like write_file): from and to are worktree paths. A link is moved itself, never what it points to. The destination must not exist, its directories are made, and a directory can't go inside itself; nothing in .git is moved. A Read-only message's call is refused."
        : `Copy a file, or a directory with everything in it, in the worktree, without a shell (like write_file): from and to are worktree paths. Links are copied as links. The destination must not exist and its directories are made; at most ${fileOperationLimits.entries} entries and ${fileOperationLimits.bytes / 1024 / 1024} MB of files, never a repository's .git (clone it again instead). A Read-only message's call is refused.`,
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
      description: "Delete a file, link or directory in the worktree, without a shell (like write_file). A link is deleted itself, never what it points to. A directory with anything in it is deleted only with recursive: true, everything in it included. Never .git or the worktree itself. A Read-only message's call is refused.",
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
