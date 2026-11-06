import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { pikiExtensions, type PikiExtensionInfo } from "../../../../../packages/shared/src/piki-extensions.js";
import { azureCliSpec } from "./azure-cli.js";
import { commandExtension, noPikiSession, type CliSpec, type PikiSession } from "./command.js";
import { ghSpec } from "./gh.js";
import { glabSpec } from "./glab.js";
import { promptAuditExtension } from "../../../../../extensions/prompt-audit/prompt-audit.js";

/*
 * The extensions built into this connector (docs/design/piki-extensions.md), as Pi extension factories: every host
 * has them, as `piki:<name>`, and runs one where its workspace uses it.
 */

/** The command-line tools, which each session runs as it may (in its sandbox, or with the host's sign-in). */
const specs: Record<string, CliSpec> = { gh: ghSpec, glab: glabSpec, "azure-cli": azureCliSpec };
/** The others, the same in every session. */
const factories: Record<string, ExtensionFactory> = { "prompt-audit": promptAuditExtension };

export interface PikiExtension {
  info: PikiExtensionInfo;
  /** Its factory where no session runs it (what it offers, for the host's report): a command-line tool says it can't run. */
  factory: ExtensionFactory;
  /** Its factory for one session, which runs a command-line tool as `session` allows. */
  forSession(session: PikiSession): ExtensionFactory;
}

/**
 * A session-tool extension (`sessionTools`) registers nothing in Pi: its tools are the session's own, which the session
 * offers while its workspace leaves the extension on. The connector still has it, so it reports it like the others.
 */
const sessionToolsFactory: ExtensionFactory = () => {};

/** This connector's Pikibun extensions, in the catalogue's order. */
export const connectorPikiExtensions: readonly PikiExtension[] = pikiExtensions.flatMap((info): PikiExtension[] => {
  if (info.sessionTools) return [{ info, factory: sessionToolsFactory, forSession: () => sessionToolsFactory }];
  const spec = specs[info.name];
  if (spec) return [{ info, factory: commandExtension(spec, noPikiSession), forSession: session => commandExtension(spec, session) }];
  const factory = factories[info.name];
  return factory ? [{ info, factory, forSession: () => factory }] : [];
});

/** The Pikibun extension `source` names, if this connector has it. */
export const connectorPikiExtension = (source: string) => connectorPikiExtensions.find(item => item.info.source === source);

/** The path a Pikibun extension's module has in its summary and in Pi's loader: no file. */
export const pikiModulePath = (name: string) => `<piki:${name}>`;
