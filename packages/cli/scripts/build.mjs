import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const repository = join(root, "..", "..");
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

await Promise.all([
  build({
    entryPoints: { cli: join(root, "src/cli.ts"), "extension-worker": join(repository, "apps/runner/src/extensions/child.ts") }, outdir: out, chunkNames: "chunks/[name]-[hash]",
    bundle: true, splitting: true, platform: "node", format: "esm", target: "node24", packages: "external", logLevel: "warning",
    define: { __PIKIBUN_VERSION__: JSON.stringify(version) },
  }),
  build({
    entryPoints: [join(root, "src/pikibun.ts")], outfile: join(out, "pikibun.js"),
    platform: "node", format: "esm", target: "node16", banner: { js: "#!/usr/bin/env node" }, logLevel: "warning",
  }),
]);

const web = join(repository, "dist", "client");
if (!existsSync(join(web, "index.html"))) throw new Error("dist/client is missing: run `pnpm build` at the repository root first.");
cpSync(web, join(out, "web"), { recursive: true, filter: source => !/\.(?:br|gz)$/.test(source) });
cpSync(join(repository, "apps", "server", "migrations"), join(out, "migrations"), { recursive: true });
