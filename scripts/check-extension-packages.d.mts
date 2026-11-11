export function extensionNames(): string[];
export function packedFiles(directory: string): string[];
export function packageProblems(directory: string, options?: { files?: string[]; release?: boolean }): string[];
