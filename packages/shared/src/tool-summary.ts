import { IMAGE_LINE } from "./entry-images.js";

/*
 * How the transcript shows a tool call and what came of it to people: one line for what the call works on, one for its
 * outcome, and readable text for each when opened. It reads only the runner's own shapes (its `name({...})` call lines,
 * transcript.ts, and the JSON its tools answer with), so it is plain formatting, the same wherever it runs: the control
 * plane uses it for brief tool output, clients for their rows. Anything it doesn't know shows as it is.
 */

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);

/** Keys every Pikibun tool's answer starts with (RunnerSession.toolActor): who asked, as whom, in which mode. */
const ATTRIBUTION = new Set(["initiatedBy", "actingAs", "mode"]);
/** Keys of a command's card (ApprovalRecord) that say nothing of its outcome to someone reading the transcript. */
const CARD_DETAIL = new Set(["id", "sessionId", "requestedBy", "createdAt", "reviewHash", "admissionId", "callId"]);

/** Characters a summary line holds before it is cut. */
const LINE_CHARS = 200;

/** `text` on one line: runs of whitespace as one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most `limit` characters (whole code points) of `text`, with an ellipsis when cut. */
function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text.slice(0, limit * 2 + 2));
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : text;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A word of a command line, quoted where it holds anything but plain characters. */
function word(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return /^[\w./:=@%+,~^-]+$/.test(text) ? text : JSON.stringify(text);
}

/** A non-empty string field. */
function string(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A finite number field. */
function number(fields: Fields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The arguments of a call line, `name({...})`, or undefined where they aren't a JSON object. */
export function callArguments(line: string): Fields | undefined {
  const open = line.indexOf("(");
  if (open < 0 || !line.endsWith(")")) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(open + 1, -1));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A read's lines: `L60–89`, `L60–`, or `L1–40` for a limit alone. */
function lineSpan(fields: Fields): string {
  const offset = number(fields, "offset");
  const limit = number(fields, "limit");
  if (offset === undefined && limit === undefined) return "";
  const from = offset ?? 1;
  return limit === undefined ? ` L${from}–` : ` L${from}–${from + limit - 1}`;
}

/**
 * What a call works on, on one line: the command line it runs, or the file, search, address or item it names; "" where
 * its arguments say nothing more than its name, or don't parse.
 */
export function callTarget(name: string, args: Fields | undefined): string {
  if (!args) return "";
  // Program tools (git, node, python, gh…): the command line they run, its program by default the tool's own.
  if (Array.isArray(args.args)) {
    const program = string(args, "program") ?? name;
    return oneLine([program, ...args.args.map(word)].join(" "));
  }
  const path = string(args, "path");
  switch (name) {
    case "read_file": if (path) return `${path}${lineSpan(args)}`; break;
    case "edit_file": if (path) return Array.isArray(args.edits) && args.edits.length > 1 ? `${path} (${args.edits.length} edits)` : path; break;
    case "delete_file": if (path) return args.recursive === true ? `${path} (recursive)` : path; break;
    case "move_file": case "copy_file": {
      const from = string(args, "from");
      const to = string(args, "to");
      if (from && to) return `${from} → ${to}`;
      break;
    }
    case "search": {
      const pattern = string(args, "pattern");
      if (!pattern) break;
      const where = [path, string(args, "glob")].filter(Boolean).join(" ");
      return oneLine(`${JSON.stringify(pattern)}${where ? ` in ${where}` : ""}`);
    }
    case "git_push": {
      const branch = string(args, "branch");
      const tag = string(args, "tag");
      if (branch) return `${string(args, "directory") ?? "."} → ${tag ? `tag ${tag}` : branch}`;
      break;
    }
    case "browser": {
      const url = string(args, "url");
      const actions = Array.isArray(args.actions) ? args.actions.length : 0;
      if (url || actions) return [url, actions ? plural(actions, "action") : ""].filter(Boolean).join(" · ");
      break;
    }
    case "web_search": {
      const queries = Array.isArray(args.queries) ? args.queries.filter(query => typeof query === "string") : [];
      const query = string(args, "query") ?? queries.join(" | ");
      if (query) return oneLine(query);
      break;
    }
  }
  const repository = string(args, "repository");
  const issue = number(args, "issue") ?? number(args, "pull");
  if (repository && issue !== undefined) return `${repository}#${issue}`;
  const action = string(args, "action");
  if (action) return oneLine([action, string(args, "session"), string(args, "name"), string(args, "id")].filter(Boolean).join(" "));
  for (const key of ["command", "cmd", "path", "file", "url", "query", "pattern", "repository", "title", "message"]) {
    const value = string(args, key);
    if (value) return oneLine(value);
  }
  const first = Object.values(args).find(value => typeof value === "string" && value.trim());
  return typeof first === "string" ? oneLine(first) : "";
}

/** What came of a tool call, on one line, and whether it failed. */
export interface ResultSummary {
  text: string;
  failed: boolean;
}

/** The lines of `text` that say something: not blank, and not those that stand for images. */
function saying(text: string): string[] {
  return text.split("\n").filter(line => line.trim() && !IMAGE_LINE.test(line.trim()));
}

/** A tool's answer as JSON, and how many images came with it; undefined where it isn't a JSON object. */
function answer(text: string): { fields: Fields; images: number } | undefined {
  const lines = text.split("\n");
  const images = lines.filter(line => IMAGE_LINE.test(line.trim())).length;
  const rest = lines.filter(line => !IMAGE_LINE.test(line.trim())).join("\n").trim();
  if (!rest.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(rest);
    return isObject(value) ? { fields: value, images } : undefined;
  } catch {
    return undefined;
  }
}

/** The line a command's output ends on, where commands say how they went, past the note of what was left out. */
function lastLine(output: string): string {
  const lines = saying(output).filter(line => !/^\[… .* …\]$/.test(line.trim()));
  return oneLine(lines[lines.length - 1] ?? "");
}

const cardStates: Record<string, string> = {
  pending: "Waiting for approval", approved: "Approved", executing: "Running", denied: "Denied", interrupted: "Interrupted",
};

/** A command's card (ApprovalRecord) as the command tools answer with it. */
function cardSummary(card: Fields): ResultSummary {
  const status = string(card, "status") ?? "";
  const output = typeof card.result === "string" ? card.result : "";
  const report = isObject(card.report) ? card.report : undefined;
  if (report && status === "executed") {
    const error = string(report, "error");
    const page = string(report, "title") ?? string(report, "url") ?? "";
    const code = number(report, "status");
    return { text: oneLine([error ?? page, code !== undefined ? `HTTP ${code}` : ""].filter(Boolean).join(" · ")) || "Done", failed: !!error };
  }
  if (status === "executed") return { text: lastLine(output) || "Done, no output", failed: false };
  if (status === "failed") return { text: oneLine(saying(output)[0] ?? "") || "Failed", failed: true };
  const state = cardStates[status] ?? status;
  return { text: state, failed: status === "denied" || status === "interrupted" };
}

/** Scalar fields as `key: value`, lists as how many they hold; nested objects are left to the opened view. */
function fieldsSummary(fields: Fields): string {
  return Object.entries(fields).flatMap(([key, value]) => {
    if (typeof value === "string") return value.trim() ? [`${key}: ${oneLine(value)}`] : [];
    if (typeof value === "number" || typeof value === "boolean") return [`${key}: ${value}`];
    if (Array.isArray(value)) return [`${key}: ${plural(value.length, "item")}`];
    return [];
  }).join(", ");
}

/** A Pikibun tool's answer, from the fields its tools give; the fields themselves where none of those. */
function answerSummary(all: Fields, images: number): ResultSummary {
  const fields = Object.fromEntries(Object.entries(all).filter(([key]) => !ATTRIBUTION.has(key)));
  const withImages = (text: string) => images ? `${text} · ${plural(images, "image")}` : text;
  const done = (text: string, failed = false): ResultSummary => ({ text: withImages(text), failed });
  if (isObject(fields.operation) && typeof fields.status === "string") return cardSummary(fields);
  const error = string(fields, "error");
  if (error) return done(oneLine(error), true);
  if (typeof fields.content === "string") {
    const span = isObject(fields.lines) ? fields.lines : undefined;
    const from = span && number(span, "from");
    const to = span && number(span, "to");
    const total = span && number(span, "total");
    if (from !== undefined && to !== undefined && total !== undefined) return done(to < from ? `No lines (${plural(total, "line")} in all)` : `Lines ${from}–${to} of ${total}`);
    const lines = fields.content === "" ? 0 : fields.content.split("\n").length - (fields.content.endsWith("\n") ? 1 : 0);
    return done(plural(lines, "line"));
  }
  const mimeType = string(fields, "mimeType");
  const width = number(fields, "width");
  const height = number(fields, "height");
  if (mimeType && width !== undefined && height !== undefined) return done(`${mimeType} ${width}×${height}`);
  if (Array.isArray(fields.matches)) {
    const paths = new Set(fields.matches.flatMap(match => isObject(match) && typeof match.path === "string" ? [match.path] : []));
    const count = fields.matches.length;
    const text = count ? `${plural(count, "match", "matches")} in ${plural(paths.size, "file")}` : "No matches";
    return done(fields.truncated === true ? `${text} (stopped early)` : text);
  }
  if (Array.isArray(fields.files)) return done(plural(fields.files.length, "entry", "entries"));
  if (string(fields, "written")) return done("Written");
  if (string(fields, "edited")) return done(typeof fields.edits === "number" ? `Edited (${plural(fields.edits, "edit")})` : "Edited");
  if (string(fields, "moved")) return done("Moved");
  if (string(fields, "copied")) return done("Copied");
  if (string(fields, "deleted")) return done(typeof fields.entries === "number" && fields.entries > 1 ? `Deleted (${plural(fields.entries, "entry", "entries")})` : "Deleted");
  return done(fieldsSummary(fields) || "Done");
}

/**
 * What came of a tool call, on one line: what a Pikibun tool's answer says (a command's last line of output, lines
 * read, matches found…), and otherwise the first line that says anything, as tools that answer in text start with
 * what matters. `error`: the tool said it failed.
 */
export function resultSummary(text: string, options: { error?: boolean } = {}): ResultSummary {
  const parsed = answer(text);
  const summary = parsed ? answerSummary(parsed.fields, parsed.images)
    : { text: (text.split("\n").find(line => line.trim()) ?? "").trimEnd(), failed: false };
  return { text: shorten(summary.text, LINE_CHARS), failed: summary.failed || options.error === true };
}

/**
 * `value` as people read it: a field per line, `key: value`; text over several lines indented below its key, never
 * escaped; lists of short values on one line, other lists an item per line. Arguments and answers when opened.
 */
export function readable(value: unknown, indent = ""): string {
  if (typeof value === "string") return value.includes("\n") ? value.split("\n").map(line => `${indent}${line}`).join("\n") : `${indent}${value}`;
  if (!value || typeof value !== "object") return `${indent}${JSON.stringify(value) ?? String(value)}`;
  const block = (child: unknown): string => {
    if (typeof child === "string") return child.includes("\n") ? `\n${readable(child, `${indent}  `)}` : ` ${child}`;
    if (!child || typeof child !== "object") return ` ${JSON.stringify(child) ?? String(child)}`;
    const inline = JSON.stringify(child);
    if (Array.isArray(child) && child.every(item => !item || typeof item !== "object") && inline.length <= 100) return ` ${inline}`;
    if (Array.isArray(child) ? !child.length : !Object.keys(child).length) return ` ${inline}`;
    return `\n${readable(child, `${indent}  `)}`;
  };
  // An item that is fields starts on its dash, as YAML lists them.
  if (Array.isArray(value)) {
    return value.map(item => isObject(item) && Object.keys(item).length ? `${indent}- ${readable(item, `${indent}  `).trimStart()}` : `${indent}-${block(item)}`).join("\n");
  }
  return Object.entries(value).map(([key, child]) => `${indent}${key}:${block(child)}`).join("\n");
}

/**
 * A tool's answer as people read it, opened: a command's output as it printed it, a file's text as it is, and other
 * answers as `readable` fields, without who asked (the transcript says that). Text that isn't such an answer is as it is.
 */
export function resultBody(text: string): string {
  const parsed = answer(text);
  if (!parsed) return text;
  const fields = Object.fromEntries(Object.entries(parsed.fields).filter(([key]) => !ATTRIBUTION.has(key)));
  if (isObject(fields.operation) && typeof fields.status === "string") {
    const output = typeof fields.result === "string" ? fields.result : "";
    const status = fields.status;
    if (isObject(fields.report)) return readable(fields.report);
    if (status === "executed") return output || "(no output)";
    return [`(${cardStates[status]?.toLowerCase() ?? status})`, output].filter(Boolean).join("\n");
  }
  if (typeof fields.content === "string") return fields.content;
  // What's left of a card without its operation, or of another answer: the fields that say something.
  return readable(Object.fromEntries(Object.entries(fields).filter(([key]) => !CARD_DETAIL.has(key))));
}

/** Characters of a string argument a brief tool call keeps, and items of a list. */
const BRIEF_VALUE = { chars: 100, items: 10, depth: 4 } as const;

/** `value` with long strings and lists cut short, still JSON. */
function briefValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return shorten(value, BRIEF_VALUE.chars);
  if (!value || typeof value !== "object") return value;
  if (depth >= BRIEF_VALUE.depth) return "…";
  if (Array.isArray(value)) {
    const kept = value.slice(0, BRIEF_VALUE.items).map(item => briefValue(item, depth + 1));
    return value.length > BRIEF_VALUE.items ? [...kept, `… ${value.length - BRIEF_VALUE.items} more`] : kept;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, briefValue(child, depth + 1)]));
}

/**
 * A call line, `name({...})`, as brief tool output shows it: each long string of its arguments cut short (a file's new
 * text), so they stay JSON that clients read, at most `limit` characters; undefined where that is no shorter or doesn't
 * fit, for the caller to cut the line itself.
 */
export function briefCallLine(name: string, line: string, limit: number): string | undefined {
  const args = callArguments(line);
  if (!args) return undefined;
  const shown = `${name}(${JSON.stringify(briefValue(args))})`;
  if (shown.length >= line.length || Array.from(shown).length > limit) return undefined;
  return shown;
}
