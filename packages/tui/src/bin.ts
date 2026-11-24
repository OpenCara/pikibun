import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./launcher.js";

process.exitCode = await main(process.argv.slice(2), path.dirname(path.dirname(fileURLToPath(import.meta.url))));
