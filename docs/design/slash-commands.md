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

## Commands the host runs

`/compact`, the commands of the workspace's Pi extensions, prompt templates and skills can't be done by the client:
they need the conversation, the extensions' processes and the session's files, which are on the host. They travel as
messages.

- **A message, not a new request.** The client sends `/name arguments` as it sends any message: the same route,
  permission, receipt and audit. The host looks at a message's first word before the model sees it, where it already
  lets extensions screen a message (`RunQueue.screen`), in the order Pi's own `prompt()` takes them: `/compact`, an
  extension's command, the extensions' `input` handlers, `/skill:name`, then a prompt template. Anything else goes to
  the model as typed. So there is no new server route, relay action or permission to keep in step across the server,
  the connector and the apps, and a scheduled prompt can be a command too (a message from another session's agent
  can't: it starts with its header, not with `/`). A host from before this passes the text to the model, as it always
  did, which is why the client offers only what the host lists.
- **An expanded template is screened again** (review 380, finding 48). This step is Pikibun's own: a template or skill
  that changed the text sends the result through the `input` handlers again, and a refusal there refuses the message.
  In Pi a template is the user's own file. Here it is any file of the worktree, and the handler that matters is often
  a guard, such as `piki:prompt-audit`, which would otherwise judge `/name arguments` and never the text the model
  gets. Handlers run twice for such a message, so one with a cost (a model-backed audit) pays twice.
- **The host lists them.** A session's view carries `commands`: each one's name, description, argument hint and kind
  (`host`, `extension`, `prompt`, `skill`). The client adds them to its list after its own commands, and a name the
  client has itself (`/model`, `/new`) stays the client's. The list is the host's word, so the client keeps only
  entries of the expected shape and length (`hostCommands` in `packages/client/src/slash-commands.ts`).
- **What it leaves in the transcript.** A command the host ran itself leaves one line, who ran what and what it said
  (`workspace.run-command`), and no message of the person's, as nothing went to the model. It doesn't change the
  session's status. A template or a skill becomes the message, so the transcript shows the text the model got.
- **`/compact [instructions]`** asks Pi for a manual compaction (`Conversation.compact`): it summarizes the older
  messages while the agent keeps working and places the summary at the next boundary, whatever the host's automatic
  compaction is set to. Its line says compaction started, and the host then follows the compaction's task (and the
  write that places the summary) and changes the line to how it ended: compacted, nothing to compact, or why it
  failed. Started is never shown as done, and a failure isn't left looking like a start. A host that restarts
  meanwhile leaves the line at started. It needs write permission, as going back does, since it changes the conversation for everyone. The client knows
  `/compact` by name, so on a host that doesn't list it the client says to update the connector rather than send the
  word to the model.
- **Extension commands** (`pi.registerCommand`) run their handler in the extension's process, with Pi's command
  context. What a handler shows with `ctx.ui.notify` is the command's line in the transcript. What it sends with
  `pi.sendUserMessage` goes to the model in the command's place, as the person's message. The rest stays as it is for
  every extension on a host: dialogs answer as in print mode, and `newSession`, `fork`, `navigateTree` and
  `switchSession` do nothing. A handler is the extension's code acting for whoever typed the command, so it runs under
  the rule of the extension's tools: for anyone who may send messages where extensions run in the sandbox, and
  otherwise for the host's owner and members they granted host commands, or where the host's owner lets extension
  tools run for every session ([security rationale](security-rationale.md)).
- **Prompt templates** are Pi's: `.pi/prompts/*.md` in the worktree and in each repository cloned into it, with
  `$1`, `$@`, `$ARGUMENTS` and `${1:-default}` in the text, filled in by Pi's own `substituteArgs`. `/name arguments`
  sends the template with the arguments filled in, without its front matter.
- **Skills** are `SKILL.md` files under `.pi/skills`, `.agents/skills` and `.claude/skills` in the same places, named
  and described by their front matter as in Pi. `/skill:name arguments` sends the skill's text in Pi's `<skill>` block,
  with its location as a worktree path, so the agent opens the skill's other files with `read`. They are found and
  expanded by `session/skills.ts`, apart from this command code, and listed in the system prompt for the model to pick
  by itself only where the workspace turned on `piki:skills`: see [Skills, apart from extensions](skills.md).
- **Read as the session reads files.** Templates and skills are found and read through the session's own file access
  (the sandbox's helper), never by the connector opening paths under the worktree, so a link that leaves the worktree
  is refused there as for the `read` tool. They come from whoever can push to the repository, or from the session's
  own commands (a file needn't be committed), and do nothing until someone types their name, but for the skills
  `piki:skills` lists.
- **A name in two places is qualified.** Within one clone (or the worktree's root) the first file of a name wins, in
  Pi's own order. Where two places claim one name, neither keeps it: each is offered as `/<clone>:<name>` (or
  `/skill:<clone>:<name>`), and `worktree:` names the root's, so a public repository cloned to read can't answer for
  the workspace's own `/release`. A clone named `skill` or `worktree` isn't offered for a shared name (its names would read
  as a skill, or as the root's), nor is a qualified name longer than a command may be.
- **One look for the list, one read for a command.** Each file access is a sandboxed call, and a session's file
  calls run one after another, behind a command that is running. So the view never waits for the worktree: it lists
  what the last look found (one `find` for templates and one for skills, at most every two minutes, started by a view
  and finished in the background), and shows each template's path rather than the description in its front matter,
  which would cost one read per file. A skill's description is shown, as its name needs that read anyway
  ([skills](skills.md#phase-1-skills-of-their-own-this-change)). A command typed for a file the list doesn't have yet looks again before it gives up, and the file is
  read when it is used, so the text sent is the file's as it is then.
- **A side ask or a Read-only message** takes templates and skills, which are only text, and refuses `/compact` and
  extension commands, which act.
- **At most once.** A message still being screened when its host stops is screened again when it starts, which is
  right for a screen but not for a command that acts. The host notes on the message that it is starting the command
  before it runs it (`commandStarted`), and a second screening finds the note and says, in the command's line, that
  the host stopped while it ran and that it wasn't run again. Whether to run it again is the person's call.
- **Failing soft.** Pi's code for filling in a template is loaded from its package when first needed. If it can't be
  loaded or the file can't be read, the message goes to the model as typed, as on a host without this, and the next
  one tries again. A command's own text is shown as plain text: control characters other than line breaks become
  spaces.
- **The app tells an old host from a current one** by whether the view has a list at all: a host from before this
  sends none, and `/compact` there says to update its connector; a current host always sends one, empty for a session
  that takes no commands (archived and packed, or closing), and `/compact` there says only that it isn't taken now.

Not read: the host owner's own `~/.pi/agent/prompts` and `~/.pi/agent/skills`, which are their files, not the
workspace's, and would be shown to other members' sessions; and the prompt templates a Pi package ships (`pi.prompts`).
The skills a workspace's extensions ship are copied into the worktree's `.pikibun/skills` and answer to `/skill:name`
([skills](skills.md#phase-2-skills-that-extensions-ship-as-built)).

## Left out

- **No meaning here**: `/quit`, `/login`, `/logout`, `/hotkeys`, `/changelog`, `/reload`, `/trust`, `/scoped-models`,
  `/import`, `/bug`, `/llama`, `/mcp`. Pi's sign-in is the host's (**This Computer**), and extensions are the
  workspace's.
- **Done elsewhere, with a choice a command line can't make**: `/fork` and `/tree` pick an earlier message, which a
  message's own **Fork** and **Go back** do; `/resume` is the session list; `/export` and `/share` are in the session's
  panel, where what they include is explained.
