export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export function lineReader(onLine: (line: string) => void, onOverflow: () => void, limit = MAX_LINE_BYTES): (chunk: Buffer) => void {
  let parts: Buffer[] = [];
  let size = 0;
  return chunk => {
    let start = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      parts.push(chunk.subarray(start, end));
      const line = Buffer.concat(parts).toString("utf8");
      parts = [];
      size = 0;
      start = end + 1;
      if (line) onLine(line);
    }
    if (start < chunk.length) {
      parts.push(chunk.subarray(start));
      size += chunk.length - start;
      if (size > limit) {
        parts = [];
        size = 0;
        onOverflow();
      }
    }
  };
}
