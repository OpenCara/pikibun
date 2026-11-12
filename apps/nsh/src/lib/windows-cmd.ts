// Command lines for cmd.exe, which runs Pikibun's own commands on Windows. No imports: tests/windows-cmd.test.ts runs
// them through a real cmd.exe on Windows.
//
// cmd.exe writes its own messages, such as "'pikibun' is not recognized as an internal or external command", in
// Windows' display language and in the console's code page, while nsh reads a child's output as UTF-8. On a Chinese,
// Japanese or Korean Windows (GBK, Shift-JIS, UHC, ...) they came out as U+FFFD, and the English pattern that tells a
// missing command never matched, so the owner saw mojibake instead of the offer to install it. So each line switches
// its console to UTF-8 first (chcp 65001, silent where there's no console to switch), and asks where.exe whether the
// program is there at all, exiting 9009, cmd's own code for a missing command, when it isn't, in any language.

export const CMD = "cmd";

const UTF8 = ["chcp", "65001", ">nul", "2>nul", "&"];

export const UNREADABLE = "\uFFFD";

/** cmd's arguments for a line: no AutoRun (/d), then UTF-8, then the line's words. */
export function cmdArgs(words: readonly string[]): string[] {
  return ["/d", "/c", ...UTF8, ...words];
}

/** Runs program with args when PATH has it, else exits 9009. */
export function cmdRun(program: string, args: readonly string[]): string[] {
  return ["(", "where", "/q", program, "||", "exit", "9009", ")", "&&", program, ...args];
}

/** Runs own (a relative path to a .cmd) where it exists, else program from PATH as cmdRun does. */
export function cmdRunOwn(own: string, program: string, args: readonly string[]): string[] {
  return ["if", "exist", own, "(", own, ...args, ")", "else", "(", ...cmdRun(program, args), ")"];
}

/** The last few lines of a command's output for a message, or "" where they aren't readable text. */
export function lastLines(lines: readonly string[], count = 3): string {
  const last = lines.map(line => line.trim()).filter(Boolean).slice(-count).join(" ");
  return last.includes(UNREADABLE) ? "" : last;
}
