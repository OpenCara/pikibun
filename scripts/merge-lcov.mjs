import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const anonymous = /^anonymous_\d+$/;
const add = (a, b) => (a === undefined || a === "-" ? b : b === "-" ? a : a + b);

function fileRecord(merged, path) {
  let file = merged.get(path);
  if (!file) {
    file = { lines: new Map(), functions: new Map(), branches: new Map() };
    merged.set(path, file);
  }
  return file;
}

function splitPair(value) {
  const comma = value.indexOf(",");
  return [value.slice(0, comma), value.slice(comma + 1)];
}

const functionKey = (line, name) => `${line},${anonymous.test(name) ? "anonymous" : name}`;

export function mergeLcov(reports) {
  const merged = new Map();
  for (const report of reports) {
    let file;
    let branchesOnLine = new Map();
    let functionLines = new Map();
    for (const raw of report.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("SF:")) {
        file = fileRecord(merged, line.slice(3));
        branchesOnLine = new Map();
        functionLines = new Map();
        continue;
      }
      if (!file) continue;
      if (line === "end_of_record") {
        file = undefined;
        continue;
      }
      const colon = line.indexOf(":");
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1);
      if (key === "DA") {
        const [number, hits] = value.split(",");
        file.lines.set(Number(number), add(file.lines.get(Number(number)), Number(hits)));
      } else if (key === "FN") {
        const [number, name] = splitPair(value);
        functionLines.set(name, Number(number));
        const id = functionKey(Number(number), name);
        if (!file.functions.has(id)) file.functions.set(id, { line: Number(number), name, hits: 0 });
      } else if (key === "FNDA") {
        const [hits, name] = splitPair(value);
        const number = functionLines.get(name);
        const fn = number === undefined ? undefined : file.functions.get(functionKey(number, name));
        if (fn) fn.hits += Number(hits);
      } else if (key === "BRDA") {
        const [number, , , hits] = value.split(",");
        const index = branchesOnLine.get(number) ?? 0;
        branchesOnLine.set(number, index + 1);
        const id = `${number},${index}`;
        file.branches.set(id, add(file.branches.get(id), hits === "-" ? "-" : Number(hits)));
      }
    }
  }

  const out = [];
  for (const path of [...merged.keys()].sort()) {
    const file = merged.get(path);
    out.push("TN:", `SF:${path}`);
    let unnamed = 0;
    const functions = [...file.functions.values()]
      .sort((a, b) => a.line - b.line)
      .map(fn => ({ ...fn, name: anonymous.test(fn.name) ? `anonymous_${unnamed++}` : fn.name }));
    for (const fn of functions) out.push(`FN:${fn.line},${fn.name}`);
    for (const fn of functions) out.push(`FNDA:${fn.hits},${fn.name}`);
    out.push(`FNF:${functions.length}`, `FNH:${functions.filter(fn => fn.hits > 0).length}`);
    const branches = [...file.branches.entries()]
      .map(([id, hits]) => [id.split(",").map(Number), hits])
      .sort(([a], [b]) => a[0] - b[0] || a[1] - b[1]);
    branches.forEach(([[number], hits], block) => out.push(`BRDA:${number},${block},0,${hits}`));
    out.push(`BRF:${branches.length}`, `BRH:${branches.filter(([, hits]) => hits !== "-" && hits > 0).length}`);
    const lines = [...file.lines.entries()].sort(([a], [b]) => a - b);
    for (const [number, hits] of lines) out.push(`DA:${number},${hits}`);
    out.push(`LH:${lines.filter(([, hits]) => hits > 0).length}`, `LF:${lines.length}`, "end_of_record");
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [output, ...inputs] = process.argv.slice(2);
  const reports = inputs.filter(file => existsSync(file)).map(file => readFileSync(file, "utf8"));
  if (reports.length) writeFileSync(output, mergeLcov(reports));
  console.log(`Merged ${reports.length} of ${inputs.length} coverage reports into ${output}.`);
}
