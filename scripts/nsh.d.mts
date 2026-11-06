/** The Native Shell CLI version the client is built with. */
export const NSH_VERSION: string;
/** The nsh executable: NSH_BIN, the pinned release (downloaded once into .cache/nsh), or nsh on PATH. */
export function nshBinary(): Promise<string>;
/** Packages the client for the web into `out` (dist/web by default). */
export function buildWeb(out?: string): Promise<void>;
