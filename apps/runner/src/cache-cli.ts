import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BuildCacheStore } from "./build-caches.js";
import { defaultStateDir } from "./connect-setup.js";
import { ConnectorSetupError } from "./protocol.js";
import { RepositoryCache } from "./repo-cache.js";

const HELP = `Usage: pikibun cache <command> [options]

The caches of a connector whose host keeps them (Settings > Hosts > the host > Configuration in Pikibun): the
repository cache, one Git mirror per repository, which clone sessions borrow objects from, and the Git LFS files
sessions downloaded; and the build caches its sessions' commands keep (each workspace's shared copy and each
person's own).

Commands:
  list                    Show each cached repository, its size, and how many sessions keep objects in it
                          (pins: sessions from before every session cloned; kept, never pruned), the Git LFS
                          files kept, and each build cache's size, workspace and whose copy it is
  prune                   Forget clone sessions idle for longer than --older-than, then collect what nothing reaches
                          any more. A clone in a session idle for longer loses the objects it borrowed. Git LFS files
                          no session downloaded for longer are deleted too, and build caches nothing wrote to for
                          longer

Options:
  --state-dir PATH        Connector state (default ~/.local/share/pikibun/connector)
  --build-caches PATH     The build caches' directory, where the connector was started with --build-caches
  --older-than DAYS       For prune: how long a clone session may be idle (default 30)
  --help                  Show this help

Safe to run while the connector runs: each repository is locked while it is pruned, and build caches are
deleted without following links.
`;

export async function cacheMain(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    help: { type: "boolean" }, "state-dir": { type: "string" }, "older-than": { type: "string" }, "build-caches": { type: "string" },
  } });
  const [command, ...extra] = positionals;
  if (values.help || command === undefined) { process.stdout.write(HELP); return; }
  if (extra.length || !["list", "prune"].includes(command)) throw new ConnectorSetupError(`Unknown cache command: ${[command, ...extra].join(" ")}. Run "pikibun cache --help".`);
  const state = resolve(values["state-dir"] ?? defaultStateDir());
  const root = join(state, "repo-cache");
  const cache = new RepositoryCache({ root });
  const builds = new BuildCacheStore(values["build-caches"] ? resolve(values["build-caches"]) : join(state, "build-caches"), { dedicated: values["build-caches"] !== undefined });
  if (command === "list") {
    if (values["older-than"] !== undefined) throw new ConnectorSetupError("--older-than applies to prune only.");
    const repositories = await cache.list();
    const lfs = await cache.lfsUsage();
    const built = await builds.list();
    if (!repositories.length && !lfs.objects && !built.caches.length) { process.stdout.write(`No cached repositories in ${root} and no build caches in ${builds.root}.\n`); return; }
    for (const repository of repositories) {
      process.stdout.write(`${mebibytes(repository.bytes)} MiB  ${String(repository.sessions).padStart(4)} sessions  `
        + `${String(repository.pins).padStart(4)} pins  ${relative(root, repository.directory)}\n`);
    }
    if (lfs.objects) process.stdout.write(`${mebibytes(lfs.bytes)} MiB  ${lfs.objects} Git LFS ${lfs.objects === 1 ? "file" : "files"}\n`);
    for (const item of built.caches) {
      process.stdout.write(`${mebibytes(item.bytes)} MiB  ${String(item.files).padStart(8)} files  build cache ${item.name} of workspace ${item.workspace}, `
        + `${item.scope === "shared" ? "shared" : `owner ${item.owner}`}, last written ${new Date(item.newest).toISOString().slice(0, 10)}\n`);
    }
    if (built.truncated) process.stdout.write("Some build caches hold too many files to count in full; their sizes are partial.\n");
    return;
  }
  const days = Number(values["older-than"] ?? "30");
  if (!Number.isInteger(days) || days < 0 || days > 36500) throw new ConnectorSetupError("--older-than must be a whole number of days.");
  const result = await cache.prune(days * 24 * 60 * 60 * 1000);
  const lfs = await cache.pruneLfs(days * 24 * 60 * 60 * 1000);
  const built = await builds.prune(days * 24 * 60 * 60 * 1000);
  process.stdout.write(`Pruned ${result.repositories} cached ${result.repositories === 1 ? "repository" : "repositories"}; `
    + `forgot ${result.sessions} clone ${result.sessions === 1 ? "session" : "sessions"} idle for more than ${days} days; `
    + `deleted ${lfs.objects} Git LFS ${lfs.objects === 1 ? "file" : "files"} (${mebibytes(lfs.bytes).trim()} MiB) unused for as long; `
    + `deleted ${built.removed} build ${built.removed === 1 ? "cache" : "caches"} (${mebibytes(built.bytes).trim()} MiB) nothing wrote to for as long.\n`);
  if (built.truncated) process.stdout.write("Build caches holding too many files to count in full were kept.\n");
}

function mebibytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1).padStart(9);
}
