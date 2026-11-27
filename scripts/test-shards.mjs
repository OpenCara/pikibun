import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function shardFiles(files, timings, total) {
  const known = files.map(file => timings[file]).filter(seconds => typeof seconds === "number").sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = file => (typeof timings[file] === "number" ? timings[file] : median);
  const shards = Array.from({ length: total }, () => ({ files: [], load: 0 }));
  for (const file of [...new Set(files)].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.files.push(file);
    lightest.load += weight(file);
  }
  return shards.map(shard => shard.files.sort());
}

export function mergeTimings(reports) {
  const merged = {};
  for (const report of reports) for (const [file, seconds] of Object.entries(report)) merged[file] = seconds;
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

function main([command, ...args]) {
  if (command === "pick") {
    const [shard, ...files] = args;
    const match = /^(\d+)\/(\d+)$/.exec(shard ?? "");
    if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) throw new Error(`pick takes INDEX/TOTAL, such as 2/4, not ${shard}`);
    const timingsFile = new URL("../tests/timings.json", import.meta.url);
    const timings = existsSync(timingsFile) ? JSON.parse(readFileSync(timingsFile, "utf8")) : {};
    console.log(shardFiles(files, timings, Number(match[2]))[Number(match[1]) - 1].join("\n"));
  } else if (command === "timings") {
    const [output, ...inputs] = args;
    const reports = inputs.filter(file => existsSync(file)).map(file => JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(output, `${JSON.stringify(mergeTimings(reports), null, 2)}\n`);
    console.log(`Merged ${reports.length} of ${inputs.length} timing reports into ${output}.`);
  } else {
    throw new Error("usage: test-shards.mjs pick INDEX/TOTAL FILE... | timings OUTPUT INPUT...");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
