export const CMD = "cmd";

const UTF8 = ["chcp", "65001", ">nul", "2>nul", "&"];

export const UNREADABLE = "\uFFFD";

export function cmdArgs(words: readonly string[]): string[] {
  return ["/d", "/c", ...UTF8, ...words];
}

export function cmdRun(program: string, args: readonly string[]): string[] {
  return ["(", "where", "/q", program, "||", "exit", "9009", ")", "&&", program, ...args];
}

export function cmdRunOwn(own: string, program: string, args: readonly string[]): string[] {
  return ["if", "exist", own, "(", own, ...args, ")", "else", "(", ...cmdRun(program, args), ")"];
}

export function lastLines(lines: readonly string[], count = 3): string {
  const last = lines.map(line => line.trim()).filter(Boolean).slice(-count).join(" ");
  return last.includes(UNREADABLE) ? "" : last;
}
