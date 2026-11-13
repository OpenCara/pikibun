import { builtinExtensions } from "./host-config.js";
import { parseExtensionSourceSpec, type ExtensionToolMode, type InstalledExtension, type WorkspaceExtension } from "./host-extensions.js";
import { pikiExtension, pikiExtensionOn, pikiSessionToolExtensions, sessionToolsOff } from "./piki-extensions.js";
import { canonicalToolName } from "./types.js";

export const pikibunToolDescriptions: Readonly<Record<string, string>> = Object.freeze({
  identity: "Tells the agent who the session is for: its owner's identity and the session's APP_ environment.",
  ls: "Lists a directory of the session's files, as Pi's ls does.",
  read: "Reads a session file, or some of its lines, as Pi's read does; images go to the model as images.",
  grep: "Searches the worktree's text files for a regular expression or text, as Pi's grep does.",
  write: "Writes a whole file, as Pi's write does.",
  edit: "Replaces text in a file, in place, with Pi's own edit.",
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
  make: "Runs make in a clone, without a shell of its own; a Makefile's recipes are shell commands.",
  browser: "Drives a headless Chromium in the sandbox: opens a page, acts on it and sees it, serving the web app under test for the call.",
  tunnel: "Puts the web server it works on online at a public address through a Cloudflare tunnel; it starts only for the host's owner or a member they granted host commands.",
  github_read: "Reads a GitHub issue or pull request, or waits for its checks or a change.",
  github_comment: "Comments on a GitHub issue or pull request, as the session owner.",
  github_issue: "Opens a GitHub issue, as the session owner.",
  github_merge: "Merges a GitHub pull request, as the session owner.",
  source_read: "Reads an item of the workspace's document sources, as the session owner.",
  schedule: "Lists, creates, changes and deletes the session's scheduled prompts.",
  sessions: "Lists, reads, messages, starts, stops and archives the workspace's other sessions, as the message's sender.",
  codemode: "Runs JavaScript that calls the session's tools, to batch, chain and filter their calls.",
});

export type WorkspaceToolOrigin = "session" | "builtin" | "extension";

export interface WorkspaceTool {
  name: string;
  source: string;
  origin: WorkspaceToolOrigin;
  description: string;
  mode?: ExtensionToolMode;
}

export interface ExtensionOffer {
  description?: string;
  tools: { name: string; description: string; own?: true }[];
}

const OWN_TOOL = /^tool (.+) \(one of Pikibun's own\)$/;

export type ShadowKind = "own" | "extension" | "builtin";

export const PIKIBUN = "Pikibun";

export interface WorkspaceTools {
  tools: WorkspaceTool[];
  off: { name: string; source: string }[];
  shadowed: { name: string; source: string; by: string; kind: ShadowKind }[];
  unreported: string[];
}

export function extensionOffer(source: string, installed: readonly InstalledExtension[]): ExtensionOffer | undefined {
  const piki = pikiExtension(source);
  if (piki?.sessionTools) return { description: piki.description, tools: piki.sessionTools.map(name => ({ name, description: pikibunToolDescriptions[name] ?? "" })) };
  const reported = installed.find(item => item.source === source && !item.error);
  if (reported) {
    const tools = new Map<string, ExtensionOffer["tools"][number]>();
    for (const module of reported.modules) {
      for (const tool of module.tools) if (!tools.has(tool.name)) tools.set(tool.name, { name: tool.name, description: tool.description });
      for (const item of module.ignored) {
        const name = OWN_TOOL.exec(item)?.[1];
        if (name && !tools.has(name)) tools.set(name, { name, description: "", own: true });
      }
    }
    return { description: piki?.description ?? reported.description, tools: [...tools.values()] };
  }
  if (piki) return { description: piki.description, tools: piki.tool ? [{ name: piki.tool, description: piki.description }] : [] };
  return undefined;
}

export function workspaceTools(extensions: readonly WorkspaceExtension[], installed: readonly InstalledExtension[]): WorkspaceTools {
  const tools: WorkspaceTool[] = [];
  const off: WorkspaceTools["off"] = [];
  const owners = new Map<string, string>();
  const own = pikiSessionToolExtensions().filter(item => !item.retired);
  const offTools = sessionToolsOff(extensions);
  for (const extension of [...own.filter(item => item.core), ...own.filter(item => !item.core)]) {
    for (const name of extension.sessionTools ?? []) {
      if (owners.has(name)) continue;
      const on = !offTools.has(name);
      const source = (on ? own.find(item => item.sessionTools?.includes(name) && pikiExtensionOn(item, extensions)) : undefined)?.source ?? extension.source;
      owners.set(name, source);
      if (on) tools.push({ name, source, origin: "session", description: pikibunToolDescriptions[name] ?? "" });
      else off.push({ name, source });
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
      const by = owners.get(tool.name) ?? (tool.own ? owners.get(canonicalToolName(tool.name)) : undefined);
      if (tool.own || (by && sessionToolSources.has(by))) {
        shadowed.push({ name: tool.name, source: extension.source, by: by && sessionToolSources.has(by) ? by : PIKIBUN, kind: "own" });
        continue;
      }
      if (by) { if (by !== extension.source) shadowed.push({ name: tool.name, source: extension.source, by, kind: "extension" }); continue; }
      owners.set(tool.name, extension.source);
      offered.push({ name: tool.name, source: extension.source, origin: "extension", description: tool.description, mode: extension.tools });
    }
  }
  for (const builtin of builtinExtensions.filter(item => "core" in item && item.core)) {
    for (const name of builtin.tools) {
      const by = owners.get(name);
      if (by) shadowed.push({ name, source: builtin.name, by, kind: "builtin" });
      else tools.push({ name, source: builtin.name, origin: "builtin", description: pikibunToolDescriptions[name] ?? builtin.description });
    }
  }
  return { tools: [...tools, ...offered], off, shadowed, unreported };
}

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

export function descriptionSummary(description: string, limit = 200): string {
  const first = description.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ");
  if (first.length <= limit) return first;
  const sentence = first.slice(0, limit + 1).match(/^.*[.!?](?=\s)/)?.[0];
  if (sentence && sentence.length >= limit / 2) return sentence;
  const cut = first.slice(0, limit);
  return `${cut.slice(0, cut.lastIndexOf(" ") > limit / 2 ? cut.lastIndexOf(" ") : limit).replace(/[\s,;:]+$/, "")}…`;
}
