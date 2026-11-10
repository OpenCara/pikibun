export interface ToolCallLine {
  name: string;
  line: string;
}

const toolCallLine = /^([a-z_]+)\(\{.*\}\)$/s;
const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/s;

export function transcriptLines(text: string): { line: string; tool?: string }[] {
  const lines: { line: string; tool?: string }[] = [];
  let fence = "";
  for (const line of text.split("\n")) {
    const marker = fenceLine.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = "";
      lines.push({ line });
      continue;
    }
    if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = marker[1]!;
      lines.push({ line });
      continue;
    }
    const call = toolCallLine.exec(line);
    lines.push(call ? { line, tool: call[1]! } : { line });
  }
  return lines;
}

export function splitToolCalls(text: string): { prose: string; calls: ToolCallLine[] } {
  const prose: string[] = [];
  const calls: ToolCallLine[] = [];
  for (const { line, tool } of transcriptLines(text)) {
    if (tool !== undefined) calls.push({ name: tool, line });
    else prose.push(line);
  }
  return { prose: prose.join("\n"), calls };
}
