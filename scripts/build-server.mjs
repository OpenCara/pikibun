import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export const optionalNative = ["pg-native", "bufferutil", "utf-8-validate"];

export async function buildServer(out = `${root}dist/server`) {
  rmSync(out, { recursive: true, force: true });
  await build({
    entryPoints: [`${root}apps/server/src/main.ts`],
    outfile: `${out}/main.js`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: optionalNative,
    banner: { js: "import { createRequire as __pikibunRequire } from 'node:module'; const require = __pikibunRequire(import.meta.url);" },
    legalComments: "linked",
    logLevel: "warning",
  });
  cpSync(`${root}apps/server/migrations`, `${out}/migrations`, { recursive: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildServer(process.argv[2]);
