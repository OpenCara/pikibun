export const NSH_VERSION: string;
export const NSH_COMMIT: string;
export const NSH_ASSET_SHA256: Readonly<Record<string, string>>;
export function nshBinary(): Promise<string>;
export function releaseAsset(url: string, options?: { attempts?: number; delayMs?: number }): Promise<Buffer>;
export function checkAsset(asset: string, bytes: Uint8Array): void;
export function buildWeb(out?: string): Promise<void>;
