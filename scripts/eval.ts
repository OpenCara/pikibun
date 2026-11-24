import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConnectorModels } from "../apps/runner/src/connect-setup.js";
import { thinkingLevels, type ThinkingLevel } from "../packages/shared/src/types.js";
import { Forge } from "./eval/fixtures.js";
import { compare, parseResult, regressions, renderReport } from "./eval/report.js";
import { runEval } from "./eval/run.js";
import { scriptedModels } from "./eval/scripted.js";
import { startStack } from "./eval/stack.js";
import { selectTasks, tasks } from "./eval/tasks.js";

const HELP = `Usage: node --import tsx scripts/eval.ts --model PROVIDER/MODEL --unsafe-no-sandbox [options]

Runs the task-completion eval for session instructions (docs/design/task-eval.md): each golden task in a new
session on a Pikibun server and host started for the run, in a temporary directory, with a model Pi is
configured with on this computer. It writes a JSON result and prints a table.

  --model PROVIDER/MODEL   The model the sessions run on, as Pi names it (required to run)
  --unsafe-no-sandbox      Required: the eval's host runs the model's commands on this computer without
                           isolation, as your user. Run it in a container, a virtual machine or a Pikibun
                           session, never beside data you care about
  --runs N                 Runs of each task (default 3)
  --task ID                Run only this task (repeatable); --list names them
  --thinking LEVEL         Reasoning level for every message (${thinkingLevels.join(", ")})
  --compare FILE           An earlier result: the table then says which tasks flipped
  --fail-on-regression     With --compare, exit with status 2 when a task regressed
  --out FILE               Where the JSON result goes (default eval-results/<time>-<model>.json)
  --label TEXT             A note kept in the result, such as "before" or the change's name
  --pi-agent-dir PATH      Pi's configuration directory (default: Pi's own)
  --timeout-scale X        Multiply every task's time limit (default 1)
  --keep                   Keep the temporary directory (sessions' worktrees, fixtures) and print its path
  --list                   List the tasks and exit
  --report FILE            Print a result file's table (with --compare, against another) and exit
  --dry-run                Instead of --model: a stand-in that answers every message without doing
                           anything, so every task fails. It shows that the eval starts and reports here
                           before a model is paid for
  --help                   Show this help
`;

const { values } = parseArgs({ options: {
  model: { type: "string" }, "unsafe-no-sandbox": { type: "boolean" }, runs: { type: "string", default: "3" }, task: { type: "string", multiple: true },
  thinking: { type: "string" }, compare: { type: "string" }, "fail-on-regression": { type: "boolean" }, out: { type: "string" }, label: { type: "string" },
  "pi-agent-dir": { type: "string" }, "timeout-scale": { type: "string", default: "1" }, keep: { type: "boolean" }, list: { type: "boolean" },
  report: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
} });

function stop(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const repository = fileURLToPath(new URL("../", import.meta.url));

function commit(): string | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return `${head}${dirty ? "-dirty" : ""}`;
  } catch { return undefined; }
}

if (values.help) { process.stdout.write(HELP); process.exit(0); }
if (values.list) {
  process.stdout.write(`${tasks.map(task => `${task.id}\t${task.title}`).join("\n")}\n`);
  process.exit(0);
}
const previous = values.compare ? parseResult(await readFile(values.compare, "utf8").catch(() => stop(`--compare: ${values.compare} can't be read.`))) : undefined;
if (values.report) {
  process.stdout.write(renderReport(parseResult(await readFile(values.report, "utf8").catch(() => stop(`--report: ${values.report} can't be read.`))), previous));
  process.exit(0);
}

const dry = values["dry-run"] === true;
if (dry && values.model) stop("--dry-run asks no model: leave --model out.");
const named = dry ? "faux/dry-run" : values.model ?? "";
const slash = named.indexOf("/");
if (slash < 1 || slash === named.length - 1) stop("Name the model the sessions run on: --model PROVIDER/MODEL. --help says more.");
if (!values["unsafe-no-sandbox"]) stop("The eval's host runs the model's commands on this computer without isolation, as your user: pass --unsafe-no-sandbox to accept that, "
  + "and run it in a container, a virtual machine or a Pikibun session.");
if (process.platform === "win32") stop("The eval runs on Linux and macOS: its forge stand-in is a shell launcher.");
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 20) stop("--runs is a number from 1 to 20.");
const timeoutScale = Number(values["timeout-scale"]);
if (!(timeoutScale > 0 && timeoutScale <= 20)) stop("--timeout-scale is a number above 0, at most 20.");
if (values.thinking !== undefined && !thinkingLevels.includes(values.thinking as ThinkingLevel)) stop(`--thinking is one of ${thinkingLevels.join(", ")}.`);
const model = { provider: named.slice(0, slash), modelId: named.slice(slash + 1) };
let chosen: ReturnType<typeof selectTasks>;
try { chosen = selectTasks(values.task ?? []); } catch (error) { stop(error instanceof Error ? error.message : String(error)); }
const localModels = dry ? scriptedModels(() => ({ text: "Dry run: no model was asked, so nothing was done." }), model.modelId)
  : await loadConnectorModels({ piAgentDir: values["pi-agent-dir"], models: [model] })
    .catch((error: unknown) => stop(`${named} can't be used: ${error instanceof Error ? error.message : String(error)}`));

const directory = await mkdtemp(join(tmpdir(), "pikibun-eval-"));
const log = (line: string) => process.stderr.write(`${line}\n`);
let status = 0;
const forge = await Forge.create(directory);
const stack = await startStack({ directory, localModels, model, allowFaux: dry, path: [forge.bin], log });
const interrupted = () => { void stack.stop().finally(() => process.exit(130)); };
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  log(`${chosen.length} ${chosen.length === 1 ? "task" : "tasks"}, ${runs} ${runs === 1 ? "run" : "runs"} each, on ${named}`);
  const result = await runEval({ stack, forge, directory, tasks: chosen, runs, timeoutScale, log, commit: commit(),
    ...(values.label ? { label: values.label } : {}), ...(values.thinking ? { thinkingLevel: values.thinking as ThinkingLevel } : {}) });
  const out = resolve(values.out ?? join(repository, "eval-results", `${result.startedAt.replace(/[:.]/g, "-")}-${named.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`\n${renderReport(result, previous)}\nResult: ${out}\n`);
  if (previous && values["fail-on-regression"] && regressions(compare(previous, result)).length) status = 2;
} finally {
  await stack.stop();
  if (values.keep) log(`Kept ${directory}`);
  else await rm(directory, { recursive: true, force: true });
}
process.exit(status);
