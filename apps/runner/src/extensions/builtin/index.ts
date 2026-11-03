import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { builtinExtensions, type BuiltinExtensionInfo } from "../../../../../packages/shared/src/builtin-extensions.js";
import { azureCliExtension } from "./azure-cli.js";
import { ghExtension } from "./gh.js";
import { glabExtension } from "./glab.js";

/*
 * The extensions built into this connector (docs/design/builtin-extensions.md), as Pi extension factories: every host
 * has them, as `builtin:<name>`, and runs one where its workspace uses it.
 */

const factories: Record<string, ExtensionFactory> = { gh: ghExtension, glab: glabExtension, "azure-cli": azureCliExtension };

export interface BuiltinExtension { info: BuiltinExtensionInfo; factory: ExtensionFactory }

/** This connector's built-in extensions, in the catalogue's order. */
export const connectorBuiltins: readonly BuiltinExtension[] = builtinExtensions.flatMap(info => factories[info.name] ? [{ info, factory: factories[info.name]! }] : []);

/** The path a built-in extension's module has in its summary and in Pi's loader: no file. */
export const builtinModulePath = (name: string) => `<builtin:${name}>`;
