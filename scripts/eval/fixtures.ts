import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Fixture {
  name: string;
  files: Readonly<Record<string, string>>;
  branches?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface ForgeReview { author: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"; body: string }
export interface ForgeScenario {
  pulls?: readonly { number: number; title: string; head: string; draft?: boolean; body?: string }[];
  reviews?: readonly ForgeReview[];
  checks?: readonly { name: string; state: "SUCCESS" | "FAILURE" }[];
  checksPendingMs?: number;
  watchMs?: number;
}

export interface Remote { name: string; path: string; url: string; slug: string; base: string }

export interface ForgePull {
  number: number; title: string; body: string; head: string; base: string; draft: boolean; state: "OPEN" | "MERGED" | "CLOSED";
  mergedOver?: string; method?: string; autoMerge?: boolean; comments?: { body: string }[];
}
export interface ForgeCall { args: string[]; cwd: string; repository: string }

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
});

export async function hostGit(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd: directory, env: gitEnvironment(), maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function tryGit(directory: string, args: readonly string[]): Promise<string | undefined> {
  return hostGit(directory, args).catch(() => undefined);
}

async function writeFiles(directory: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

export async function makeRemote(directory: string, fixture: Fixture): Promise<Remote> {
  const path = join(directory, `${fixture.name}.git`);
  const seed = join(directory, `${fixture.name}.seed`);
  await mkdir(seed, { recursive: true });
  await hostGit(directory, ["init", "--quiet", "--bare", "--initial-branch=main", path]);
  await hostGit(seed, ["init", "--quiet", "--initial-branch=main"]);
  await writeFiles(seed, fixture.files);
  await hostGit(seed, ["add", "-A"]);
  await hostGit(seed, ["commit", "--quiet", "-m", "Initial commit"]);
  await hostGit(seed, ["push", "--quiet", path, "main"]);
  for (const [branch, files] of Object.entries(fixture.branches ?? {})) {
    await hostGit(seed, ["checkout", "--quiet", "-b", branch, "main"]);
    await writeFiles(seed, files);
    await hostGit(seed, ["add", "-A"]);
    await hostGit(seed, ["commit", "--quiet", "-m", `Work on ${branch}`]);
    await hostGit(seed, ["push", "--quiet", path, branch]);
  }
  const base = await hostGit(path, ["rev-parse", "refs/heads/main"]);
  await rm(seed, { recursive: true, force: true });
  return { name: fixture.name, path, url: `file://${path}`, slug: `eval/${fixture.name}`, base };
}

export async function cloneInto(worktree: string, remote: Remote): Promise<string> {
  const directory = join(worktree, remote.name);
  await mkdir(worktree, { recursive: true });
  await hostGit(worktree, ["clone", "--quiet", remote.url, remote.name]);
  return directory;
}

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class Forge {
  private constructor(readonly root: string, readonly bin: string) {}

  static async create(directory: string): Promise<Forge> {
    const root = join(directory, "forge");
    const bin = join(root, "bin");
    await mkdir(join(root, "state"), { recursive: true });
    await mkdir(bin, { recursive: true });
    const stub = fileURLToPath(new URL("./gh-stub.mjs", import.meta.url));
    await writeFile(join(bin, "gh"), `#!/bin/sh\nPIKIBUN_EVAL_FORGE=${quoted(root)} exec ${quoted(process.execPath)} ${quoted(stub)} "$@"\n`);
    await chmod(join(bin, "gh"), 0o755);
    const forge = new Forge(root, bin);
    await forge.reset([], {});
    return forge;
  }

  async reset(remotes: readonly Remote[], scenarios: Readonly<Record<string, ForgeScenario>>): Promise<void> {
    await rm(join(this.root, "state"), { recursive: true, force: true });
    await mkdir(join(this.root, "state"), { recursive: true });
    await writeFile(join(this.root, "calls.jsonl"), "");
    await writeFile(join(this.root, "current.json"), JSON.stringify({ repositories: Object.fromEntries(remotes.map(remote => [remote.name, { remote: remote.path, slug: remote.slug }])) }));
    for (const remote of remotes) {
      const scenario = scenarios[remote.name] ?? {};
      const pulls = (scenario.pulls ?? []).map(pull => ({ number: pull.number, title: pull.title, body: pull.body ?? "", head: pull.head, base: "main", draft: pull.draft === true, state: "OPEN" }));
      await writeFile(join(this.root, "state", `${remote.name}.json`), JSON.stringify({ scenario, pulls }));
    }
  }

  async calls(): Promise<ForgeCall[]> {
    const text = await readFile(join(this.root, "calls.jsonl"), "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as ForgeCall);
  }

  async pulls(name: string): Promise<ForgePull[]> {
    const text = await readFile(join(this.root, "state", `${name}.json`), "utf8").catch(() => "");
    return text ? (JSON.parse(text) as { pulls: ForgePull[] }).pulls : [];
  }
}
