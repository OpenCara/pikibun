import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { cliExtensions, type CliExtensionInfo } from "../../../../../packages/shared/src/cli-extensions.js";
import { azureCliExtension } from "./azure-cli.js";
import { ghExtension } from "./gh.js";
import { glabExtension } from "./glab.js";

/*
 * The extensions built into this connector (docs/design/cli-extensions.md), as Pi extension factories: every host
 * has them, as `cli:<name>`, and runs one where its workspace uses it.
 */

const factories: Record<string, ExtensionFactory> = { gh: ghExtension, glab: glabExtension, "azure-cli": azureCliExtension };

export interface CliExtension { info: CliExtensionInfo; factory: ExtensionFactory }

/** This connector's CLI extensions, in the catalogue's order. */
export const connectorCliExtensions: readonly CliExtension[] = cliExtensions.flatMap(info => factories[info.name] ? [{ info, factory: factories[info.name]! }] : []);

/** The path a CLI extension's module has in its summary and in Pi's loader: no file. */
export const cliModulePath = (name: string) => `<cli:${name}>`;
