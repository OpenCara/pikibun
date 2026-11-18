export const RELEASE_VERSION: RegExp;
export function compareReleaseVersions(a: string, b: string): number;
export function latestExtensionRelease(tags: readonly string[], name: string): string | undefined;
