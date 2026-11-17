import { pathToFileURL } from "node:url";
import { managedExtensions, type ManagedExtensionPin } from "../packages/shared/src/managed-extensions.js";
import { MINIMUM_CONNECTOR_VERSION } from "../packages/shared/src/version.js";

export interface Published { integrity?: string }
export type Registry = (name: string, version: string) => Promise<Published | undefined>;

export function npmRegistry(fetcher: typeof fetch = fetch, origin = "https://registry.npmjs.org"): Registry {
  return async (name, version) => {
    const response = await fetcher(`${origin}/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`npm answered HTTP ${response.status} for ${name}@${version}`); }
    const body = await response.json() as { dist?: { integrity?: unknown } } | null;
    const integrity = body?.dist?.integrity;
    return typeof integrity === "string" ? { integrity } : {};
  };
}

function extensionName(pin: ManagedExtensionPin): string {
  return pin.source.slice("piki:".length);
}

export async function releaseProblems(options: { minimumConnector: string; pins: readonly ManagedExtensionPin[]; registry: Registry }): Promise<string[]> {
  const problems: string[] = [];
  const connectors = new Map<string, Promise<Published | undefined>>();
  const connector = (version: string) => {
    if (!connectors.has(version)) connectors.set(version, options.registry("pikibun", version));
    return connectors.get(version)!;
  };
  if (!await connector(options.minimumConnector)) {
    problems.push(`The server needs connector ${options.minimumConnector} (MINIMUM_CONNECTOR_VERSION in packages/shared/src/version.ts), which npm doesn't have: `
      + `release the connector first (cli-v${options.minimumConnector}), and tag the server once npm shows it.`);
  }
  for (const pin of options.pins) {
    const published = await options.registry(pin.package, pin.version);
    if (!published) {
      problems.push(`${pin.source} is pinned to ${pin.package}@${pin.version} (packages/shared/src/managed-extensions.ts), which npm doesn't have: `
        + `release it first (ext-${extensionName(pin)}-v${pin.version}), and pin it once npm shows it.`);
    } else if (published.integrity !== pin.integrity) {
      problems.push(`${pin.source}'s pin of ${pin.package}@${pin.version} names integrity ${pin.integrity}, but npm has ${published.integrity ?? "none"}: `
        + `copy the digest npm shows (npm view ${pin.package}@${pin.version} dist.integrity).`);
    }
    if (!await connector(pin.minimumConnector)) {
      problems.push(`${pin.source}'s pin needs connector ${pin.minimumConnector}, which npm doesn't have: release the connector first.`);
    }
  }
  return problems;
}

export async function main(registry: Registry = npmRegistry()): Promise<number> {
  const problems = await releaseProblems({ minimumConnector: MINIMUM_CONNECTOR_VERSION, pins: managedExtensions, registry });
  for (const problem of problems) console.error(`::error::${problem}`);
  if (!problems.length) {
    console.log(`npm has connector ${MINIMUM_CONNECTOR_VERSION}, the server's minimum, and ${managedExtensions.length ? `every pinned extension (${managedExtensions.map(pin => `${pin.package}@${pin.version}`).join(", ")})` : "no extension is pinned"}.`);
  }
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
