import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { Agent, request } from "node:https";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionContext, ExtensionFactory, ToolResultEvent } from "@earendil-works/pi-coding-agent";

/*
 * Context files: a Pi extension that adds files the session's settings choose to the system prompt of each message, as
 * Pi adds a project's AGENTS.md or CLAUDE.md. Sessions that don't run Pi's own agent session (Pikibun's run on
 * pi-durable) never load those; this brings them back, and lets the settings choose others:
 *
 * - a path in the repository (`AGENTS.md`, `docs/CONVENTIONS.md`, `.cursor/rules/*.mdc`), with `|` between
 *   alternatives of which the first found is used (`AGENTS.md|CLAUDE.md`, the default). It is looked up in the working
 *   directory and, where that isn't a repository itself (a Pikibun worktree holds its clones side by side), in each
 *   repository directly under it;
 * - `host:<name>`, a file in the host's own context directory (`PI_CONTEXT_FILES_DIR`, or `context-files` in Pi's agent
 *   directory), which only the host's owner puts there;
 * - an `https://` URL, fetched from the host at most every five minutes.
 *
 * Settings come from whoever sets the extension's flags (in Pikibun, the workspace's owners and admins), while the
 * extension runs as the host's user, outside any sandbox. So it reads nothing outside what those settings may reach: a
 * repository file that links outside the working directory, a host file that links outside the context directory, and
 * a URL whose host is on a private, loopback or link-local network are refused.
 *
 * A clone made during a message, after its system prompt was built, gets its files through the result of the tool call
 * that made it (`tool_result`), so the agent sees them before it works there.
 *
 * Like Pikibun's other extensions it imports nothing but Pi's packages and Node's, so it loads in Pi as in Pikibun.
 */

/** The extension's settings (Pi flags), and what each means. */
export const contextFilesFlags = Object.freeze({
  "context-files": "The files to add to the system prompt, separated by commas or new lines: a path in the repository (AGENTS.md, "
    + "docs/*.md; a|b uses the first found), host:<name> for a file in the host's context directory, or an https:// URL",
  "context-max-chars": "The most characters of context files to add to each message's system prompt; longer files are cut",
});

export const DEFAULT_CONTEXT_FILES = "AGENTS.md|CLAUDE.md";
export const DEFAULT_MAX_CHARS = 60_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 1_000_000;
/** No single file or page is read past this. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** At most this many files a wildcard matches, in name order. */
export const MAX_MATCHES = 20;
/** At most this many entries of the setting. */
const MAX_ENTRIES = 50;
/** At most this many repositories under the working directory. */
const MAX_CLONES = 50;
const URL_TTL_MS = 5 * 60_000;
const URL_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type ContextEntry =
  /** A path in each repository; the first of its alternatives found is used. */
  | { kind: "repo"; text: string; alternatives: string[] }
  /** A path in the host's context directory. */
  | { kind: "host"; text: string; path: string }
  | { kind: "url"; text: string; url: string }
  | { kind: "invalid"; text: string; reason: string };

/** A file to add: its label in the prompt and its text. */
export interface ContextFile { label: string; text: string }
export interface Collected { files: ContextFile[]; problems: string[] }

/** Why `path` can't be a path relative to its directory, if it can't. */
function relativeProblem(path: string): string | undefined {
  if (!path) return "no path";
  if (isAbsolute(path) || path.startsWith("~") || /^[a-zA-Z]:/.test(path) || path.includes("\\")) {
    return "only paths relative to the repository are read (host files are host:<name>)";
  }
  const segments = path.split("/");
  if (segments.includes("..")) return "a path may not leave its directory";
  if (segments.includes(".git")) return "files in .git are never read";
  if (segments.slice(0, -1).some(segment => /[*?]/.test(segment))) return "wildcards are taken only in the file's name";
  return undefined;
}

/** The setting's entries, in its order: separated by commas or new lines; blank ones and `#` comments are skipped. */
export function parseContextFiles(setting: string): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (const raw of setting.split(/[\n,]/)) {
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;
    if (entries.length >= MAX_ENTRIES) {
      entries.push({ kind: "invalid", text, reason: `only the first ${MAX_ENTRIES} entries are read` });
      break;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      let url: URL;
      try { url = new URL(text); } catch { entries.push({ kind: "invalid", text, reason: "not a valid URL" }); continue; }
      if (url.protocol !== "https:") entries.push({ kind: "invalid", text, reason: "only https:// URLs are read" });
      else if (url.username || url.password) entries.push({ kind: "invalid", text, reason: "URLs with credentials are never read" });
      else entries.push({ kind: "url", text, url: url.href });
      continue;
    }
    if (text.startsWith("host:")) {
      const path = text.slice("host:".length).trim();
      const problem = relativeProblem(path);
      entries.push(problem ? { kind: "invalid", text, reason: problem.replace(" (host files are host:<name>)", "") } : { kind: "host", text, path });
      continue;
    }
    const alternatives = text.split("|").map(item => item.trim()).filter(Boolean);
    const problem = alternatives.length ? alternatives.map(relativeProblem).find(Boolean) : "no path";
    entries.push(problem ? { kind: "invalid", text, reason: problem } : { kind: "repo", text, alternatives });
  }
  return entries;
}

/** The `context-max-chars` setting as a number within its bounds; the default where it isn't one. */
export function maxChars(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(number)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(number)));
}

/** The host's context directory: `PI_CONTEXT_FILES_DIR`, or `context-files` in Pi's agent directory. */
export function hostContextDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const expand = (path: string) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (env.PI_CONTEXT_FILES_DIR?.trim()) return expand(env.PI_CONTEXT_FILES_DIR.trim());
  return join(env.PI_CODING_AGENT_DIR?.trim() ? expand(env.PI_CODING_AGENT_DIR.trim()) : join(homedir(), ".pi", "agent"), "context-files");
}

/**
 * Where repository paths are looked up: the working directory alone where it is a repository (Pi run in a project);
 * otherwise it and each repository directly under it, by name (a Pikibun worktree, whose clones sit side by side).
 */
export async function repositoryRoots(cwd: string): Promise<string[]> {
  if (existsSync(join(cwd, ".git"))) return [cwd];
  let names: string[];
  try {
    names = (await readdir(cwd, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map(entry => entry.name);
  } catch {
    return [cwd];
  }
  const clones = names.filter(name => existsSync(join(cwd, name, ".git"))).sort().slice(0, MAX_CLONES);
  return [cwd, ...clones.map(name => join(cwd, name))];
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function wildcard(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/** The files `pattern` names under `base`: the one path, or what a wildcard in its name matches, in name order. */
async function matches(base: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/").filter(segment => segment && segment !== ".");
  const name = segments.pop();
  if (!name) return [];
  const directory = join(base, ...segments);
  if (!/[*?]/.test(name)) return [join(directory, name)];
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const regex = wildcard(name);
  return names.filter(item => regex.test(item)).sort().slice(0, MAX_MATCHES).map(item => join(directory, item));
}

type Read = { real: string; text: string } | { error: string } | undefined;

/** A regular file's text, if it is one, when it resolves (links followed) inside `boundary`. */
async function readInside(path: string, boundary: string): Promise<Read> {
  let real: string;
  try { real = await realpath(path); } catch { return undefined; }
  if (!inside(boundary, real)) return { error: "it links outside its directory, so it was not read" };
  try {
    const info = await stat(real);
    if (!info.isFile()) return undefined;
    if (info.size > MAX_FILE_BYTES) return { error: "larger than 1 MB" };
    return { real, text: await readFile(real, "utf8") };
  } catch (error) {
    return { error: describe(error) };
  }
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const label = (base: string, path: string) => relative(base, path).split(sep).join("/");

// Networks a URL's host may not resolve to: the host's own, its private networks', and those that aren't the internet.
const privateNetworks = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  privateNetworks.addSubnet(network, prefix, "ipv4");
}
// IPv4-mapped addresses (::ffff:a.b.c.d) are checked against the IPv4 rules; a ::ffff:0:0/96 rule would match all of IPv4.
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  privateNetworks.addSubnet(network, prefix, "ipv6");
}

/** Networks the host's owner lets URLs reach anyway (`PI_CONTEXT_FILES_ALLOW_RANGES`: CIDRs, by commas), such as a fake-IP proxy's. */
export function allowedRanges(setting = process.env.PI_CONTEXT_FILES_ALLOW_RANGES ?? ""): BlockList {
  const allowed = new BlockList();
  for (const item of setting.split(",").map(part => part.trim()).filter(Boolean)) {
    const [network, prefix] = item.split("/");
    const family = isIP(network ?? "");
    const bits = Number(prefix);
    if (!family || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) continue;
    allowed.addSubnet(network!, bits, family === 4 ? "ipv4" : "ipv6");
  }
  return allowed;
}

/** Whether a URL may not reach `address`: one on a private, loopback, link-local or reserved network, unless allowed. */
export function blockedAddress(address: string, allowed: BlockList = allowedRanges()): boolean {
  const family = isIP(address);
  if (!family) return true;
  const type = family === 4 ? "ipv4" : "ipv6";
  return privateNetworks.check(address, type) && !allowed.check(address, type);
}

const TEXT_TYPE = /^(text\/|application\/(json|xml|yaml|x-yaml|markdown|toml)\b)/i;

/** A page's text, from `https://` only, never from a blocked address (checked at each connection, redirects included). */
export async function fetchText(url: string, signal?: AbortSignal, resolve: typeof dnsLookup = dnsLookup): Promise<string> {
  const allowed = allowedRanges();
  const lookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const given = (typeof options === "object" && options !== null ? options : {}) as { family?: unknown; all?: unknown };
    const family = typeof options === "number" ? options : given.family === 4 || given.family === "IPv4" ? 4 : given.family === 6 || given.family === "IPv6" ? 6 : 0;
    resolve(hostname, { all: true, family }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error);
      const blocked = addresses.find(address => blockedAddress(address.address, allowed));
      if (blocked || !addresses.length) return callback(new Error(`${hostname} is on a private network (${blocked?.address ?? "no address"})`));
      if (given.all === true) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as unknown as typeof dnsLookup;
  const deadline = AbortSignal.any([AbortSignal.timeout(URL_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  // Its own agent connects directly, never through a proxy of the environment (NODE_USE_ENV_PROXY), which would resolve
  // the name itself, past the check.
  const agent = new Agent({ keepAlive: false });
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "https:") throw new Error("it redirects away from https");
    const host = current.hostname.replace(/^\[|\]$/g, "");
    // An address in the URL itself is connected to without a lookup.
    if (isIP(host) && blockedAddress(host, allowed)) throw new Error(`${host} is on a private network`);
    const answer = await new Promise<{ location?: string; text?: string }>((resolve, reject) => {
      const outgoing = request(current, { method: "GET", agent, lookup, signal: deadline,
        headers: { "user-agent": "pi-context-files", accept: "text/markdown, text/plain;q=0.9, text/*;q=0.8, */*;q=0.1" } }, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) { response.resume(); resolve({ location: response.headers.location }); return; }
        if (status !== 200) { response.resume(); reject(new Error(`HTTP ${status}`)); return; }
        const type = String(response.headers["content-type"] ?? "");
        if (type && !TEXT_TYPE.test(type)) { response.resume(); reject(new Error(`not text (${type.split(";")[0]})`)); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) { outgoing.destroy(new Error("larger than 1 MB")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      outgoing.on("error", error => reject(deadline.aborted && !signal?.aborted ? new Error("timed out") : error));
      outgoing.end();
    });
    if (answer.text !== undefined) return answer.text;
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    current = new URL(answer.location!, current);
  }
}

/** Pages already fetched, for a while, per session; one that fails again keeps its last text. */
export class UrlCache {
  #pages = new Map<string, { at: number; text?: string; error?: string }>();
  readonly #fetch: (url: string, signal?: AbortSignal) => Promise<string>;
  readonly #ttl: number;
  constructor(fetch: (url: string, signal?: AbortSignal) => Promise<string> = fetchText, ttl = URL_TTL_MS) {
    this.#fetch = fetch;
    this.#ttl = ttl;
  }

  async get(url: string, signal?: AbortSignal, now = Date.now()): Promise<{ text: string } | { error: string }> {
    const known = this.#pages.get(url);
    if (known && now - known.at < this.#ttl) return known.text !== undefined ? { text: known.text } : { error: known.error! };
    try {
      const text = await this.#fetch(url, signal);
      this.#pages.set(url, { at: now, text });
      return { text };
    } catch (error) {
      if (known?.text !== undefined) { this.#pages.set(url, { at: now, text: known.text }); return { text: known.text }; }
      this.#pages.set(url, { at: now, error: describe(error) });
      return { error: describe(error) };
    }
  }
}

export interface CollectOptions {
  /** Which entries to read: all of them, or only repository paths (for a new clone). */
  only?: "repo";
  urls?: UrlCache;
  hostDirectory?: string;
  signal?: AbortSignal;
  /** Files already in the prompt (Pi's own context files), by real path: not added again. */
  skip?: ReadonlySet<string>;
}

/** The files `entries` name, in their order, with what couldn't be read. Paths missing from a repository are not problems. */
export async function collectContext(cwd: string, roots: readonly string[], entries: readonly ContextEntry[], options: CollectOptions = {}): Promise<Collected> {
  const files: ContextFile[] = [];
  const problems: string[] = [];
  const seen = new Set(options.skip ?? []);
  const add = (real: string, name: string, text: string) => {
    if (seen.has(real)) return;
    seen.add(real);
    files.push({ label: name, text });
  };
  let boundary: string;
  try { boundary = await realpath(cwd); } catch { return { files, problems }; }
  for (const entry of entries) {
    if (entry.kind === "invalid") { if (options.only !== "repo") problems.push(`${entry.text}: ${entry.reason}`); continue; }
    if (entry.kind === "repo") {
      for (const root of roots) {
        let base: string;
        try { base = await realpath(root); } catch { continue; }
        if (base !== boundary && !inside(boundary, base)) continue;
        for (const alternative of entry.alternatives) {
          let found = false;
          for (const path of await matches(base, alternative)) {
            const read = await readInside(path, boundary);
            if (!read) continue;
            found = true;
            if ("error" in read) problems.push(`${label(boundary, path)}: ${read.error}`);
            else add(read.real, label(boundary, read.real), read.text);
          }
          if (found) break;
        }
      }
      continue;
    }
    if (options.only === "repo") continue;
    if (entry.kind === "host") {
      let directory: string;
      try { directory = await realpath(options.hostDirectory ?? hostContextDirectory()); } catch { problems.push(`${entry.text}: not found on the host`); continue; }
      let found = false;
      for (const path of await matches(directory, entry.path)) {
        const read = await readInside(path, directory);
        if (!read) continue;
        found = true;
        if ("error" in read) problems.push(`host:${label(directory, path)}: ${read.error}`);
        else add(read.real, `host:${label(directory, read.real)}`, read.text);
      }
      if (!found) problems.push(`${entry.text}: not found on the host`);
      continue;
    }
    const page = await (options.urls ?? new UrlCache()).get(entry.url, options.signal);
    if ("error" in page) problems.push(`${entry.url}: ${page.error}`);
    else add(entry.url, entry.url, page.text);
  }
  return { files, problems };
}

/** The prompt section for what was collected, within `limit` characters of files; undefined when there is nothing. */
export function contextPrompt(collected: Collected, limit: number, heading = "# Project context"): string | undefined {
  const files = collected.files.map(file => ({ ...file, text: file.text.trim() })).filter(file => file.text);
  if (!files.length && !collected.problems.length) return undefined;
  const parts = [heading, "Project-specific instructions and guidelines, from the files this session's context-files setting names. "
    + "A file under a repository's directory applies to work in that repository."];
  let left = limit;
  const omitted: string[] = [];
  for (const file of files) {
    if (left <= 0) { omitted.push(file.label); continue; }
    const cut = file.text.length > left;
    const text = cut ? `${file.text.slice(0, left)}\n\n[… ${file.text.length - left} more characters cut, over the limit of ${limit}: read the file for the rest]` : file.text;
    left -= Math.min(file.text.length, left);
    parts.push(`## ${file.label}\n\n${text}`);
  }
  if (omitted.length) parts.push(`Left out, over the limit of ${limit} characters (read them if the task needs them): ${omitted.join(", ")}.`);
  if (collected.problems.length) parts.push(`Not loaded: ${collected.problems.join("; ")}.`);
  return parts.join("\n\n");
}

/** Pi's own context files of this prompt, by real path, where Pi loaded them (plain Pi does, Pikibun doesn't). */
async function piContextFiles(event: unknown): Promise<Set<string>> {
  const files = (event as { systemPromptOptions?: { contextFiles?: { path?: unknown }[] } })?.systemPromptOptions?.contextFiles;
  const paths = new Set<string>();
  for (const file of Array.isArray(files) ? files : []) {
    if (typeof file?.path !== "string") continue;
    try { paths.add(await realpath(file.path)); } catch { paths.add(file.path); }
  }
  return paths;
}

export const contextFilesExtension: ExtensionFactory = pi => {
  pi.registerFlag("context-files", { type: "string", default: DEFAULT_CONTEXT_FILES, description: contextFilesFlags["context-files"] });
  pi.registerFlag("context-max-chars", { type: "string", default: String(DEFAULT_MAX_CHARS), description: contextFilesFlags["context-max-chars"] });
  const settings = () => {
    const files = pi.getFlag("context-files");
    return { entries: parseContextFiles(typeof files === "string" ? files : DEFAULT_CONTEXT_FILES), limit: maxChars(pi.getFlag("context-max-chars")) };
  };
  const urls = new UrlCache();
  /** The repositories whose files the agent has, as of the message's prompt and the clones since. */
  const known = new Set<string>();
  let skip = new Set<string>();

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    const cwd = ctx?.cwd ?? process.cwd();
    const { entries, limit } = settings();
    const roots = await repositoryRoots(cwd);
    known.clear();
    for (const root of roots) known.add(root);
    skip = await piContextFiles(event);
    const section = contextPrompt(await collectContext(cwd, roots, entries, { urls, signal: ctx?.signal, skip }), limit);
    return section ? { systemPrompt: `${event.systemPrompt}\n\n${section}` } : undefined;
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    const cwd = ctx?.cwd;
    if (!cwd || !known.size) return undefined;
    const fresh = (await repositoryRoots(cwd)).filter(root => !known.has(root));
    if (!fresh.length) return undefined;
    for (const root of fresh) known.add(root);
    const { entries, limit } = settings();
    const section = contextPrompt(await collectContext(cwd, fresh, entries, { only: "repo", skip }), limit,
      `# Project context of ${fresh.map(root => label(cwd, root)).join(", ")}, cloned just now`);
    if (!section) return undefined;
    return { content: [...(event.content ?? []), { type: "text" as const, text: section }] };
  });
};
