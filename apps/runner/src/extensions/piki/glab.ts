import { glabDefinition } from "../../../../../packages/shared/src/cli-definitions.js";
import { cliSpec } from "./cli-engine.js";
import type { CliSpec } from "./command.js";

export const glabSpec: CliSpec = cliSpec(glabDefinition);
