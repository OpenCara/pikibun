import { GH_WATCH_INTERVAL_SECONDS, ghDefinition } from "../../../../../packages/shared/src/cli-definitions.js";
import { cliSpec } from "./cli-engine.js";
import type { CliSpec } from "./command.js";

export { GH_WATCH_INTERVAL_SECONDS };

export const ghSpec: CliSpec = cliSpec(ghDefinition);

export const watchInterval: (args: readonly string[]) => readonly string[] = ghSpec.prepare!;
