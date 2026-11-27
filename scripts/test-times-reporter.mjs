import { relative } from "node:path";

export default async function* testTimes(source) {
  const times = {};
  for await (const event of source) {
    if (event.type !== "test:complete") continue;
    const { file, name, nesting, details } = event.data;
    if (!file || nesting !== 0 || typeof details?.duration_ms !== "number") continue;
    const path = relative(process.cwd(), file).replaceAll("\\", "/");
    if (String(name).replaceAll("\\", "/").replace(/^\.\//, "") !== path) continue;
    times[path] = details.duration_ms;
  }
  const seconds = Object.entries(times).sort(([a], [b]) => a.localeCompare(b)).map(([file, ms]) => [file, Math.round(ms / 100) / 10]);
  yield `${JSON.stringify(Object.fromEntries(seconds), null, 2)}\n`;
}
