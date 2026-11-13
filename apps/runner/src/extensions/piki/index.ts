import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { pikiExtension, pikiExtensions, type PikiExtensionInfo } from "../../../../../packages/shared/src/piki-extensions.js";
import { azureCliSpec } from "./azure-cli.js";
import { commandExtension, noPikiSession, type CliSpec, type PikiSession } from "./command.js";
import { ghSpec } from "./gh.js";
import { glabSpec } from "./glab.js";
import { promptAuditExtension } from "../../../../../extensions/prompt-audit/prompt-audit.js";
import { prFlowExtension } from "../../../../../extensions/pr-flow/pr-flow.js";
import { contextFilesExtension } from "../../../../../extensions/context-files/context-files.js";
import promptAuditPackage from "../../../../../extensions/prompt-audit/package.json" with { type: "json" };
import prFlowPackage from "../../../../../extensions/pr-flow/package.json" with { type: "json" };
import contextFilesPackage from "../../../../../extensions/context-files/package.json" with { type: "json" };

const specs: Record<string, CliSpec> = { gh: ghSpec, glab: glabSpec, "azure-cli": azureCliSpec };
const packages: Record<string, { factory: ExtensionFactory; version: string }> = {
  "prompt-audit": { factory: promptAuditExtension, version: promptAuditPackage.version },
  "pr-flow": { factory: prFlowExtension, version: prFlowPackage.version },
  "context-files": { factory: contextFilesExtension, version: contextFilesPackage.version },
};

export const bundledOnlySources: ReadonlySet<string> = new Set(["piki:prompt-audit"]);

export interface PikiExtension {
  info: PikiExtensionInfo;
  factory: ExtensionFactory;
  forSession(session: PikiSession): ExtensionFactory;
  version?: string;
}

const sessionToolsFactory: ExtensionFactory = () => {};

export const connectorPikiExtensions: readonly PikiExtension[] = pikiExtensions.flatMap((info): PikiExtension[] => {
  if (info.sessionTools) return [{ info, factory: sessionToolsFactory, forSession: () => sessionToolsFactory }];
  const spec = specs[info.name];
  if (spec) return [{ info, factory: commandExtension(spec, noPikiSession), forSession: session => commandExtension(spec, session) }];
  const bundled = packages[info.name];
  return bundled ? [{ info, factory: bundled.factory, forSession: () => bundled.factory, version: bundled.version }] : [];
});

export const connectorPikiExtension = (source: string) => connectorPikiExtensions.find(item => item.info.source === source);

export function managedSource(source: string, bundled: readonly PikiExtension[] = connectorPikiExtensions): boolean {
  if (bundledOnlySources.has(source)) return false;
  const copy = bundled.find(item => item.info.source === source);
  if (copy) return copy.version !== undefined;
  const info = pikiExtension(source);
  return !info || (info.tool === undefined && info.sessionTools === undefined && info.controlPlane !== true);
}

export const pikiModulePath = (name: string) => `<piki:${name}>`;
