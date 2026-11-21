# Skills, apart from extensions

[Agent Skills](https://agentskills.io) are folders with a `SKILL.md`: a name and a description in its front matter, and
instructions in its body, which the agent reads when a task matches the description. Pi finds them in `.pi/skills`,
lists each one's name, description and location in the system prompt (`<available_skills>`), and pastes one into the
message for `/skill:name`. Pikibun's sessions run on pi-durable, not on Pi's agent session, so they got none of this
until [slash commands](slash-commands.md) brought `/skill:name`. This note is #323's plan, in phases.

## What was wrong

- **The model never saw a skill.** Only someone who typed `/skill:name` could use one. The agent didn't know which
  skills a repository had, so it never read one when a task matched, which is what skills are for.
- **Names and descriptions weren't Pi's.** The command was named after the skill's folder, never after the `name` in
  its front matter. The description was never read: the list showed the file's path, and a loose Markdown file
  directly under `skills/` was a skill whether or not it had one (Pi skips those). `disable-model-invocation` meant
  nothing.
- **Skills were part of the command code.** Finding them, naming them and expanding them were mixed into
  `session/commands.ts` with prompt templates and extension commands, and #323 proposed a `piki:skills` Pi extension
  for the rest. But a skill isn't an extension: it is text in a repository, read through the session's own file
  access, that the agent chooses to load. Running it in an extension process on the host would read the worktree
  from outside the sandbox, which [`/skill:name`](slash-commands.md#commands-the-host-runs) deliberately doesn't.
- **Extensions carry procedure that could be skills.** `piki:pr-flow` and `piki:sub-agents` add their whole procedure
  to every message's system prompt, whether or not the message uses it (#343). Their code (the push gate, the notes
  after a tool call, the sub-agent defaults) needs an extension. Their long instructions are what a skill is for.

## Phase 1: skills of their own (this change)

- **One module.** `apps/runner/src/session/skills.ts` finds, names, lists and expands skills. `session/commands.ts` keeps
  `/compact`, extension commands and prompt templates, and hands `/skill:` to it. Qualifying a name two clones claim
  (`session/names.ts`) and Pi's text helpers (`session/pi-text.ts`) are shared by both.
- **Pi's rules.** A skill is a `SKILL.md` in a folder of its own under `.pi/skills`, `.agents/skills` or `.claude/skills`
  (Claude Code's place for the same format), in the worktree or one clone down, or a Markdown file directly under one
  of them. Its name is its front matter's `name`, else its folder's (the file's, for a loose one); its description is
  its front matter's `description`. As in Pi, folders that start with `.` and `node_modules` are skipped, a skill's
  own subfolders hold no further skills, and a loose file without a description isn't a skill. A `SKILL.md` without
  one still answers to `/skill:name`, since someone typed it, but isn't listed for the model. Neither is one with
  `disable-model-invocation: true`.
- **One read per skill.** Finding a skill's name and description means reading its file, through the session's file
  access as before. The host looks at most every two minutes for the command list, and again before each message
  and side ask whose prompt lists skills, waiting at most a few seconds before it uses what it found last. Each
  message and side ask reads the workspace's switch itself, so turning it off takes effect at the next one's prompt.
  pi-durable keeps each prompt in the conversation's history, and a side ask forks it, so what earlier prompts listed
  stays there, as everything said earlier does. Reading
  stops at 100 skills, or after 200 files (loose Markdown files without a description are read but aren't skills, so
  they don't count toward the 100). The command list now shows each skill's description.
- **Listed for the model where the workspace turns it on.** With `piki:skills` on, each message's system prompt lists
  the skills the model may load, as Pi does: name, description, and location as a worktree path, with how to load
  one (`read`) and how to run what a skill says to run without a shell. Descriptions are cut to Pi's 1,024 characters,
  the section to 20,000, and XML in them is escaped. `piki:skills` has no package and no tools: it is the workspace's
  switch for something the session does itself, as `piki:files` and `piki:git` are. Off, nothing changes: skills
  still answer to `/skill:name`, and reach the model only when someone types one.

Why a switch, off by default: a listed skill's description reaches the system prompt without anyone typing its name,
from any clone in the worktree, a public repository cloned to read included, and the agent is told to follow the
skill it loads. That is what `piki:context-files` does with `AGENTS.md`, which is off until a workspace turns it on,
for the same reason ([security rationale](security-rationale.md#slash-commands-the-host-runs)). Whether it should be on
by default is the workspace owners' call, not this change's.

Not changed: the host owner's own `~/.pi/agent/skills` aren't read, nor skills a Pi package ships (`pi.skills`).

## Phase 2: skills that extensions ship

A Pi package can ship skills (`pi.skills` in its `package.json`, or paths from a `resources_discover` handler). The
extension loader drops both today. The agent can't open them from the sandbox, as they are on the host, outside the
worktree. So the session would serve them itself: the loader reads the package's skills when it loads the source
(within the package's directory, links out refused, as `piki:context-files` reads files), sends their text with the
source's summary, and the session lists them with the worktree's under the extension's source and loads one on demand,
either through a small `skill` tool or by placing a copy under the worktree's `.pikibun/skills/`. A skill an
extension ships is on whenever the extension is.

## Phase 3: workflow extensions' procedure as skills

Each workflow extension keeps a short rule in the system prompt and ships the rest as a skill: `piki:sub-agents` first,
then `piki:pr-flow`, whose steps (review windows, waiting, merging) depend on the workspace's settings, so its skill is
filled in from them. The extensions keep what only code can do. Each move is judged by #343's eval before it ships,
and `piki:pr-flow` goes last: a session that didn't load its skill would skip the flow.
