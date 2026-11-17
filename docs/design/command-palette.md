# The command palette

A session's actions were spread over its header menu, its panel, the settings and the chat box's
[slash commands](slash-commands.md), and on a phone several of them took a hunt. The palette is one place to reach all
of them by name, the same on a desktop and a phone (issue #403). See [Command palette](../sessions.md#command-palette)
for what it offers.

It follows Pine v2's design (`v2/docs/commands.md` in `igaryhe/pine`, after Emacs's `M-x`): every command found by name
in one list, and a command that needs a value asks for it in the same box. Pine draws it on its server, as HTML its
plugins contribute; Pikibun's client draws everything itself, so the idea carries over and the shape doesn't.

## One registry, contributions as data

`apps/nsh/src/lib/commands.ts` holds a registry, made once by the signed-in shell (`Root.tsx`) and given to every
screen through `CommandsContext`. A screen contributes a function that returns its commands (`useCommands`), and the
contribution goes when the screen does. A command is data: its title, group, scope (`session` or `global`), icon,
keywords, a global binding, and either `run` or an `input`. Screens don't draw rows, so every command looks and
behaves the same, and the palette (`apps/nsh/src/components/CommandPalette.tsx`) is the only place that draws them.

Contributions are reactive: each is read again as what it depends on changes (the session's permissions, whether its
agent works, the chat box's draft), so what the palette shows is what the screen would allow at that moment. Today
the shell contributes the global commands, the session view its session, panel and sharing commands, and the
conversation its chat commands and slash commands.

A screen's commands count only while it is in front. On a phone, a session page under the settings page is still
mounted; its contribution carries an `active` accessor (the shell's `sessionInFront`) so the palette doesn't offer to
rename a session that isn't shown.

## Dimmed or left out

The rule is Pine's: a command that can't run now is shown dimmed, with why (a session busy, archived or read-only, a
chat box holding a message, nothing running to stop), so people learn it exists and what to change; a command that can
never run for this person on this session isn't offered at all (Rename… and Archive to someone who doesn't manage the
session, backups to anyone but its owner). The reasons are the ones the header menu and the slash commands already
give. As everywhere in the client, the server still decides: a command it refuses says why in the session's notices.

## Inputs

A command that needs a value asks for it in the palette, as Pine's `completing-read` and `read-string` do, with Back
(Escape) to return to the list:

- **A choice**: the input filters a list of values, the current one checked (Model…, Reasoning…, Switch session…,
  New session in…, Workspaces…).
- **A line of text**: one row offers what typing it does (**Rename to “…”**), starting from the current value.

Pine's third interface, the transient (several arguments and actions with letters), isn't here: Pikibun's commands
with several arguments, such as a new session, keep their own pages.

## Matching

`packages/client/src/command-palette.ts` is the matcher, Pine's `matching.ts`: every typed word must appear in the
command's title, keywords or group, and a title that starts with the first word comes before one where a word starts
with it, before the rest, in the order the commands were contributed otherwise. With nothing typed the list is the
session's commands, by group in contribution order, then the global ones; once something is typed, the sessions
whose title matches follow the commands, so typing a title opens it. It is plain code, tested at the repository's
root (`tests/command-palette.test.ts`), and has no regular expression with Unicode classes, so it runs the same on
every engine NSH has.

## Keys and touch

`mod+k` (Command on Apple's platforms, Control elsewhere) opens the palette, and `mod+o` opens Switch session…
directly, as Pine binds them; a command's `binding` is bound by the shell for as long as some screen contributes it.
Both keep a modifier, so typing in the chat box never fires one. On touch screens the session's header has a button
for it and the phone's session list has one too; the sidebar has **Commands** on wider windows. The input takes the
keyboard focus only where NSH reports desktop behavior (`platform.desktop`), so a phone's keyboard doesn't cover the
list until the input is tapped; the key hints show only there too.

The rows are a virtualized `List`, so a long list of sessions costs only the rows in view, and Up and Down scroll the
highlighted row into view, passing dimmed ones. NSH has a native `Command` component that does much of this, but it
filters and matches by itself, and the palette needs the ranking above and the sessions after the commands; the input
and list are the same parts the chat box's slash commands use.

## Slash commands

The slash commands the chat box offers in this session (the app's and the host's) are listed in their own group.
Choosing one puts it in the chat box, as typing it would, rather than running it, because many take an argument and
the host's ones are sent as messages. While the chat box holds a message they are dimmed rather than replace it.
