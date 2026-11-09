/** The Native Shell CLI version the client is built with. */
export const NSH_VERSION: string;
/** The nsh executable: NSH_BIN, the pinned release (downloaded once into .cache/nsh), or nsh on PATH. */
export function nshBinary(): Promise<string>;
export function releaseAsset(url: string, options?: { checksum?: boolean; attempts?: number; delayMs?: number }): Promise<Buffer | string>;
/** Packages the client for the web into `out` (dist/preview by default). */
export function buildWeb(out?: string): Promise<void>;
