import { builtinExtensions } from "./host-config.js";
import { parseExtensionSourceSpec, type ExtensionToolMode, type InstalledExtension, type WorkspaceExtension } from "./host-extensions.js";
import { pikiExtension, pikiSessionToolExtensions } from "./piki-extensions.js";

/*
 * The tools a workspace's sessions can use, as its Extensions page lists them (docs/extensions.md): the session's own,
 * which its session-tool extensions turn on or off; Pi's built-in code mode, in every session; and the tools of its
 * enabled extensions, as its hosts report them. It follows the runner's rules for names: an extension's tool named like
 * one of the session's own (on or off), or like one an earlier extension in the workspace's order offers, is left out
 * (settleToolNames), and an extension's tool named like a built-in's replaces the built-in (SessionBuiltins.select).
 * Each host offers what it can of them: not the browser without Chromium, say, nor an extension it hasn't installed; and
 * it may add the extensions its owner requires of every session there, or their own dev extensions.
 */

/** What Pikibun's own tools do, for people: the session's own tools and the built-in code mode's. The model reads its own, longer, descriptions. */
export const pikibunToolDescriptions: Readonly<Record<string, string>> = Object.freeze({
  identity: "Tells the agent who the session is for: its owner's identity and the session's APP_ environment.",
  list_files: "Lists the session's files.",
  read_file: "Reads a session file, or some of its lines; images go to the model as images.",
  search: "Searches the worktree's text files for a regular expression or text, like grep -rn.",
  write_file: "Writes a whole file.",
  edit_file: "Replaces exact text in a file, in place.",
  move_file: "Moves or renames a file, directory or link in the worktree.",
  copy_file: "Copies a file, directory or link in the worktree.",
  delete_file: "Deletes a file, directory or link in the worktree.",
  git: "Runs Git in a clone, its arguments as a list, without a shell.",
  git_push: "Pushes a clone's checked-out commit to a branch, optionally opening a pull request, or tags a commit already on one.",
  node: "Runs Node.js or a package manager (node, npm, npx, pnpm, yarn, corepack) in a clone, without a shell.",
  python: "Runs Python or its package and test tools (python3, pip, uv, poetry, pytest), without a shell.",
  rust: "Runs cargo, rustc, rustup or rustfmt in a clone, without a shell.",
  go: "Runs go or gofmt in a clone, without a shell.",
  dotnet: "Runs the .NET CLI in a clone, without a shell.",
  browser: "Drives a headless Chromium in the sandbox: opens a page, acts on it and sees it, serving the web app under test for the call.",
  github_read: "Reads a GitHub issue or pull request, or waits for its checks or a change.",
  github_comment: "Comments on a GitHub issue or pull request, as the session owner.",
  github_issue: "Opens a GitHub issue, as the session owner.",
  github_merge: "Merges a GitHub pull request, as the session owner.",
  source_read: "Reads an item of the workspace's document sources, as the session owner.",
  schedule: "Lists, creates, changes and deletes the session's scheduled prompts.",
  sessions: "Lists, reads, messages, starts, stops and archives the workspace's other sessions, as the message's sender.",
  codemode: "Runs JavaScript that calls the session's tools, to batch, chain and filter their calls.",
});

/**
 * Where a tool comes from: the session's own (a session-tool extension, `piki:files` ...), a Pi built-in in every
 * session (`pi:codemode`), or one of the workspace's extensions, which runs on the host, outside the sandbox.
 */
export type WorkspaceToolOrigin = "session" | "builtin" | "extension";

export interface WorkspaceTool {
  name: string;
  /** The extension it comes with. */
  source: string;
  origin: WorkspaceToolOrigin;
  /** What it does: Pikibun's own words for its own tools, the extension's (as a host reports it) for an extension's. */
  description: string;
  /** An extension's tool: whether its calls wait for an approval or may run automatically, as the workspace set it. */
  mode?: ExtensionToolMode;
}

/** What an extension offers, as a host that has it at that version reports it or, for Pikibun's own, as this version knows it. */
export interface ExtensionOffer {
  description?: string;
  /** Its tools; none for one that only adds prompt text or hooks. */
  tools: { name: string; description: string }[];
}

export interface WorkspaceTools {
  /**
   * The tools sessions can use: the session's own that are on (the file tools first), then the built-in ones, then the
   * extensions', in the workspace's order.
   */
  tools: WorkspaceTool[];
  /** The session's own tools the workspace turned off, with the extension that turns them on. */
  off: { name: string; source: string }[];
  /**
   * Tools sessions leave out (`source`'s) because another (`by`) has the name: an enabled extension's, named like one of
   * the session's own or an earlier extension's, or a built-in's (`pi:codemode`), which an extension's of its name replaces.
   */
  shadowed: { name: string; source: string; by: string }[];
  /** Enabled extensions none of the hosts has reported, whose tools aren't known yet. */
  unreported: string[];
}

/**
 * What `source` offers: as the first of `installed` (hosts' reports, in order) that has it at that version and loads it
 * reports it; for one of Pikibun's own, as this version knows it where no host reports it. Undefined while neither does.
 */
export function extensionOffer(source: string, installed: readonly InstalledExtension[]): ExtensionOffer | undefined {
  const piki = pikiExtension(source);
  if (piki?.sessionTools) return { description: piki.description, tools: piki.sessionTools.map(name => ({ name, description: pikibunToolDescriptions[name] ?? "" })) };
  const reported = installed.find(item => item.source === source && !item.error);
  if (reported) {
    const tools = new Map<string, string>();
    for (const tool of reported.modules.flatMap(module => module.tools)) if (!tools.has(tool.name)) tools.set(tool.name, tool.description);
    return { description: piki?.description ?? reported.description, tools: [...tools].map(([name, description]) => ({ name, description })) };
  }
  if (piki) return { description: piki.description, tools: piki.tool ? [{ name: piki.tool, description: piki.description }] : [] };
  return undefined;
}

/** The tools `extensions` (a workspace's) give its sessions, with `installed` its hosts' reports, in order. */
export function workspaceTools(extensions: readonly WorkspaceExtension[], installed: readonly InstalledExtension[]): WorkspaceTools {
  const tools: WorkspaceTool[] = [];
  const off: WorkspaceTools["off"] = [];
  // The session's own tools, on or off, keep their names from every extension (SessionExtensions' reserved names). The
  // ones every session has (the file tools) lead.
  const owners = new Map<string, string>();
  const own = pikiSessionToolExtensions().filter(item => !item.retired);
  for (const extension of [...own.filter(item => item.core), ...own.filter(item => !item.core)]) {
    const on = extension.core || !extensions.some(item => item.source === extension.source && !item.enabled);
    for (const name of extension.sessionTools ?? []) {
      if (owners.has(name)) continue;
      owners.set(name, extension.source);
      if (on) tools.push({ name, source: extension.source, origin: "session", description: pikibunToolDescriptions[name] ?? "" });
      else off.push({ name, source: extension.source });
    }
  }
  const shadowed: WorkspaceTools["shadowed"] = [];
  const unreported: string[] = [];
  const offered: WorkspaceTool[] = [];
  const sessionToolSources = new Set<string>(pikiSessionToolExtensions().map(item => item.source));
  for (const extension of extensions.filter(item => item.enabled && !sessionToolSources.has(item.source))) {
    const offer = extensionOffer(extension.source, installed);
    if (!offer) { unreported.push(extension.source); continue; }
    for (const tool of offer.tools) {
      const by = owners.get(tool.name);
      if (by) { if (by !== extension.source) shadowed.push({ name: tool.name, source: extension.source, by }); continue; }
      owners.set(tool.name, extension.source);
      offered.push({ name: tool.name, source: extension.source, origin: "extension", description: tool.description, mode: extension.tools });
    }
  }
  // Built-ins every session runs, unless an extension offers a tool of the same name, which replaces it.
  for (const builtin of builtinExtensions.filter(item => "core" in item && item.core)) {
    for (const name of builtin.tools) {
      const by = owners.get(name);
      if (by) shadowed.push({ name, source: builtin.name, by });
      else tools.push({ name, source: builtin.name, origin: "builtin", description: pikibunToolDescriptions[name] ?? builtin.description });
    }
  }
  return { tools: [...tools, ...offered], off, shadowed, unreported };
}

/** A short name for the extension `source` names: Pikibun's or Pi's built-in's title, an npm package's name, a Git repository's. */
export function extensionLabel(source: string): string {
  const builtin = builtinExtensions.find(item => item.name === source);
  if (builtin) return builtin.title;
  try {
    const spec = parseExtensionSourceSpec(source);
    if (spec.kind === "piki") return pikiExtension(source)?.title ?? source;
    if (spec.kind === "npm") return spec.package;
    return spec.url.slice(spec.url.lastIndexOf("/") + 1) || source;
  } catch { return source; }
}

/** The start of a tool's or extension's description, for a line in a list: its first paragraph, cut to about `limit` characters. */
export function descriptionSummary(description: string, limit = 200): string {
  const first = description.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ");
  if (first.length <= limit) return first;
  const sentence = first.slice(0, limit + 1).match(/^.*[.!?](?=\s)/)?.[0];
  if (sentence && sentence.length >= limit / 2) return sentence;
  const cut = first.slice(0, limit);
  return `${cut.slice(0, cut.lastIndexOf(" ") > limit / 2 ? cut.lastIndexOf(" ") : limit).replace(/[\s,;:]+$/, "")}…`;
}
