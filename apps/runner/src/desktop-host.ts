// The connector host the Electron app bundles (apps/desktop/scripts/build.mjs): run in a utility process, or inside WSL2
// with --stdio. Everything it does is in app-host.ts, which the CLI's `pikibun host` runs too.
import { runAppHost } from "./app-host.js";

runAppHost(process.argv.slice(2));
