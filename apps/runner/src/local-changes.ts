import {
  localChangesLimits, validChangesCommit, validChangesDirectory, type LocalChanges, type LocalChangesRequest, type LocalCommit, type LocalRepository,
} from "../../../packages/shared/src/local-changes.js";
import type { PullRequestFileStatus, PullRequestFileView } from "../../../packages/shared/src/types.js";
import { shellQuote } from "./program-command.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TOO_LARGE = "pikibun-too-large";
const encoder = new TextEncoder();

export const LOCAL_CHANGES_SECONDS = 30;

export function localChangesCommand(request: LocalChangesRequest, marker: string): string {
  if (!/^[0-9a-f]{32}$/.test(marker)) throw new Error("Invalid marker");
  const commit = request.commit;
  const diff = commit
    ? `p=$(g rev-parse --quiet --verify ${shellQuote(`${commit}^1`)} 2>/dev/null) || p=${EMPTY_TREE}; d "$p" ${shellQuote(commit)} 2>/dev/null`
    : `b=HEAD; g rev-parse --quiet --verify HEAD >/dev/null 2>&1 || b=${EMPTY_TREE}; d "$b" 2>/dev/null; n=0; `
      + `g ls-files --others --exclude-standard -z 2>/dev/null | while IFS= read -r -d '' f; do n=$((n+1)); [ "$n" -le ${localChangesLimits.untracked} ] || break; `
      + `if [ -f "$f" ] && [ ! -L "$f" ]; then if [ "$(wc -c < "$f")" -le ${localChangesLimits.patchBytes} ]; then d --no-index -- /dev/null "$f" 2>/dev/null; `
      + `else printf 'diff --git a/%s b/%s\\nnew file mode 100644\\n${TOO_LARGE}\\n' "$f" "$f"; fi; `
      + `elif [ ! -d "$f" ]; then printf 'diff --git a/%s b/%s\\nnew file mode 100644\\n' "$f" "$f"; fi; done`;
  return [
    `M=${marker}`,
    "g() { GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git --no-pager -c core.fsmonitor=false -c core.untrackedCache=false -c core.quotepath=false -c core.hooksPath=/dev/null -c color.ui=false \"$@\"; }",
    "d() { g diff --no-ext-diff --no-textconv --no-color -M \"$@\"; }",
    "{ first=; n=0",
    `for r in */ */*/ .; do r="\${r%/}"; [ -e "$r/.git" ] || continue; n=$((n+1)); [ "$n" -le ${localChangesLimits.repositories} ] || break; [ -n "$first" ] || first="$r"`,
    "printf '%s\\t%s\\t%s\\n' \"$r\" \"$(g -C \"$r\" symbolic-ref --quiet --short HEAD 2>/dev/null)\" \"$(g -C \"$r\" rev-parse --quiet --verify HEAD 2>/dev/null)\"; done",
    `sel=${request.directory === undefined ? "\"$first\"" : shellQuote(request.directory)}`,
    "printf '%s\\n%s\\n%s\\n' \"$M\" \"$sel\" \"$M\"",
    "if [ -n \"$sel\" ] && [ -e \"$sel/.git\" ] && cd -- \"./$sel\"; then",
    `g log -n ${localChangesLimits.commits} --format='%H%x09%an%x09%aI%x09%s' HEAD 2>/dev/null; printf '%s\\n' "$M"`,
    `g rev-list -n ${localChangesLimits.commits} HEAD --not --remotes 2>/dev/null; printf '%s\\n' "$M"`,
    diff,
    `fi; } </dev/null | head -c ${localChangesLimits.outputBytes}`,
  ].join("\n");
}

interface Parsed { path: string; previousPath?: string; status: PullRequestFileStatus; additions: number; deletions: number; lines: string[]; tooLarge: boolean }

function headerPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.startsWith("a/") && rest[half] === " " && rest.slice(half + 1).startsWith("b/") && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(2, half);
  const at = rest.lastIndexOf(" b/");
  return at < 0 ? rest : rest.slice(at + 3);
}

export function parsePatchFiles(text: string, complete = true): { files: PullRequestFileView[]; additions: number; deletions: number; omitted: number } {
  const parsed: Parsed[] = [];
  let current: Parsed | undefined;
  let hunks = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: headerPath(line), status: "modified", additions: 0, deletions: 0, lines: [], tooLarge: false };
      parsed.push(current);
      hunks = false;
      continue;
    }
    if (!current) continue;
    if (hunks) {
      if (line === "") continue;
      current.lines.push(line);
      if (line.startsWith("+")) current.additions++;
      else if (line.startsWith("-")) current.deletions++;
      continue;
    }
    if (line.startsWith("@@")) { hunks = true; current.lines.push(line); }
    else if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "removed";
    else if (line.startsWith("rename from ")) { current.status = "renamed"; current.previousPath = line.slice("rename from ".length); }
    else if (line.startsWith("copy from ")) { current.status = "copied"; current.previousPath = line.slice("copy from ".length); }
    else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
    else if (line.startsWith("copy to ")) current.path = line.slice("copy to ".length);
    else if (line.startsWith("+++ b/")) current.path = line.slice("+++ b/".length).replace(/\t$/, "");
    else if (line === TOO_LARGE) current.tooLarge = true;
  }
  let held = 0;
  const files = parsed.slice(0, localChangesLimits.files).map((file, index): PullRequestFileView => {
    const view: PullRequestFileView = { path: file.path, ...(file.previousPath && file.previousPath !== file.path ? { previousPath: file.previousPath } : {}),
      status: file.status, additions: file.additions, deletions: file.deletions };
    if (file.tooLarge || (!complete && index === parsed.length - 1)) return { ...view, truncated: true };
    if (!file.lines.length) return view;
    const patch = file.lines.join("\n");
    const size = encoder.encode(patch).length;
    if (size > localChangesLimits.patchBytes || held + size > localChangesLimits.totalPatchBytes) return { ...view, truncated: true };
    held += size;
    return { ...view, patch };
  });
  return { files, additions: parsed.reduce((sum, file) => sum + file.additions, 0), deletions: parsed.reduce((sum, file) => sum + file.deletions, 0),
    omitted: parsed.length - files.length };
}

export class NotARepository extends Error {
  constructor() { super("That directory is not a Git repository in the worktree"); }
}

export function parseLocalChanges(output: string, marker: string, request: LocalChangesRequest): LocalChanges {
  const complete = encoder.encode(output).length < localChangesLimits.outputBytes;
  const sections = `\n${output}`.split(`\n${marker}\n`);
  const selected = (sections[1] ?? "").trim();
  const found = (sections[0] ?? "").split("\n").flatMap((line): LocalRepository[] => {
    const [directory, branch, head] = line.split("\t");
    if (!validChangesDirectory(directory)) return [];
    return [{ directory, branch: branch ? branch.slice(0, 255) : null, head: validChangesCommit(head) ? head : null }];
  }).slice(0, localChangesLimits.repositories);
  const repositories = found.filter(item => item.directory !== "." || item.head !== null || selected === "." || found.length === 1);
  const empty: LocalChanges = { repositories, directory: null, commit: null, files: [], commits: [], additions: 0, deletions: 0 };
  if (sections.length < 3 || !selected) {
    if (request.directory !== undefined) throw new NotARepository();
    return empty;
  }
  if (!validChangesDirectory(selected) || (request.directory !== undefined && selected !== request.directory)) throw new NotARepository();
  if (sections.length < 4) {
    if (complete) throw new NotARepository();
    return { ...empty, directory: selected, commit: request.commit ?? null, truncated: true };
  }
  const unpushed = new Set((sections[3] ?? "").split("\n").filter(validChangesCommit));
  const commits = (sections[2] ?? "").split("\n").flatMap((line): LocalCommit[] => {
    const [sha, author, date, ...subject] = line.split("\t");
    if (!validChangesCommit(sha)) return [];
    return [{ sha, message: subject.join("\t").slice(0, 1000), author: author ? author.slice(0, 255) : null, date: (date ?? "").slice(0, 64), ...(unpushed.has(sha) ? { unpushed: true as const } : {}) }];
  }).slice(0, localChangesLimits.commits);
  const { files, additions, deletions, omitted } = parsePatchFiles(sections.slice(4).join(`\n${marker}\n`), complete);
  return { repositories, directory: selected, commit: request.commit ?? null, files, commits, additions, deletions,
    ...(omitted ? { omitted: { files: omitted } } : {}), ...(complete ? {} : { truncated: true as const }) };
}
