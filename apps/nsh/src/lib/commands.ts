import { cleanup, computed, context, signal, type Accessor } from "nsh";
import type { CommandScope, PaletteCommand } from "../shared";
import type { IconName } from "../icons";

export interface CommandChoice {
  value: string;
  label: string;
  hint?: string;
  current?: boolean;
  disabled?: string;
  keywords?: readonly string[];
}

export type CommandInput =
  | { kind: "choice"; placeholder: string; empty?: string; choices: () => CommandChoice[]; choose: (value: string) => void }
  | { kind: "text"; placeholder: string; initial?: string; submitLabel: (value: string) => string; submit: (value: string) => void };

export interface AppCommand extends PaletteCommand {
  scope: CommandScope;
  icon?: IconName;
  hint?: string;
  binding?: string;
  testID?: string;
  run?: () => void;
  input?: CommandInput;
}

export interface PaletteRequest {
  commandId?: string;
  key: number;
}

export interface CommandRegistry {
  commands: Accessor<AppCommand[]>;
  contribute: (source: Accessor<AppCommand[]>, active?: Accessor<boolean>) => () => void;
  request: Accessor<PaletteRequest | null>;
  open: (commandId?: string) => void;
  close: () => void;
}

type Contribution = { source: Accessor<AppCommand[]>; active: Accessor<boolean> };

export function createCommandRegistry(): CommandRegistry {
  const contributions = signal<readonly Contribution[]>([]);
  const request = signal<PaletteRequest | null>(null);
  let opened = 0;
  const commands = computed(() => contributions().filter(item => item.active()).flatMap(item => item.source()));
  return {
    commands,
    contribute(source, active = () => true) {
      const contribution = { source, active };
      contributions.update(list => [...list, contribution]);
      return () => contributions.update(list => list.filter(item => item !== contribution));
    },
    request,
    open: commandId => request.set({ ...(commandId ? { commandId } : {}), key: ++opened }),
    close: () => request.set(null),
  };
}

export const CommandsContext = context<CommandRegistry | null>(null);

export function useCommandRegistry(): CommandRegistry {
  const registry = CommandsContext();
  if (!registry) throw new Error("useCommandRegistry must be used inside the signed-in shell");
  return registry;
}

export function useCommands(source: Accessor<AppCommand[]>, active?: Accessor<boolean>): void {
  const registry = CommandsContext();
  if (!registry) return;
  cleanup(registry.contribute(source, active));
}
