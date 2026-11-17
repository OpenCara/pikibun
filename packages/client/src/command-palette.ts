export type CommandScope = "session" | "global";

export interface PaletteCommand {
  id: string;
  title: string;
  group: string;
  scope: CommandScope;
  keywords?: readonly string[];
  disabled?: string;
}

export interface PaletteSession {
  id: string;
  title: string;
  hint?: string;
}

export type PaletteRow<Command extends PaletteCommand> =
  | { kind: "command"; command: Command }
  | { kind: "session"; session: PaletteSession };

export const MAX_SESSION_MATCHES = 20;

const isWordCharacter = (character: string | undefined) =>
  character !== undefined && (character.toLowerCase() !== character.toUpperCase() || (character >= "0" && character <= "9"));

function startsAWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (at === 0 || !isWordCharacter(text[at - 1])) return true;
  }
  return false;
}

export function matching<Item>(query: string, items: readonly Item[], textOf: (item: Item) => string): Item[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  const first = words[0]!;
  const rank = (text: string) => (text.startsWith(first) ? 0 : startsAWord(text, first) ? 1 : 2);
  return items.map((item, order) => ({ item, order, text: textOf(item).toLowerCase() }))
    .filter(({ text }) => words.every(word => text.includes(word)))
    .map(({ item, order, text }) => ({ item, order, rank: rank(text) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ item }) => item);
}

export function commandText(command: PaletteCommand): string {
  return [command.title, ...(command.keywords ?? []), command.group].join(" ");
}

export function orderedCommands<Command extends PaletteCommand>(commands: readonly Command[]): Command[] {
  const scopes: CommandScope[] = ["session", "global"];
  return scopes.flatMap(scope => {
    const inScope = commands.filter(command => command.scope === scope);
    const groups = [...new Set(inScope.map(command => command.group))];
    return groups.flatMap(group => inScope.filter(command => command.group === group));
  });
}

export function paletteRows<Command extends PaletteCommand>(query: string, commands: readonly Command[], sessions: readonly PaletteSession[]): PaletteRow<Command>[] {
  const ordered = orderedCommands(commands);
  if (!query.trim()) return ordered.map(command => ({ kind: "command", command }));
  return [
    ...matching(query, ordered, commandText).map((command): PaletteRow<Command> => ({ kind: "command", command })),
    ...matching(query, sessions, session => session.title).slice(0, MAX_SESSION_MATCHES).map((session): PaletteRow<Command> => ({ kind: "session", session })),
  ];
}

export function nextEnabled(disabled: readonly boolean[], from: number, by: 1 | -1): number {
  const count = disabled.length;
  if (!count) return -1;
  for (let step = 1; step <= count; step++) {
    const at = (((from + by * step) % count) + count) % count;
    if (!disabled[at]) return at;
  }
  return -1;
}

export function firstEnabled(disabled: readonly boolean[]): number {
  return disabled.findIndex(item => !item);
}
