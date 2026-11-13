# Pi's names and contracts for the file tools

Status: phases 1 and 2 are built (see [Phase 1 as built](#phase-1-as-built) and [Phase 2 as built](#phase-2-as-built)); phase 3 is planned. The phases at the end say what lands in which order.

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
     (`apps/runner/src/script-output.ts`).

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

7. **Pikibun's tool wins a name.** The loader already ignores an extension's tool named like one of Pikibun's
   (`apps/runner/src/extensions/load.ts`, among the module's `ignored`), and the workspace's page shows it as left out
   (`packages/shared/src/workspace-tools.ts`: `shadowed`, kind `own`). After the rename that covers `read`, `write`,
   `edit`, `grep` and `ls`, and `find` from phase 3. An extension's tool runs in the connector, outside the sandbox, so letting it take
   the confined `read`'s place would change what the name can reach without the workspace choosing that. Until
   phase 3 an extension's `find` is offered as now.

### The rename

8. **The old names are renamed, not retired.** `retiredToolNames` are names with no tool behind them: an extension
   may take one, and a tool group that leaves anything out turns them all off. The five old names are another kind.
   Saved rows, older connectors and old transcripts still mean Pikibun's tools by them. So `packages/shared` gets
   `renamedToolNames` (old to new), `canonicalToolName(name)` and `legacyToolNames(name)`. The old names stay
   Pikibun's own:

   - The loader ignores an extension's tool with an old name as it ignores one with a new name. It decides by
     `toolNames` less `retiredToolNames` today, which the rename alone would let `read_file` through.
   - A tool definition can't take one either (`reservedToolNames`).
   - They never join `retiredGroupTools`.

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

    - `agent.tools` in a binding. An older connector gives a side ask the read-only tools that `agent.tools` names,
      and it knows them as `read_file`, `list_files` and `search` (`apps/runner/src/session.ts`, `readOnlyTools`).
      Without the old names its side asks would have no file tools.
    - A tool group's `off` list. Each tool left out goes with its old name. A tool the group has never goes with
      either. Otherwise a member with `write` turned off would still have `write_file` on an older host.

    A newer connector under an older control plane (a self-hosted one) is covered by decision 9.

11. **The old spellings on the way out to apps.** An installed app from before the change lists the tools it knows
    (`groupToolInfo`), ticks those the tool-groups answer names, and saves the answer's names with its own changes
    (`workspace-tool-groups.tsx`). If the answer named `read`, that app would show **Read files** unticked for a group
    that has it, and couldn't turn it off. So the tool-groups API accepts either spelling and keeps answering the old
    one, and an app from this change on maps what it reads. Elsewhere an app only shows a tool's name (a transcript, a
    card), and an older app shows the new one with the default icon.

12. **The model's side.** The tool descriptions, the runtime instructions
    (`apps/runner/src/session/instructions.ts`), the note that
    points to a saved output (`apps/runner/src/tool-output.ts`) and code mode's names (`tools.read`) take the new
    names. A conversation from before the change keeps its old calls in its transcript, as it kept `bash`'s, and each
    message offers only the new names.

    The old names don't stay callable. A model may call one out of habit, and pi-durable settles a call to a tool the
    request didn't offer as `tool_unavailable` ("Tool read_file is not available") without running anything, whatever
    is registered. So no hidden alias can serve it. Where Pikibun's own tool hook sees that result for a renamed
    name, it adds which tool to call instead. Where it doesn't, the model has the harness's refusal and the offered
    list, and that is accepted.

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
| The tools | `apps/runner/src/session/tools/files.ts`; `apps/runner/src/edits.ts` goes where nothing else uses it; `apps/runner/src/search.ts`, `apps/runner/src/images.ts`, the sandbox helpers (`ls`'s entry kinds, `find`) |
| The names, the map | `packages/shared/src/types.ts` (`toolNames`), `packages/shared/src/tool-definitions.ts` (`reservedToolNames`), `packages/shared/src/piki-extensions.ts` (`piki:files`), `packages/shared/src/workspace-tools.ts` |
| Tool groups | `packages/shared/src/tool-groups.ts` (`groupTools`, `groupToolInfo`, `roleTools`, `toolsOff`, `retiredGroupTools`, the parsers); `apps/server/src/authority/tool-groups.ts`, `apps/server/src/tool-groups.ts`; `apps/nsh/src/settings/workspace-tool-groups.tsx` |
| Bindings and agent versions | `apps/server/src/db.ts`, `apps/server/src/catalog.ts`, `apps/server/src/sessions.ts`; `apps/runner/src/protocol.ts`, `apps/runner/src/session.ts` (`readOnlyTools`) |
| The model's side | `apps/runner/src/session/instructions.ts`, `apps/runner/src/tool-output.ts`, `apps/runner/src/provider.ts` (the test provider) |
| Extensions | `apps/runner/src/extensions/load.ts` (the old and new names are Pikibun's, decision 8); `extensions/pr-flow/pr-flow.ts` at the repository's root |
| The transcript | `packages/shared/src/tool-summary.ts` (`callTarget`, both spellings); `apps/nsh/src/components/TranscriptEntry.tsx` has icons for both already |
| For people | `docs/models-and-tools.md`, `docs/extensions.md`, `docs/sessions.md`, `docs/design/piki-extensions.md` (note 21), `packages/cli/README.md` |

## Tests

- **Conformance.** Pi's real `read`, `write`, `edit`, `ls`, `grep` (and `find`) against ours, over one directory:
  `content` and `details` equal, apart from decision 5's exceptions. Ours runs on each sandbox backend that `search`'s
  conformance suite covers today.
- **`edit` stays off the host.** With Pi's `execute` under decision 2, no path the model can give makes Pi read,
  write or probe a path of the host: an absolute path, `~`, `..` and a leading `@` are refused or stay under the
  made-up `cwd`. Phase 1 doesn't land without it.
- **Hooks.** A real extension blocks a `write` by path, rewrites a `read`'s input, and reads `read`'s and `edit`'s
  results with Pi's type guards.
- **Shadowing.** An extension's `read` and `read_file` are both ignored and reported; its `find` is offered until
  phase 3.
- **Old names in.** A binding, a tool group row, an `off` list and a backup that hold the old names give the new
  tools. A saved group with `read_file` still lets its members read.
- **Both names out.** A group that leaves out `write` sends `write` and `write_file` in `off`, and neither `read` nor
  `read_file`. A group that leaves out only `tunnel` sends none of the five.
- **An older app.** The tool-groups answer holds only names the app before this change knows.

## Phase 1 as built

Phase 1 landed as decisions 1 to 5 describe, with these differences and details.

- **The schemas and the text.** `apps/runner/src/pi-file-tools.ts` takes each tool's parameters from Pi's definition
  (`piParameters`; `search` adds `all`) and builds its text with Pi's exported helpers. The tools in
  `apps/runner/src/session/tools/files.ts` keep their execution over `SessionWorkspace`. pi-durable takes Pi's TypeBox
  schemas for them as it does for an extension's tools, and a result's `details` is stored with it
  (`tests/runner-files.test.ts` reads them back from the harness).
- **`edit` and the made-up `cwd`.** It is `/pikibun-edit-<random>` (on Windows, at the root of the connector's current
  drive), which doesn't exist. Before Pi runs, `editTarget` resolves the path as Pi will (Unicode spaces, a leading
  `@`) and refuses any path that leaves that directory: absolute, `~` and `@~`, `file:`, a drive, or `..` above it.
  Pi's operations then check that Pi asked for that same file, and read and write the model's own path through the
  sandbox, so the file changed is the one `read_file` and `write_file` would name by that path (Pi alone would drop a
  leading `@`). `access` checks nothing: the read after it fails for a missing file. The only host call left in Pi's
  code is the mutation queue's `realpath` of a path under the made-up directory. The guard and Pi resolve with the
  same platform's path rules, so this holds on Windows too; `tests/pi-file-tools.test.ts` runs in the `platforms` job
  on macOS and Windows. Pi's `prepareArguments` repairs `edit`'s arguments, on a copy, since pi-durable requires it
  not to change them.
- **`ls`'s entry kinds.** The sandbox helpers' `list` takes `marked: true` (`SessionWorkspace.listEntries`) and answers
  each name with `/` after a directory, in one call. It doesn't follow links, so a link to a directory has no `/` and a
  dangling link is listed, where Pi's `stat` follows a link and skips a broken one. A directory of more than 10,000
  entries is refused, as `list_files` refused it before.
- **`grep`'s engine.** The walkers in `search.ts` and the Python helper changed where Pi's contract needed it: a glob
  with `/` matches from the searched path, not the worktree's top (a leading `./` is dropped; ripgrep's `!` isn't
  supported); a line is kept up to 500 characters and cut by Pi's `truncateLine`; a UTF-8 byte order mark is dropped
  before matching, as ripgrep drops it; and a search goes on past its limit only to find one more match, so the limit's
  notice appears only when it cut something off (before, `truncated` came whenever the limit was reached with files
  left). Overlapping context is merged as ripgrep merges it, and paths are from the searched path (a file's base name
  when `path` is a file). Matches come sorted by path, where ripgrep's order across files varies. When Pikibun's own
  file, size or time limit stops a search, a notice of its own says so. At `limit` 500, the notice doesn't offer a
  larger limit.
- **`read`.** The notice for a first line over 50 KB says a code mode script's `read_file` gets whole lines. A
  script gets the selection whole and an image as the content list, not Pi's image object. The unsandboxed host's
  workspace now keeps a file's byte order mark, as the sandbox helpers do, so `edit` keeps it on every backend.
- **Paths.** All five refuse `~` and `~/…`. `list_files` takes a trailing `/`.
- **Output limits.** Pi's text can pass 50 KB or 2,000 lines by its notice, so `read_file`, `list_files` and `search`
  bound their output at 54 KB, with no line limit, instead of the harness's 50 KB and 2,000 lines.
- **`details.pikibun`** is on a successful result; a call that fails throws, as before, and carries none.
- **The transcript.** `resultSummary` and `resultBody` take the tool's name: a file tool's result is read in Pi's
  words (`Lines 60–89 of 975`, `3 matches in 2 files`, `Edited (2 edits)`), a failed call reads as its error, and a
  result from before, which starts with `{"initiatedBy"`, keeps its old summary.
- **The conformance suite** is `tests/pi-file-tools.test.ts`. It runs Pi's real `read`, `ls`, `grep`, `write` and
  `edit` over one directory and ours over each backend of the sandbox conformance suite, and compares `content` and
  `details`, sorting a directory search's lines. Pi's `grep` needs ripgrep: CI installs it, and elsewhere the suite
  skips `grep` with a note. The hooks test of decision 6 lands with phase 2, with the names it matches.

## Phase 2 as built

Phase 2 landed as decisions 6 to 13 describe, with these differences and details.

- **A binding's `agent.tools` is mapped where it is read, not in `protocol.ts`.** The connector compares a session's
  binding byte for byte with the one it stored (`session.ts`, "Persisted binding mismatch"; `server.ts` when a session
  is provisioned again; restores), so rewriting it on the way in would refuse every session from before the rename. The
  runner maps it where it uses it instead (`canonicalToolNames` for a side ask's read-only tools and for the
  instructions), and backups and restores carry it as it was.
- **Both spellings go out in the agent version, not at each send.** An agent version is immutable and its binding is
  sent again when an errored session restarts, so the control plane writes `tools_json` with both spellings when it
  makes the version (`chatAgentVersion`, `migratedAgentVersion`, `withLegacyToolNames`). For the same reason
  `agentVersion` in `db.ts` passes the saved names through unchanged: a version from before holds only the old names,
  which a newer connector maps and an older one knows. `migratedAgentVersion` maps the names it reads before it
  chooses the tools a host carries.
- **Tool groups.** `canonicalGroupTools` maps a saved group's tools before `isGroupTool` filters them, in `groupOf`,
  `memberTools` and `parseGroupTools` (which takes either spelling). `toolsOff` adds each left-out tool's old name;
  `retiredGroupTools` comes from `toolNames`, which no longer holds the old names, so they never join it.
  `parseMemberToolGroups` maps an `off` list to the new names. `requireSessionTool` maps the name an older connector
  asks about, and its refusal names the tool as the connector asked.
- **The tool-groups API** answers `groups[].tools`, `roles` and `tools` in the old spellings
  (`legacyGroupToolNames`) and takes either; a group is saved in the new names. On the wire these are now `string[]`,
  and the app maps them with `canonicalGroupTools` before it ticks its boxes and summarizes a group.
- **The old names refused at the harness.** Pikibun's own hook sees the harness's `tool_unavailable` result for a call
  to a tool the request didn't offer, so `renamedToolsHook` (`apps/runner/src/session/renamed-tools.ts`, on the
  `workspace-tools` extension) adds a note that names the tool to call instead.
- **Extensions.** `pikibunOwn` in `apps/runner/src/extensions/load.ts` leaves out an extension's tool with a new or an
  old name; `reservedToolNames` holds both. On the workspace's page, an extension's tool reported under an old name
  shows as left out by `piki:files`. An extension's `find` is offered until phase 3. Pi's type guards
  (`isToolCallEventType("write", event)`, `isReadToolResult`, `isEditToolResult`) match the tools in a real
  extension's hooks, and a `tool_result` handler gets `details` as the tool returned them, `details.pikibun`
  included (`tests/pi-tool-names.test.ts`).
- **`piki:pr-flow`** matches both spellings and is version 0.2.0 in `extensions/pr-flow/package.json`; publishing
  and pinning it is a release of its own. `piki:context-files` and `piki:prompt-audit` name none of the tools.

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
