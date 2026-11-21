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

Not changed: the host owner's own `~/.pi/agent/skills` aren't read. Skills a Pi package ships came in phase 2.

## Phase 2: skills that extensions ship (as built)

A Pi package ships skills in two ways Pi itself reads: `pi.skills` in its `package.json` (paths or globs in the
package, `!` to leave one out; without any `pi` resource field, its `skills/` folder by convention), and the paths a
`resources_discover` handler returns. Before this, the extension loader dropped both. The agent couldn't open them
anyway: they are on the host (or in the extension's process), outside the worktree the sandbox sees.

- **The extension's process reads them.** `packageEntries` finds the package's skill paths as it finds its modules,
  refusing one outside the package, and the session passes them when it opens the source. The worker answers a new
  `skills` request: it emits `resources_discover` (relative paths are taken from the module's folder; a module with no
  file, such as the connector's own, must return absolute ones), adds the package's paths, and reads them with Pi's
  own `loadSkills`, so names, descriptions and `disable-model-invocation` are Pi's. For each skill (at most 20 a
  source) it sends the text files of its folder: no dot files, no `node_modules`, no links, no binary files, at most
  50 files, 256 KB a file and 1 MB a skill. A `SKILL.md` at the top of the temporary directory is refused, as its
  folder would be all of it.
- **The session copies them into the worktree.** Before each message and side ask, the session asks every open,
  active extension that handles `resources_discover` or has package skills, and copies what they answer to
  `.pikibun/skills/<extension>/<skill>/` through its own file access (`ExtensionSkillFiles`): only files that changed
  are written, a skill that goes away has its folder removed, and the first copy in a session clears what an earlier
  run left. `<extension>` is the source's last name (`pr-flow`, `pi-web-access`), with a short hash where two
  sources share one. A copy rather than a `skill` tool, because a skill's files are then where its text says they are:
  the agent reads them with `read`, and runs a script the skill brings with the program tools.
- **Listed whenever the extension is on.** An extension's skills are listed with the repositories' and answer to
  `/skill:name`, whatever `piki:skills` says: the workspace's owners chose the extension, as the host's owner
  installed it, and the switch is for repositories' skills, which anyone who can push writes. The list says that
  skills under `.pikibun/skills` come with the workspace's extensions and are replaced by the next copy.
- **What an extension sends is checked.** Names must be command names, a description is required, file paths may not
  leave the skill's folder or start with a dot, and a skill whose own file couldn't be written isn't listed.

The prompt and theme paths `resources_discover` returns are ignored, as before.

## Phase 3: workflow extensions' procedure as skills (as built)

`piki:pr-flow` and `piki:sub-agents` each ship their procedure as a skill, `pull-request-flow` and `sub-agents`, and
keep a short rule in the system prompt. Their code stays: the push gate, the notes after each tool call, the
sub-agent defaults and limits.

- **Filled in from the settings.** A skill in a package is a fixed file, but these procedures depend on the
  workspace's settings (the review window, the merge method, auto-merge, the placement defaults). So each extension
  writes its skill when `resources_discover` asks for it, in a folder of its own under the temporary directory, from
  the settings of that moment, and removes it at `session_shutdown`. The skill holds exactly the text the system
  prompt held before.
- **The short rule.** `pull-request-flow`: what the flow is for and when it applies, its steps in one sentence with
  the workspace's window and merge rule, the pre-push check, and the session's own pull requests; it says to read the
  skill before the first change in a clone, and that each step's note says what comes next. `sub-agents`: when to
  hand work over, how many per message, and to read the skill before `sessions create`. With `max-sub-agents` 0 there
  is no skill, only the line that says none may start.
- **Only where the host lists the skill.** An extension gives the short rule only once `resources_discover` reached
  it in that session, which a connector from before phase 2 never emits: there, and in a Pi that didn't discover
  resources, it gives the whole procedure as before. Pi itself emits it at startup and lists the skill.
- **Why it is safe enough without #343's eval.** The procedure the model needs at each step of `pr-flow` is also in
  the note added to the step's tool result (open the draft, make it ready, wait until, merge or hand over), which
  this change leaves as it was, and the short rule names every step. #343's eval would still tell whether the
  shorter prompt changes how often sessions follow the flow; it isn't built yet, so this was checked by tests of the
  prompts and of a session, not by a model.
