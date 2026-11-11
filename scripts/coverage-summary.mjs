import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const areas = ["apps/server", "apps/runner", "apps/nsh", "packages/shared", "packages/client", "packages/cli", "extensions"];

export function coverageSummary(lcov, root = process.cwd()) {
  const totals = new Map();
  let file;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      const path = line.slice(3).replaceAll("\\", "/");
      const relative = path.startsWith(`${root.replaceAll("\\", "/")}/`) ? path.slice(root.length + 1) : path;
      const area = areas.find(name => relative === name || relative.startsWith(`${name}/`)) ?? "other";
      file = totals.get(area) ?? { lines: 0, linesHit: 0, branches: 0, branchesHit: 0, files: 0 };
      file.files++;
      totals.set(area, file);
      continue;
    }
    if (!file) continue;
    const [key, value] = line.split(":");
    const count = Number(value);
    if (key === "LF") file.lines += count;
    else if (key === "LH") file.linesHit += count;
    else if (key === "BRF") file.branches += count;
    else if (key === "BRH") file.branchesHit += count;
    else if (line === "end_of_record") file = undefined;
  }
  const percent = (hit, all) => all ? `${(100 * hit / all).toFixed(1)}%` : "–";
  const rows = [...totals.entries()].sort(([a], [b]) => areas.indexOf(a) - areas.indexOf(b) || a.localeCompare(b));
  const all = rows.reduce((sum, [, area]) => ({ lines: sum.lines + area.lines, linesHit: sum.linesHit + area.linesHit,
    branches: sum.branches + area.branches, branchesHit: sum.branchesHit + area.branchesHit, files: sum.files + area.files }),
  { lines: 0, linesHit: 0, branches: 0, branchesHit: 0, files: 0 });
  return [
    "## Test coverage",
    "",
    "| Area | Files | Lines | Branches |",
    "|---|---:|---:|---:|",
    ...rows.map(([name, area]) => `| ${name} | ${area.files} | ${percent(area.linesHit, area.lines)} | ${percent(area.branchesHit, area.branches)} |`),
    `| **All** | ${all.files} | ${percent(all.linesHit, all.lines)} | ${percent(all.branchesHit, all.branches)} |`,
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? "lcov.info";
  console.log(existsSync(file) ? coverageSummary(readFileSync(file, "utf8")) : `## Test coverage\n\nNo ${file} was written.\n`);
}
