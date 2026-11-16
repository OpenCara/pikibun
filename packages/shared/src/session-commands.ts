export const sessionCommandKinds = ["host", "extension", "prompt", "skill"] as const;
export type SessionCommandKind = (typeof sessionCommandKinds)[number];

export interface SessionCommand {
  name: string;
  kind: SessionCommandKind;
  description?: string;
  argument?: string;
}

export const sessionCommandLimits = Object.freeze({ commands: 200, perKind: 100, files: 1000, name: 128, description: 300, argument: 60, notice: 2000 });

const NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const shown = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, limit);
  return text || undefined;
};

export function parseSessionCommands(value: unknown): SessionCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: SessionCommand[] = [];
  const taken = new Set<string>();
  for (const item of value) {
    if (commands.length >= sessionCommandLimits.commands) break;
    if (!item || typeof item !== "object") continue;
    const { name, kind, description, argument } = item as Record<string, unknown>;
    if (typeof name !== "string" || name.length > sessionCommandLimits.name || !NAME.test(name) || taken.has(name)) continue;
    if (!(sessionCommandKinds as readonly unknown[]).includes(kind)) continue;
    taken.add(name);
    const text = shown(description, sessionCommandLimits.description);
    const hint = shown(argument, sessionCommandLimits.argument);
    commands.push({ name, kind: kind as SessionCommandKind, ...(text ? { description: text } : {}), ...(hint ? { argument: hint } : {}) });
  }
  return commands;
}
