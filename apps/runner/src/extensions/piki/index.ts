import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { pikiExtensions, type PikiExtensionInfo } from "../../../../../packages/shared/src/piki-extensions.js";
import { azureCliSpec } from "./azure-cli.js";
import { commandExtension, noPikiSession, type CliSpec, type PikiSession } from "./command.js";
import { ghSpec } from "./gh.js";
import { glabSpec } from "./glab.js";
import { promptAuditExtension } from "../../../../../extensions/prompt-audit/prompt-audit.js";
import { prFlowExtension } from "../../../../../extensions/pr-flow/pr-flow.js";
import { contextFilesExtension } from "../../../../../extensions/context-files/context-files.js";

const specs: Record<string, CliSpec> = { gh: ghSpec, glab: glabSpec, "azure-cli": azureCliSpec };
const factories: Record<string, ExtensionFactory> = { "prompt-audit": promptAuditExtension, "pr-flow": prFlowExtension, "context-files": contextFilesExtension };

export interface PikiExtension {
  info: PikiExtensionInfo;
  factory: ExtensionFactory;
  forSession(session: PikiSession): ExtensionFactory;
}

const sessionToolsFactory: ExtensionFactory = () => {};

export const connectorPikiExtensions: readonly PikiExtension[] = pikiExtensions.flatMap((info): PikiExtension[] => {
  if (info.sessionTools) return [{ info, factory: sessionToolsFactory, forSession: () => sessionToolsFactory }];
  const spec = specs[info.name];
  if (spec) return [{ info, factory: commandExtension(spec, noPikiSession), forSession: session => commandExtension(spec, session) }];
  const factory = factories[info.name];
  return factory ? [{ info, factory, forSession: () => factory }] : [];
});

export const connectorPikiExtension = (source: string) => connectorPikiExtensions.find(item => item.info.source === source);

export const pikiModulePath = (name: string) => `<piki:${name}>`;
