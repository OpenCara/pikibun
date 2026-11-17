export const sessionTitleLimits = { length: 50, cutAfter: 25, prompt: 4000, system: 2000, message: 8000, reply: 2000 } as const;

export function fallbackTitle(content: string): string {
  const oneLine = content.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
  const characters = Array.from(oneLine);
  if (characters.length <= sessionTitleLimits.length) return oneLine;
  const cut = characters.slice(0, sessionTitleLimits.length).join("");
  const lastSpace = cut.lastIndexOf(" ");
  const atWord = lastSpace >= sessionTitleLimits.cutAfter ? cut.slice(0, lastSpace) : cut;
  return `${atWord.trimEnd()}…`;
}

export interface SessionTitleRequest { system: string; message: string }

export function sessionTitleRequest(content: string): SessionTitleRequest {
  return {
    system: "You name conversations. Reply with the title alone: at most six words, in the language of the message, without quotes, labels, or a final period.",
    message: `Write a title for a conversation that begins with this message:\n\n<message>\n${Array.from(content.trim()).slice(0, sessionTitleLimits.prompt).join("")}\n</message>`,
  };
}

const wrappers: readonly (readonly [string, string])[] = [["**", "**"], ["__", "__"], ['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["«", "»"], ["「", "」"],
  ["『", "』"], ["`", "`"], ["*", "*"], ["_", "_"]];
const headingMark = /^#+\s*/;
const finalPeriods = /[.。]+$/;
const titleLabel = /^(?:\*\*|__)?title(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*/i;

export function cleanTitle(reply: string): string {
  const firstLine = reply.split("\n").map(line => line.trim()).find(Boolean) ?? "";
  let title = firstLine.replace(headingMark, "").replace(titleLabel, "");
  for (let unwrapped = true; unwrapped;) {
    title = title.replace(finalPeriods, "").trim();
    const pair = wrappers.find(([open, close]) => title.length >= open.length + close.length && title.startsWith(open) && title.endsWith(close));
    unwrapped = pair !== undefined;
    if (pair) title = title.slice(pair[0].length, -pair[1].length);
  }
  return fallbackTitle(title);
}
