import { IMAGE_LINE } from "./entry-images.js";

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);

const ATTRIBUTION = new Set(["initiatedBy", "actingAs", "mode"]);
const CARD_DETAIL = new Set(["id", "sessionId", "requestedBy", "createdAt", "reviewHash", "admissionId", "callId"]);

const LINE_CHARS = 200;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text.slice(0, limit * 2 + 2));
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : text;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function word(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return /^[\w./:=@%+,~^-]+$/.test(text) ? text : JSON.stringify(text);
}

function string(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function number(fields: Fields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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

function lineSpan(fields: Fields): string {
  const offset = number(fields, "offset");
  const limit = number(fields, "limit");
  if (offset === undefined && limit === undefined) return "";
  const from = offset ?? 1;
  return limit === undefined ? ` L${from}–` : ` L${from}–${from + limit - 1}`;
}

export function callTarget(name: string, args: Fields | undefined): string {
  if (!args) return "";
  if (Array.isArray(args.args)) {
    const program = string(args, "program") ?? name;
    return oneLine([program, ...args.args.map(word)].join(" "));
  }
  const path = string(args, "path");
  switch (name) {
    case "read": case "read_file": if (path) return `${path}${lineSpan(args)}`; break;
    case "edit": case "edit_file": if (path) return Array.isArray(args.edits) && args.edits.length > 1 ? `${path} (${args.edits.length} edits)` : path; break;
    case "delete_file": if (path) return args.recursive === true ? `${path} (recursive)` : path; break;
    case "move_file": case "copy_file": {
      const from = string(args, "from");
      const to = string(args, "to");
      if (from && to) return `${from} → ${to}`;
      break;
    }
    case "find": {
      const pattern = string(args, "pattern");
      if (!pattern) break;
      return oneLine(`${JSON.stringify(pattern)}${path ? ` in ${path}` : ""}`);
    }
    case "grep": case "search": {
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

export interface ResultSummary {
  text: string;
  failed: boolean;
}

export interface ResultNote {
  severity: "info" | "warn" | "error";
  message: string;
}

const HARNESS_OPEN = "<harness>\n";
const HARNESS_CLOSE = /\n<\/harness>\s*$/;
const NOTE_LINE = /^\[(info|warn|error)\] ?(.*)$/;

export function resultNotes(text: string): { output: string; notes: ResultNote[] } {
  const close = HARNESS_CLOSE.exec(text);
  if (!close) return { output: text, notes: [] };
  const head = text.slice(0, close.index);
  const after = head.lastIndexOf(`\n${HARNESS_OPEN}`);
  const open = after >= 0 ? after + 1 : head.startsWith(HARNESS_OPEN) ? 0 : -1;
  if (open < 0) return { output: text, notes: [] };
  const body = head.slice(open + HARNESS_OPEN.length).split("\n");
  const notes: ResultNote[] = [];
  for (const line of body) {
    const note = NOTE_LINE.exec(line);
    if (note) notes.push({ severity: note[1] as ResultNote["severity"], message: note[2]! });
    else if (notes.length) notes[notes.length - 1]!.message += `\n${line}`;
    else return { output: text, notes: [] };
  }
  return { output: text.slice(0, Math.max(0, open - 1)), notes };
}

const NOTE_LABELS: Record<ResultNote["severity"], string> = { error: "Error", warn: "Warning", info: "Note" };

function noteLines(notes: readonly ResultNote[]): string {
  return notes.map(note => `${NOTE_LABELS[note.severity]}: ${note.message}`).join("\n");
}

function noteSummary(note: ResultNote): string {
  return oneLine(note.message.split("\n").find(line => line.trim()) ?? "") || NOTE_LABELS[note.severity];
}

function saying(text: string): string[] {
  return text.split("\n").filter(line => line.trim() && !IMAGE_LINE.test(line.trim()));
}

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

function lastLine(output: string): string {
  const lines = saying(output).filter(line => !/^\[… .* …\]$/.test(line.trim()));
  return oneLine(lines[lines.length - 1] ?? "");
}

const cardStates: Record<string, string> = {
  pending: "Waiting for approval", approved: "Approved", executing: "Running", denied: "Denied", interrupted: "Interrupted",
};

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

function fieldsSummary(fields: Fields): string {
  return Object.entries(fields).flatMap(([key, value]) => {
    if (typeof value === "string") return value.trim() ? [`${key}: ${oneLine(value)}`] : [];
    if (typeof value === "number" || typeof value === "boolean") return [`${key}: ${value}`];
    if (Array.isArray(value)) return [`${key}: ${plural(value.length, "item")}`];
    return [];
  }).join(", ");
}

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

const PI_CONTRACT: Record<string, "read" | "write" | "edit" | "ls" | "grep" | "find"> = {
  read: "read", write: "write", edit: "edit", ls: "ls", grep: "grep", find: "find",
  read_file: "read", write_file: "write", edit_file: "edit", list_files: "ls", search: "grep",
};

export function piContract(tool: string | undefined, text: string): "read" | "write" | "edit" | "ls" | "grep" | "find" | undefined {
  const contract = tool === undefined ? undefined : PI_CONTRACT[tool];
  return contract && !text.startsWith("{\"initiatedBy\"") ? contract : undefined;
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const GREP_LINE = /^(.*?)(?::(\d+): |-(\d+)- )/;

function piSummary(contract: "read" | "write" | "edit" | "ls" | "grep" | "find", text: string): string {
  const notice = /\n\n\[([^\n]*)\]$/.exec(text);
  const body = notice ? text.slice(0, notice.index) : text;
  const said = notice?.[1] ?? "";
  switch (contract) {
    case "read": {
      const image = /^Read image file \[([^\]\n]+)\]/.exec(text);
      if (image) return image[1]!;
      const long = /^\[Line (\d+) is ([^,\]]+), exceeds /.exec(text);
      if (long) return `Line ${long[1]} is ${long[2]}, too long to show`;
      const showing = /^Showing lines (\d+)-(\d+) of (\d+)/.exec(said);
      if (showing) return `Lines ${showing[1]}–${showing[2]} of ${showing[3]}`;
      const more = /^(\d+) more lines in file\. Use offset=(\d+) /.exec(said);
      const count = lineCount(body);
      if (more) {
        const next = Number(more[2]);
        return count ? `Lines ${next - count}–${next - 1} of ${next - 1 + Number(more[1])}` : "No lines";
      }
      return plural(count, "line");
    }
    case "write": return /^Successfully wrote to /.test(text) ? "Written" : oneLine(text);
    case "edit": {
      const edited = /^Successfully replaced (\d+) block\(s\) in /.exec(text);
      return edited ? `Edited (${plural(Number(edited[1]), "edit")})` : oneLine(text);
    }
    case "ls": {
      if (text === "(empty directory)") return "Empty directory";
      const entries = plural(lineCount(body), "entry", "entries");
      return /entries limit reached/.test(said) ? `${entries} (more not shown)` : entries;
    }
    case "find": {
      if (body === "No files found matching pattern") return /stopped early/.test(said) ? "No files (stopped early)" : "No files";
      const found = plural(lineCount(body), "path");
      return /results limit reached|stopped early/.test(said) ? `${found} (stopped early)` : found;
    }
    case "grep": {
      const stopped = /matches limit reached|stopped early/.test(said) ? " (stopped early)" : "";
      if (body === "No matches found") return `No matches${stopped}`;
      const files = new Set<string>();
      let matches = 0;
      for (const line of body.split("\n")) {
        const found = GREP_LINE.exec(line);
        if (!found || found[2] === undefined) continue;
        matches++;
        files.add(found[1]!);
      }
      return `${plural(matches, "match", "matches")} in ${plural(files.size, "file")}${stopped}`;
    }
  }
}

export function resultSummary(whole: string, options: { error?: boolean; tool?: string } = {}): ResultSummary {
  const { output: text, notes } = resultNotes(whole);
  const error = notes.find(note => note.severity === "error");
  if (error) return { text: shorten(noteSummary(error), LINE_CHARS), failed: true };
  const contract = options.error === true ? undefined : piContract(options.tool, text);
  if (contract) return { text: shorten(piSummary(contract, text), LINE_CHARS), failed: options.error === true };
  const parsed = answer(text);
  const first = (text.split("\n").find(line => line.trim()) ?? "").trimEnd();
  const summary = parsed ? answerSummary(parsed.fields, parsed.images)
    : { text: first || (notes[0] ? noteSummary(notes[0]) : ""), failed: false };
  return { text: shorten(summary.text, LINE_CHARS), failed: summary.failed || options.error === true };
}

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
  if (Array.isArray(value)) {
    return value.map(item => isObject(item) && Object.keys(item).length ? `${indent}- ${readable(item, `${indent}  `).trimStart()}` : `${indent}-${block(item)}`).join("\n");
  }
  return Object.entries(value).map(([key, child]) => `${indent}${key}:${block(child)}`).join("\n");
}

export function resultBody(whole: string, options: { tool?: string } = {}): string {
  const { output, notes } = resultNotes(whole);
  const body = piContract(options.tool, output) ? output : outputBody(output);
  return notes.length ? [body.replace(/\n+$/, ""), noteLines(notes)].filter(Boolean).join("\n") : body;
}

function outputBody(text: string): string {
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
  return readable(Object.fromEntries(Object.entries(fields).filter(([key]) => !CARD_DETAIL.has(key))));
}

const BRIEF_VALUE = { chars: 100, items: 10, depth: 4 } as const;

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

export function briefCallLine(name: string, line: string, limit: number): string | undefined {
  const args = callArguments(line);
  if (!args) return undefined;
  const shown = `${name}(${JSON.stringify(briefValue(args))})`;
  if (shown.length >= line.length || Array.from(shown).length > limit) return undefined;
  return shown;
}
