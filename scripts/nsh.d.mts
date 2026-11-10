export const NSH_VERSION: string;
export function nshBinary(): Promise<string>;
export function releaseAsset(url: string, options?: { checksum?: boolean; attempts?: number; delayMs?: number }): Promise<Buffer | string>;
export function buildWeb(out?: string): Promise<void>;
