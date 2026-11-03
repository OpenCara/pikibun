import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { pikiExtensions, type PikiExtensionInfo } from "../../../../../packages/shared/src/piki-extensions.js";
import { azurePikiExtension } from "./azure-cli.js";
import { ghExtension } from "./gh.js";
import { glabExtension } from "./glab.js";
import { promptAuditExtension } from "./prompt-audit.js";

/*
 * The extensions built into this connector (docs/design/piki-extensions.md), as Pi extension factories: every host
 * has them, as `piki:<name>`, and runs one where its workspace uses it.
 */

const factories: Record<string, ExtensionFactory> = { gh: ghExtension, glab: glabExtension, "azure-cli": azurePikiExtension, "prompt-audit": promptAuditExtension };

export interface PikiExtension { info: PikiExtensionInfo; factory: ExtensionFactory }

/** This connector's Pikibun extensions, in the catalogue's order. */
export const connectorPikiExtensions: readonly PikiExtension[] = pikiExtensions.flatMap(info => factories[info.name] ? [{ info, factory: factories[info.name]! }] : []);

/** The path a Pikibun extension's module has in its summary and in Pi's loader: no file. */
export const pikiModulePath = (name: string) => `<piki:${name}>`;
