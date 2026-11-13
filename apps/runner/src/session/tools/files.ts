import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { lineRange, applyEdits } from "../../edits.js";
import { fileOperationLimits, fileOperationRequest, type FileOperationRequest } from "../../file-operations.js";
import { commandLimits } from "../../host-config.js";
import { prepareImage } from "../../images.js";
import { RunnerError } from "../../protocol.js";
import { searchLimits, searchRequest, type SearchRequest } from "../../search.js";
import { text, type ToolContext } from "./context.js";

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
    defineTool({ name: "read_file", description: "Read a confined worktree file. PNG, JPEG, GIF and WebP images are returned as images, scaled to fit. For a text file, offset (the first line, from 1) and limit (how many lines) read only part of it, and the result says which lines of how many it holds: use search to find where to look, then read around it.",
      parameters: obj({ path: str(), offset: opt(int({ minimum: 1 })), limit: opt(int({ minimum: 1 })) }, { open: true }), execute: async (args, api, _call) => {
      const attribution = await calls.actor(api, false);
      await calls.check(api, "read_file");
      const file = await sandbox.readContent(args.path, () => calls.recheck(attribution));
      if ("text" in file && (args.offset !== undefined || args.limit !== undefined)) return text({ ...attribution, ...lineRange(file.text, args.offset, args.limit) });
      if ("text" in file) return text({ ...attribution, content: file.text });
      const prepared = await prepareImage(file.image, file.mimeType);
      if ("error" in prepared) return { output: [], isError: true, diagnostics: [{ severity: "error" as const, code: "image", message: prepared.error }] };
      const { image } = prepared;
      return { output: [
        { type: "text" as const, text: JSON.stringify({ ...attribution, path: args.path, mimeType: image.mimeType, width: image.width, height: image.height }) },
        { type: "image" as const, data: image.data, mimeType: image.mimeType },
      ] };
    } }),
    defineTool({ name: "list_files", description: "List confined worktree files.", parameters: obj({ path: opt(str()) }, { open: true }), execute: async (args, api, _call) => {
      const attribution = await calls.actor(api, false);
      await calls.check(api, "list_files");
      return text({ ...attribution, files: await sandbox.listFiles(args.path, () => calls.recheck(attribution)) });
    } }),
    defineTool({ name: "search", description: "Search the worktree's text files for a regular expression (or, with literal, exact text), line by line, as grep -rn does, without a shell. path narrows it to a directory or one file; glob to file names (*.ts) or paths (apps/**/*.ts); context adds up to 5 lines around each match; ignore_case; max_results (100 by default, at most 500). It skips .git directories as it walks, and node_modules unless all is true; links, binary and non-UTF-8 files and files over 1 MB are skipped. Results give each match's path, line number and text; truncated says it stopped early. Then read_file with offset and limit reads around a match.",
      parameters: obj({ pattern: str(), path: opt(str()), glob: opt(str()), literal: opt(bool()),
        ignore_case: opt(bool()), context: opt(int({ minimum: 0, maximum: searchLimits.context })),
        max_results: opt(int({ minimum: 1, maximum: searchLimits.maxResults })), all: opt(bool()) }, { open: true }),
      execute: async (args, api, _call) => {
        let request: SearchRequest;
        try { request = searchRequest(args); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid search"); }
        const attribution = await calls.actor(api, false);
        await calls.check(api, "search");
        return text({ ...attribution, ...await sandbox.search(request, () => calls.recheck(attribution)) });
      } }),
    defineTool({ name: "write_file", description: "Write a confined worktree file. A Read-only message's call is refused.", executionMode: "sequential", parameters: obj({ path: str(), content: str() }, { open: true }), execute: async (args, api, _call) => {
      const attribution = await calls.actor(api, true);
      await calls.check(api, "write_file", { write: true });
      await sandbox.writeFile(args.path, args.content, () => calls.recheck(attribution));
      return text({ ...attribution, written: args.path });
    } }),
    defineTool({ name: "edit_file", executionMode: "sequential",
      description: "Edit a confined worktree text file by exact replacement, without rewriting it. Each edits[].oldText must occur exactly once in the file, including whitespace and line breaks; edits are matched against the file as it was, must not overlap, and apply together. A Read-only message's call is refused.",
      parameters: obj({ path: str(), edits: arr(obj({ oldText: str(), newText: str() }, { open: true }), { minItems: 1 }) }, { open: true }),
      execute: async (args, api, _call) => {
        const attribution = await calls.actor(api, true);
        await calls.check(api, "edit_file", { write: true });
        const recheck = () => calls.recheck(attribution);
        await sandbox.writeFile(args.path, applyEdits(await sandbox.readFile(args.path, recheck), args.edits, args.path), recheck);
        return text({ ...attribution, edited: args.path, edits: args.edits.length });
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
