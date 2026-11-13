# Pi's names and contracts for the file tools

Status: a plan; nothing is built. The phases at the end say what lands in which order.

## Why

Pikibun runs Pi extensions, and Pi's extension API names Pi's built-in tools. Its `tool_call` and `tool_result` events
are typed by the literal names `read`, `write`, `edit`, `grep`, `find`, `ls` and `bash`
(`isToolCallEventType("write", event)`, `isReadToolResult`), and an extension that guards paths, gates writes or tracks
changes matches on them. Pikibun's file tools do the same jobs under other names (`read_file`, `write_file`,
`edit_file`, `list_files`, `search`), so:

- **A guard never fires, and nothing says so.** The adapter passes every call to an extension's hooks
  (`apps/runner/src/extensions/adapter.ts`), but a handler for `write` doesn't match `write_file`.
- **Two tools for one job.** An extension that registers `read` or `grep`, which is how Pi replaces a built-in, is
  offered beside `read_file` or `search`.
- **Results differ too.** Pi's `read` answers the file's text. Ours answers JSON with the text in a field, so a
  `tool_result` handler written for Pi's would misread it even if it fired.

Three of the inputs already match: `read`, `write` and `edit` take exactly the arguments of `read_file`, `write_file`
and `edit_file` (pi-coding-agent 1.5.1).

## The rule

Where Pi has the tool, Pikibun's tool has Pi's name and Pi's contract: the same parameters, the same `content`, the same
`details`. Where Pi has none, the tool keeps its own name. A tool never has Pi's name with another contract: a handler
would then run on data it misreads, which is worse than not running.

| Today | After | Contract |
|---|---|---|
| `read_file` | `read` | Pi's |
| `write_file` | `write` | Pi's |
| `edit_file` | `edit` | Pi's |
| `list_files` | `ls` | Pi's |
| `search` | `grep` | Pi's, plus `all` |
| none | `find` | Pi's (phase 3) |
| `move_file`, `copy_file`, `delete_file`, `identity` | unchanged | Pikibun's |

`bash` stays retired.

## Decisions

### The contract

1. **Pikibun executes, and tests hold the contract.** These stay session tools of the connector
   ([extension loading](extension-loading.md), decision 11): confined to the worktree by the sandbox helpers, checked on
   every call (`calls.actor`, `calls.check`, `recheck`), switched by `piki:files` and by tool groups. Pi's definitions
   take pluggable operations (`createReadToolDefinition(cwd, { operations })`), but running Pi's `execute` over them
   is not the general way in:

   - It resolves the model's path in the connector before it calls any operation. `read` probes the connector's own
     filesystem for filename variants (`resolveReadPathAsync`), `~` becomes the connector user's home, and the mutation
     queue calls `realpath`.
   - `grep` always runs a local ripgrep, whatever the operations.
   - `ls` asks one `stat` per entry, and each would be a sandbox call.
   - `read` decodes images with Pi's processor, not `prepareImage` with its limits and queue.
   - A code mode script would get Pi's 50 KB excerpt of a file, where it gets up to 1 MB of it today
     (`script-output.ts`).

   So each tool keeps its own execution over `SessionWorkspace`. Its parameters are Pi's schema, taken from Pi's
   definition (`createReadToolDefinition(cwd).parameters`) and never copied. Its text is built with Pi's exported
   helpers (`truncateHead`, `truncateLine`, `formatSize`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`). A conformance
   suite runs Pi's real tool and ours over the same directory and compares `content` and `details`, so a Pi upgrade
   that changes either fails a test.

2. **`edit` runs Pi's own code.** Its matching and its diff aren't exported, and a port would drift. `edit` calls Pi's
   `execute` with `EditOperations` over the sandbox (`readFile` and `writeFile`, one sandbox call each), with a `cwd`
   that doesn't exist on the host and a path Pikibun has already checked to be worktree-relative (not absolute, no
   `~`). Nothing Pi resolves can then name a real host path. If that can't be made to hold on every backend (Windows
   paths), port Pi's functions with their tests instead, and say so here.

   This changes what `edit` accepts. Today each `oldText` must occur exactly once, byte for byte. Pi keeps the file's
   line endings and byte order mark, and tries again ignoring trailing whitespace and quote and dash styles when the
   exact text isn't found.

3. **Results are Pi's.**

   | Tool | `content` | `details` |
   |---|---|---|
   | `read`, text | The selected lines. Cut at 2000 lines or 50 KB with `[Showing lines A-B of N. Use offset=X to continue.]`; a `limit` that stops before the end adds `[K more lines in file. Use offset=X to continue.]`; an offset past the end is the error `Offset N is beyond end of file (M lines total)` | `{ truncation }` when cut |
   | `read`, image | `Read image file [<mime type>]`, then the image | none |
   | `write` | `Successfully wrote to <path>` | none |
   | `edit` | `Successfully replaced N block(s) in <path>.` | `{ diff, patch, firstChangedLine? }` |
   | `ls` | One entry a line, sorted without regard to case, `/` after a directory, dotfiles included; `(empty directory)`; 500 entries unless `limit`, with Pi's notice when more remain | `{ entryLimitReached?, truncation? }` |
   | `grep` | `path:line: text` for a match and `path-line- text` for a context line; `No matches found`; Pi's notices when the match limit or the size limit cuts it | `{ matchLimitReached?, truncation?, linesTruncated? }` |
   | `find` | Paths relative to the searched directory, one a line, with `/` separators; 1000 unless `limit` | `{ resultLimitReached?, truncation? }` |

   Where this table and Pi's tool disagree, Pi's tool is right: the conformance suite is the reference.

4. **Who a call acts for moves to `details`.** Every result today is JSON that starts with `initiatedBy`, `actingAs`
   and `mode`. Pi's `content` has no room for them, so for these tools they go in `details.pikibun`, beside Pi's own
   fields. The transcript hides them already (`tool-summary.ts`), `identity` still answers them, and the tools that
   keep Pikibun's contract keep their JSON. The model no longer reads them on each file call.

5. **What stays Pikibun's under Pi's names.** None of this is part of what a handler reads, and the conformance suite
   lists each as an exception:

   - **Paths.** They are worktree paths, confined by the sandbox. An absolute path or `~` is refused, where Pi takes it.
   - **`grep`'s engine.** It is Pikibun's search (`apps/runner/src/search.ts`), the same on every backend. Its regular
     expressions are Python's and JavaScript's, not ripgrep's. It doesn't read `.gitignore`: it skips `.git`, and
     `node_modules` unless `all`. It skips links, binary files and files over 1 MB. `context` over 5 and `limit` over 500
     are lowered to those, not refused.
   - **Images.** PNG, JPEG, GIF and WebP, through `prepareImage`.
   - **Scripts.** A code mode script's `read` gets the whole selection, up to the script limit, with no notice.
   - **Wording.** Descriptions are Pikibun's (the worktree, a Read-only message's refusal). The notice for a first line
     over 50 KB doesn't point to `bash`. Error texts are Pikibun's, except the one in decision 3.

### Extensions

6. **Hooks need no adapter change.** With the names, inputs and results Pi's, an extension's handlers match as they are.
   Extensions gain no authority by it: their hooks already saw every call and could block or rewrite it. Only the
   matching changes. A test loads a real extension that blocks a path with `isToolCallEventType("write", event)` and
   reads a result with `isReadToolResult`.

7. **Pikibun's tool wins a name.** The loader already ignores an extension's tool named like one of Pikibun's, and
   reports it (`load.ts`; `shadowed`, kind `own`). After the rename that covers `read`, `write`, `edit`, `grep` and
   `ls`, and `find` from phase 3. An extension's tool runs in the connector, outside the sandbox, so letting it take
   the confined `read`'s place would change what the name can reach without the workspace choosing that. Until
   phase 3 an extension's `find` is offered as now.

### The rename

8. **The old names are renamed, not retired.** `retiredToolNames` are names with no tool behind them: an extension
   may take one, and a tool group that leaves anything out turns them all off. The five old names are another kind.
   Saved rows, older connectors and old transcripts still mean Pikibun's tools by them. So `packages/shared` gets
   `renamedToolNames` (old to new), `canonicalToolName(name)` and `legacyToolNames(name)`. The old names stay reserved
   against extensions and tool definitions (`reservedToolNames`), and never join `retiredGroupTools`.

9. **Canonical on the way in.** Every place that reads a tool name from storage or the wire maps it first:

   - a binding's `agent.tools` (`apps/runner/src/protocol.ts`), which also covers backups and restores;
   - a member's tool group `off` list (`parseMemberToolGroups`);
   - a saved tool group's tools, on the control plane (`groupOf`, `parseGroupTools`);
   - an agent version's `tools_json` (`db.ts`, `sessions.ts`, `catalog.ts`).

   The saved tool group is the one that must not be missed. `groupOf` filters a group's saved tools with `isGroupTool`,
   so an unmapped `read_file` would be dropped, and the group's members would lose their file tools without anyone
   having changed anything. There is no database migration: a row takes the new names when it is next saved, and an
   agent version is never rewritten.

10. **Both spellings on the way out to connectors.** Hosts update slowly, so the control plane sends a connector the
    new name and the old one:

    - `agent.tools` in a binding. An older connector picks a side ask's tools by the old names (`session.ts`).
    - A tool group's `off` list. Each tool left out goes with its old name. A tool the group has never goes with
      either. Otherwise a member with `write` turned off would still have `write_file` on an older host.

    A newer connector under an older control plane (a self-hosted one) is covered by decision 9.

11. **The old spellings on the way out to apps.** An installed app from before the change lists the tools it knows
    (`groupToolInfo`), ticks those the tool-groups answer names, and saves the answer's names with its own changes
    (`workspace-tool-groups.tsx`). If the answer named `read`, that app would show **Read files** unticked for a group
    that has it, and couldn't turn it off. So the tool-groups API accepts either spelling and keeps answering the old
    one, and an app from this change on maps what it reads. Elsewhere an app only shows a tool's name (a transcript, a
    card), and an older app shows the new one with the default icon.

12. **The model's side.** The tool descriptions, the runtime instructions (`session/instructions.ts`), the note that
    points to a saved output (`tool-output.ts`) and code mode's names (`tools.read`) take the new names. A conversation
    from before the change keeps its old calls in its transcript, as it kept `bash`'s, and each message offers only
    the new names. A model may still call an old name out of habit. If the harness can hold a tool the model isn't
    shown, the five old names stay as such tools, running the new ones. If not, the refusal names the new tool.

13. **Extensions that name the tools.** `piki:pr-flow` watches for the tools that change files (`changingTools`). As a
    managed package it will run on connectors of either age, so it matches both spellings, and its version goes up.
    The other bundled extensions are checked for the same.

## What changes for people

- **Models and scripts** call `read`, `write`, `edit`, `ls` and `grep`. `grep` takes `ignoreCase` and `limit`, where
  `search` took `ignore_case` and `max_results`.
- **Results read differently.** A file's text comes as it is, not inside JSON, and `edit` answers a diff.
- **`edit` is more forgiving** (decision 2).
- **Extension authors** can match Pikibun's file tools as they match Pi's.
- **A workspace whose extension offers `read`, `write`, `edit`, `grep` or `ls`** loses that tool: Pikibun's has the name
  (decision 7). It was offered beside `read_file` or `search` until now. The extension's page says so.
- **Tool groups** look the same: the labels don't change, and a saved group keeps its tools.

## Phases

One pull request each.

1. **Pi's contract, under today's names.** Decisions 1 to 5, in the connector only. `read_file`, `write_file`,
   `edit_file`, `list_files` and `search` take Pi's parameters and answer as Pi's tools do; the transcript's summaries
   (`tool-summary.ts`) read the new results; the conformance suite lands. No saved name changes, and no extension
   matches these names, so no release has Pi's name on another contract.
2. **The rename.** Decisions 6 to 13: the shared lists and the map, the control plane, the connector, the app, the
   documentation and `piki:pr-flow`.
3. **`find`.** A walk by glob in each backend, sharing `search`'s walker, limits and conformance suite. The name is
   Pikibun's from then on (decision 7).
4. **Later, not scheduled: the old spellings go.** Once no supported connector or app predates phase 2, the control
   plane stops sending and answering them. Reading them (decision 9) can stay for as long as saved rows hold them.

## Where it lands

| Part | Where |
|---|---|
| The tools | `apps/runner/src/session/tools/files.ts`; `edits.ts` goes where nothing else uses it; `search.ts`, `images.ts`, the sandbox helpers (`ls`'s entry kinds, `find`) |
| The names, the map | `packages/shared/src/types.ts` (`toolNames`), `tool-definitions.ts` (`reservedToolNames`), `piki-extensions.ts` (`piki:files`), `workspace-tools.ts` |
| Tool groups | `packages/shared/src/tool-groups.ts` (`groupTools`, `groupToolInfo`, `roleTools`, `toolsOff`, `retiredGroupTools`, the parsers); `apps/server/src/authority/tool-groups.ts`, `apps/server/src/tool-groups.ts`; `apps/nsh/src/settings/workspace-tool-groups.tsx` |
| Bindings and agent versions | `apps/server/src/db.ts`, `catalog.ts`, `sessions.ts`; `apps/runner/src/protocol.ts`, `session.ts` (`readOnlyTools`) |
| The model's side | `apps/runner/src/session/instructions.ts`, `tool-output.ts`, `provider.ts` (the test provider) |
| Extensions | `apps/runner/src/extensions/load.ts` (which names are Pikibun's), `extensions/pr-flow/pr-flow.ts` |
| The transcript | `packages/shared/src/tool-summary.ts` (`callTarget`, both spellings); `apps/nsh/src/components/TranscriptEntry.tsx` has icons for both already |
| For people | `docs/models-and-tools.md`, `docs/extensions.md`, `docs/sessions.md`, `docs/design/piki-extensions.md` (note 21), `packages/cli/README.md` |

## Tests

- **Conformance.** Pi's real `read`, `write`, `edit`, `ls`, `grep` (and `find`) against ours, over one directory:
  `content` and `details` equal, apart from decision 5's exceptions. Ours runs on each sandbox backend that `search`'s
  conformance suite covers today.
- **Hooks.** A real extension blocks a `write` by path, rewrites a `read`'s input, and reads `read`'s and `edit`'s
  results with Pi's type guards.
- **Shadowing.** An extension's `read` and `read_file` are both ignored and reported; its `find` is offered until
  phase 3.
- **Old names in.** A binding, a tool group row, an `off` list and a backup that hold the old names give the new
  tools. A saved group with `read_file` still lets its members read.
- **Both names out.** A group that leaves out `write` sends `write` and `write_file` in `off`, and neither `read` nor
  `read_file`. A group that leaves out only `tunnel` sends none of the five.
- **An older app.** The tool-groups answer holds only names the app before this change knows.

## Not chosen

- **Aliases in the adapter only.** Send extensions `read` for `read_file` and leave the rest. It is a day's work, but
  it keeps two vocabularies for good, and the results would still not be Pi's, so only `tool_call` handlers would
  work.
- **Pi's tools as they are, over operations.** Decision 1.
- **Plain verbs for `move_file`, `copy_file` and `delete_file`.** Pi has no such tools, so there is no contract to
  match and nothing an extension gains. `copy` and `delete` are also names an extension is likelier to want.
- **A database migration.** Reading maps the names anyway, for older connectors and backups, so a migration would add
  a second way to be wrong on two database engines.
- **A connector capability in place of both spellings.** The control plane would send one spelling by what a connector
  reports. Sending both is one rule with no state, and a wrong report can't turn a tool back on.
- **Letting an extension replace a file tool.** Decision 7. A workspace could be given that choice later, as its own
  setting.
