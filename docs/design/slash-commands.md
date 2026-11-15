# Slash commands in the chat box

Pi's terminal editor lists its commands when you type `/`. People who come from Pi type `/model` or `/name` in
Pikibun's chat box and expect the same. Before this, that text went to the model as a message. Now a session's chat
box lists commands on `/` and runs the ones Pikibun has an action for, under Pi's names. See
[Slash commands](../sessions.md#slash-commands) for what each does.

## Pikibun's actions under Pi's names, not Pi's commands themselves

Pi's built-in commands (`BUILTIN_SLASH_COMMANDS` in `@earendil-works/pi-coding-agent`) are handled by its interactive
mode: they open its selectors and act on its `AgentSession`. Pikibun's sessions run on `pi-durable`'s `Harness`, on a
host, without that mode, so there is nothing to forward `/model` to. Each command here is the action Pikibun already
has for the same thing, done by the client as its button does it:

| Pi | Here |
| --- | --- |
| `/model`, `/thinking` | The chat box's model and reasoning pickers ([chat options](../sessions.md#chat-options)) |
| `/name` | **Rename** in the session's menu |
| `/new` | **New session**, in the session's workspace |
| `/clone` | A message's **Fork**, from the agent's latest finished reply |
| `/copy` | A reply's **Copy message** |
| `/session` | The session's panel |
| `/settings` | Settings |

So a command can do nothing its button couldn't: the same permissions apply (renaming, forking), the same requests go
to the server, and nothing new reaches the host. This needs no server or connector release, and works with every
host.

## What runs, and what stays a message

- **Only at the start, on one line.** A draft is a command when its first character is `/`, the word after it names a
  command (in any case), and the draft has one line. Everything else is sent as typed: `/usr/bin/env is missing`,
  `/skill:review`, a pasted block that starts with a path. A space before the `/` sends a command's name as a message.
  Unknown names pass through on purpose: a host extension's `input` handler may expand them (as #323 plans for
  `/skill:name`), and a typo then reaches the model as it did before, rather than being swallowed.
- **Never sent.** A command isn't a submission: it has no receipt, isn't queued behind running work, and leaves no
  entry in the transcript. Its outcome shows under the chat box, where a failed send shows. A command that fails, or
  one that asks first and is declined (`/clone`), keeps its text in the chat box.
- **Offered by what you may do.** The list leaves out a command that can't run here (`/name` for someone who can't
  rename the session, `/clone` where there is no finished reply or no right to fork, `/thinking` for a model without
  reasoning levels). Typed anyway, it answers with the reason, so nobody wonders why a command they know does nothing.
- **Chat options, not a setting.** `/model` and `/thinking` change what the chat box's pickers show, for the messages
  you send next from this view, exactly as picking there does. They don't change the session for other people until
  such a message is sent.

The rules are in `packages/client/src/slash-commands.ts` (what is a command, the list for a draft, which model or
level an argument names), with `tests/slash-commands.test.ts`; the chat box's list is in
`apps/nsh/src/components/Composer.tsx` and the actions in `apps/nsh/src/screens/SessionView.tsx`, with
`apps/nsh/tests/slash-commands.test.tsx`.

## The list is part of the chat box

The list is drawn inside the chat box, above the text, rather than as a popup anchored to the caret: it needs no
placement, can't be cut off by the window's edge or the keyboard on a phone, and keeps the focus in the text. It shows
at most eight rows around the highlighted one. Its keys (`↑`, `↓`, `Tab`, `Esc`) are bound only while it is open and
the chat box has the focus, so `↑` in an empty chat box still takes back a queued message. Return runs the highlighted
row only on the desktops, where Return sends; on a phone Return is a line break, and a row is pressed.

A command with a short list of values (`/model`, `/thinking`) completes to its name and then lists the values; one with
free text (`/name`) runs at once, and `Tab` completes it for typing the text. Return takes the highlighted row, which
starts as the first, so `/model`'s list puts a model named exactly (by its reference, then its ID or name) before the
ones that only contain what was typed: `/model openai/gpt-4` and Return sets that model, not a longer name the host
lists first, and the list agrees with what the typed text alone would name.

## Left out

- **No meaning here**: `/quit`, `/login`, `/logout`, `/hotkeys`, `/changelog`, `/reload`, `/trust`, `/scoped-models`,
  `/import`, `/bug`, `/llama`, `/mcp`. Pi's sign-in is the host's (**This Computer**), and extensions are the
  workspace's.
- **Done elsewhere, with a choice a command line can't make**: `/fork` and `/tree` pick an earlier message, which a
  message's own **Fork** and **Go back** do; `/resume` is the session list; `/export` and `/share` are in the session's
  panel, where what they include is explained.
- **`/compact`**: Pikibun compacts a conversation by itself, as the host's owner set it, and has no request that asks
  a host to compact one now. Adding it means a new host action (`conversation.compact`), a server route, who may ask
  for it, and what it does while work runs: a change to the server and the connector, with hosts updating to offer it.
  It is the next step if people want it.
- **Commands of extensions, prompt templates and skills**: extensions' `registerCommand` is a no-op on hosts
  ([host extensions](host-extensions.md)), since a command's handler runs with Pi's interactive context. Skills are
  #323. When either arrives, the list has a place for them: the host would report the names, and the client would add
  them to the ones it offers.
