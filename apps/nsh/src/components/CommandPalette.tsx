import { computed, effect, keymap, List, platform, signal, Text, untracked, View, windowSize, type InputRef, type ListRef } from "nsh";
import { Button as BaseButton, Dialog, Input, Sheet } from "nsh/base";
import { firstEnabled, matching, nextEnabled, paletteRows, type PaletteSession } from "../shared";
import type { AppCommand, CommandChoice, CommandRegistry } from "../lib/commands";
import { sessionIdIn } from "../lib/page";
import { Icon, type IconName } from "../icons";
import { control, palette, radius, text, weight } from "../theme";
import { IconButton, phoneWidth, shortcutLabel } from "../ui";

interface PaletteRowView {
  key: string;
  title: string;
  hint?: string;
  heading?: string;
  group?: string;
  icon?: IconName;
  disabled?: string;
  current?: boolean;
  binding?: string;
  testID: string;
  act: () => void;
}

const choiceText = (choice: CommandChoice) => [choice.label, choice.hint ?? "", ...(choice.keywords ?? [])].join(" ");

export function CommandPalette(props: { registry: CommandRegistry; sessions: () => PaletteSession[]; openSession: (id: string) => void; openById?: (id: string) => void }) {
  const open = () => props.registry.request() !== null;
  const asking = signal<string | null>(null);
  const query = signal("");
  const highlightedKey = signal<string | null>(null);
  const list = signal<ListRef>();
  let input: InputRef | undefined;
  const commands = props.registry.commands;
  const asked = computed(() => {
    const id = asking();
    return id ? commands().find(command => command.id === id && command.input && !command.disabled) ?? null : null;
  });

  function close() {
    props.registry.close();
  }
  function start(command: AppCommand) {
    if (command.disabled) return;
    if (command.input) {
      asking.set(command.id);
      query.set(command.input.kind === "text" ? command.input.initial ?? "" : "");
      input?.focus();
      return;
    }
    close();
    command.run?.();
  }
  function back() {
    if (untracked(asking)) {
      asking.set(null);
      query.set("");
      input?.focus();
    } else {
      close();
    }
  }

  effect(() => {
    const request = props.registry.request();
    untracked(() => {
      asking.set(null);
      query.set("");
      highlightedKey.set(null);
      const command = request?.commandId ? commands().find(item => item.id === request.commandId) : undefined;
      if (command) start(command);
    });
  });

  function commandRow(command: AppCommand, typing: boolean, previous: AppCommand | undefined): PaletteRowView {
    return {
      key: `command:${command.id}`, title: command.title, hint: command.disabled ?? command.hint, icon: command.icon, disabled: command.disabled,
      heading: !typing && previous?.group !== command.group ? command.group : undefined, group: typing ? command.group : undefined,
      binding: shortcutLabel(command.binding), testID: command.testID ?? `palette-command-${command.id}`, act: () => start(command),
    };
  }
  const sessionRow = (session: PaletteSession, first: boolean): PaletteRowView => ({
    key: `session:${session.id}`, title: session.title, hint: session.hint, icon: "message", heading: first ? "Sessions" : undefined,
    testID: `palette-session-${session.id}`, act: () => { close(); props.openSession(session.id); },
  });

  const rows = computed((): PaletteRowView[] => {
    if (!open()) return [];
    const command = asked();
    const typed = query();
    const ask = command?.input;
    if (!ask) {
      const typing = typed.trim() !== "";
      const found = paletteRows(typed, commands(), typing ? props.sessions() : []);
      const pasted = props.openById ? sessionIdIn(typed) : null;
      const byId: PaletteRowView[] = pasted ? [{
        key: `open-id:${pasted}`, title: `Open session ${pasted}`, hint: "The session this ID or link names", icon: "hash", heading: "Open by ID",
        testID: "palette-open-id", act: () => { close(); props.openById!(pasted); },
      }] : [];
      return [...byId, ...found.map((row, index) => {
        const before = found[index - 1];
        if (row.kind === "session") return sessionRow(row.session, before?.kind !== "session");
        return commandRow(row.command, typing, before?.kind === "command" ? before.command : undefined);
      })];
    }
    if (ask.kind === "choice") {
      return matching(typed, ask.choices(), choiceText).map(choice => ({
        key: `choice:${choice.value}`, title: choice.label, hint: choice.disabled ?? choice.hint, disabled: choice.disabled, current: choice.current,
        testID: `palette-choice-${choice.value}`, act: () => { close(); ask.choose(choice.value); },
      }));
    }
    const value = typed.trim();
    return value ? [{ key: "submit", title: ask.submitLabel(value), icon: "check", testID: "palette-submit", act: () => { close(); ask.submit(value); } }] : [];
  });
  const disabledRows = () => rows().map(row => Boolean(row.disabled));
  const highlighted = computed(() => {
    const key = highlightedKey();
    const kept = key === null ? -1 : rows().findIndex(row => row.key === key && !row.disabled);
    return kept >= 0 ? kept : firstEnabled(disabledRows());
  });
  effect(() => {
    query();
    asking();
    untracked(() => highlightedKey.set(null));
  });
  function move(by: 1 | -1) {
    const next = nextEnabled(untracked(disabledRows), untracked(highlighted), by);
    if (next < 0) return;
    highlightedKey.set(untracked(rows)[next]?.key ?? null);
    untracked(list)?.scrollToIndex({ index: next, viewPosition: 0.5, animated: false });
  }
  function choose() {
    const row = untracked(rows)[untracked(highlighted)];
    if (row && !row.disabled) row.act();
  }
  effect(() => {
    if (!open()) return;
    try {
      return keymap.bind({ up: () => move(-1), down: () => move(1), escape: back }, { when: "always", repeat: true });
    } catch {
      return undefined;
    }
  });

  const placeholder = () => asked()?.input?.placeholder ?? "Type a command or a session's title";
  const empty = () => {
    const ask = asked()?.input;
    if (ask?.kind === "text") return query().trim() ? "" : ask.placeholder;
    if (ask?.kind === "choice") return query().trim() ? "Nothing matches" : ask.empty ?? "Nothing to choose from";
    return query().trim() ? "No command or session matches" : "No commands here";
  };
  const narrow = phoneWidth;
  const listHeight = () => (narrow() ? Math.max(200, windowSize().height * 0.8 - 110) : Math.max(160, Math.min(340, windowSize().height * 0.6)));

  const body = () => (
    <View testID="command-palette" accessibilityLabel="Commands">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
        <If when={asked()} else={<Icon name="command" size={16} color={palette().muted} />}>
          <IconButton testID="palette-back" icon="chevron-left" label="Back to the commands" size={control.xsmall} onPress={back} />
        </If>
        <Text testID="palette-title" style={{ flex: 1, numberOfLines: 1, fontSize: text.small, fontWeight: weight.medium, color: palette().muted }}>
          {asked()?.title ?? "Commands"}
        </Text>
        <IconButton testID="palette-close" icon="x" label="Close" size={control.xsmall} onPress={close} />
      </View>
      <View style={{ marginHorizontal: 12, paddingHorizontal: 10, minHeight: control.medium, justifyContent: "center", borderWidth: 1, borderRadius: radius.medium,
        borderColor: palette().borderStrong, backgroundColor: palette().background }}>
        <Input ref={ref => { input = ref; }} testID="palette-input" value={query()} onChange={event => query.set(event.value)} placeholder={placeholder()}
          accessibilityLabel={placeholder()} autoFocus={platform.desktop} autoCorrect={false} autoCapitalize={asked()?.input?.kind === "text" ? undefined : "none"}
          returnKeyType="go" onSubmit={choose}
          style={{ fontSize: text.body, color: palette().text, placeholderColor: palette().muted }} />
      </View>
      <If when={rows().length > 0}
        else={
          <View style={{ height: listHeight(), padding: 20 }}>
            <Text testID="palette-empty" style={{ fontSize: text.small, color: palette().muted, textAlign: "center" }}>{empty()}</Text>
          </View>
        }>
        <List each={rows()} keyExtractor={row => row.key} ref={list} testID="palette-rows" style={{ height: listHeight() }} contentStyle={{ paddingHorizontal: 8, paddingVertical: 8 }}>
          {(row, index) => (
            <View>
              <If when={row().heading}>
                {heading => <Text style={{ paddingHorizontal: 8, paddingTop: index() === 0 ? 0 : 10, paddingBottom: 4, fontSize: text.caption, fontWeight: weight.medium,
                  color: palette().muted }}>{heading()}</Text>}
              </If>
              <BaseButton role="menuitem" testID={row().testID} accessibilityLabel={row().disabled ? `${row().title}, unavailable: ${row().disabled}` : row().title}
                disabled={Boolean(row().disabled)} selected={index() === highlighted()} onPress={() => row().act()}
                style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: narrow() ? control.large : control.small, paddingHorizontal: 8,
                  paddingVertical: row().hint ? 5 : 0, borderRadius: radius.small, opacity: row().disabled ? 0.5 : 1,
                  backgroundColor: index() === highlighted() ? palette().hoverStrong : "transparent" }}
                hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ backgroundColor: palette().hoverStrong }}>
                <View style={{ width: 16, alignItems: "center" }}>
                  <If when={row().icon}>{name => <Icon name={name()} size={14} color={palette().muted} />}</If>
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <Text style={{ numberOfLines: 1, fontSize: text.body, color: palette().text }}>{row().title}</Text>
                  <If when={row().hint}>
                    {hint => <Text testID={`${row().testID}-hint`} style={{ numberOfLines: 2, fontSize: text.caption, color: palette().muted }}>{hint()}</Text>}
                  </If>
                </View>
                <If when={row().group}>{group => <Text style={{ fontSize: text.caption, color: palette().faint }}>{group()}</Text>}</If>
                <If when={row().binding}>{binding => <Text style={{ fontSize: text.caption, color: palette().muted }}>{binding()}</Text>}</If>
                <If when={row().current}><Icon name="check" size={14} color={palette().text} /></If>
              </BaseButton>
            </View>
          )}
        </List>
      </If>
      <If when={platform.desktop}>
        <Text testID="palette-keys" style={{ paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderColor: palette().border, fontSize: text.caption, color: palette().muted }}>
          {`↑ ↓ to move · Enter to ${asked() ? "choose" : "run"} · Esc to ${asked() ? "go back" : "close"}`}
        </Text>
      </If>
    </View>
  );

  return (
    <If when={narrow()}
      else={
        <Dialog open={open()} animation="fade" onOpenChange={event => { if (!event.open) close(); }} backdropStyle={{ backgroundColor: palette().backdrop }}
          style={{ alignSelf: "center", marginTop: "12%", width: 600, maxWidth: "94%", borderRadius: radius.large, borderWidth: 1,
            borderColor: palette().border, backgroundColor: palette().surface, boxShadow: palette().shadow, overflow: "hidden" }}>
          {body()}
        </Dialog>
      }>
      <Sheet open={open()} side="bottom" closeOnSwipe onOpenChange={event => { if (!event.open) close(); }} backdropStyle={{ backgroundColor: palette().backdrop }}
        popupStyle={{ width: "100%", paddingBottom: 16, borderTopWidth: 1, borderColor: palette().border, borderTopLeftRadius: radius.large,
          borderTopRightRadius: radius.large, backgroundColor: palette().surface }}>
        {body()}
      </Sheet>
    </If>
  );
}
