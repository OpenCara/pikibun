export function checkDeployment(origin: string, client: "web" | "nsh", expectedVersion?: string): Promise<{ ok: true; version?: string }>;
export function main(): Promise<void>;
