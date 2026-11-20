import { azureCliDefinition } from "../../../../../packages/shared/src/cli-definitions.js";
import { cliSpec } from "./cli-engine.js";
import type { CliSpec } from "./command.js";

export const azureCliSpec: CliSpec = cliSpec(azureCliDefinition);
