# Tools defined as data

Status: implemented for `node`, `rust`, `go`, `dotnet`, `make` (program tools) and `source_read` (brokered). `git`,
`python`, `browser`, the file tools, `schedule`, `sessions`, the `github_*` tools and the `gh`/`glab`/`az` command
extensions are still code in the connector.

## Why

Every tool a session has used to be code in the connector, so a new one (a `jvm` tool, a new document provider's read)
reached hosts only with a connector release, and only once each host updated. But most of what makes one of these
tools differ from another is not code:

- A **program tool** runs one program with its arguments as a list, in the session's sandbox, as one approved command.
  What differs is which programs, a fixed environment, where to look for them, and which commands to refuse (`npm
  publish`, `cargo login`). `rust`, `go`, `dotnet` and `make` were already four rows of one table.
- A **brokered tool** does its work on the control plane, as the session owner. On the host it only checks its
  arguments, asks for its permission, and forwards the call. `source_read` already read every kind of document
  through one route, so a new kind of source needed no connector update.

So the connector is now an engine for both kinds, and the control plane describes the tools as data:
`packages/shared/src/tool-definitions.ts`.

## Decisions

1. **Data, never code.** A definition is JSON the connector parses strictly (`parseToolDefinition`): fixed fields, every
   string a bounded word, nothing it runs. What a definition can't express stays a tool of the connector's own; adding a
   new kind of rule is a connector change, as it should be.

2. **Program tools.** A definition names its `programs`, a fixed `environment` (each value a plain word, written into the
   command unquoted, so the card shows exactly it), `path` (absolute directories looked in after PATH), an optional
   `toolchain` the connector provides (`node`: its own Node.js, first on PATH), `systemDefaults` (a variable set to a
   directory where the host has it, unless the session names one: rust's `RUSTUP_HOME`), whether the Windows sandbox
   offers it, and its share of the agent's instructions. Its call becomes a `program` operation exactly as before:
   `{ kind: "program", tool, command }`, decided as commands are.

3. **Refusals as a grammar.** Which commands a program tool refuses is a `ProgramGrammar` per program, which
   `refusedCommand` (`apps/runner/src/defined-tools.ts`) interprets: options that take a value, a leading `+toolchain`,
   whether `--` ends the command's words, launchers (`npx`, `corepack`), words passed over (`pnpm recursive`, `yarn npm`),
   words passed over with their value (`workspace <name>`), runners (`pnpm dlx`, `rustup run <toolchain>`), and refused
   word sequences, optionally with an argument pattern (`dotnet nuget add source --password`). Launched programs are
   followed only within the definition's own grammar, at most four deep. Every refusal of `node`, `rust` and `dotnet`
   before this change is reproduced: `node-command.ts` and `ecosystem-command.ts` now wrap the engine with the bundled
   definitions, so their tests check the interpreter.

4. **Brokered tools.** A definition names its `parameters` (string, integer or boolean, with a pattern, length, one-line
   or enum check and its refusal's words), its permission `target` (the parameters given, joined by `: `, as the control
   plane checks a one-call permission), its `route`, whether it writes, and its paragraph of the instructions, where
   `{sources}` stands for the workspace's document sources of kinds that are on. The call needs a write admission, as
   `source_read` did, and posts `{ sessionId, actorId, admissionId, callId, ...arguments }` to
   `/api/connectors/self/<route>` (or `/api/internal/<route>` without a connector). `source_read`'s route is the one it
   always had, `sources/read`, so a new connector with an old control plane works unchanged. Parameter names are lower
   case, so they never collide with the request's own fields.

5. **What may never be defined.** No definition takes the name of a tool that is code (`reservedToolNames`: the file
   tools, `git`, `python`, `browser`, the brokers, the retired shells), and the session drops one that does. No
   environment variable that changes what runs or how a shell starts (`PATH`, `LD_*`, `DYLD_*`, `BASH_ENV`,
   `NODE_OPTIONS`, `GIT_*` ...). No relative directory, no `..`, no route outside its place.

6. **Where definitions come from.** The control plane serves its definitions at `POST /api/connectors/self/tools`
   (`bundledToolDefinitions` of its release). A connector asks at most once a minute (`ToolDefinitionsSource`), keeps the
   last answer while it can't ask, and otherwise uses the ones it bundles: a control plane from before this change
   answers 404, and sessions get the tools they always had. A list keeps what it can parse, so a newer kind costs only
   its own tool.

7. **When a session gets them.** A session builds its defined tools when it opens, into the same extension as its own
   tools, so a call the durable harness resumes finds its tool. Each write message asks again: a tool by a new name joins
   as one more installed extension at once; a changed definition of a tool the session has applies when it next opens.
   An extension's tool named like a defined one is left out, as for the session's own.

8. **Switches.** A definition names the Pikibun extensions that turn it on (`extensions`): it is offered while any of
   them is on (`source_read` has one per kind of document source). The connector decides each by `extensionSwitchOn`: as
   the catalogue says for an extension it knows, and for one only a newer control plane names, on unless the workspace
   lists it turned off. Such a connector asks for the workspace's extensions with `toolDefinitions: true`, and the
   control plane then sends it the switches of every extension its definitions name, though the connector doesn't report
   having them; its parser lets switches it doesn't know take no place among the workspace's 32.

9. **Names in operations and agents.** `ProgramOperation.tool` and a permission's `tool` may name a defined tool. The
   control plane accepts Pikibun's own and those it defines (`parseOperation`). The connector accepts its own program
   tools and those it has read from the control plane since it started (`knownDefinedProgramTool`); a session reads them
   as it opens, before any decision of its own comes back. New sessions' agents list every defined tool too
   (`catalog.ts`), so their calls need no permission card; a connector that doesn't know one doesn't offer it.

10. **Document kinds on the control plane.** `source_read`'s per-kind switches (piki-extensions.md, note 35) are held
    where the read happens: the control plane refuses to read a source whose kind the workspace turned off
    (`source_kind_off`), before and after the read. Connectors from before the split, which offer `source_read` for every
    kind, are held to it too.

## Adding a tool

- A program tool or brokered tool the engine can express: add its definition to `bundledToolDefinitions`, its switch
  to the Pikibun extension catalogue (`piki-extensions.ts`, `sessionTools`), its description for people
  (`pikibunToolDescriptions`), and for a brokered tool its route on the control plane. Connectors of this release and
  later run it as soon as the control plane is deployed. `tests/defined-tools.test.ts` checks the catalogue agrees.
- Name it outside `toolNames`: older connectors ignore an agent tool they don't know.

## Later

- `python` and `git` as definitions: python's `venv` parameter and `-m module` launching, and git's subcommand list and
  abbreviated, clustered options, need rule kinds of their own.
- `gh`, `glab` and `az` as program tools in the sandbox, with the proxy's credentials as a definition's field.
- A changed definition applying to an open session at its next message, not its next open.

## Where things are

| Part | Where |
|---|---|
| Types, parser, bundled definitions | `packages/shared/src/tool-definitions.ts` |
| The engine: grammar, requests, commands, brokered arguments | `apps/runner/src/defined-tools.ts` |
| Reading them on a connector | `apps/runner/src/tool-definitions-source.ts`; `connector.ts` (`toolDefinitions`, `brokered`) |
| Registering, switching and running them in a session | `apps/runner/src/session.ts` (`fetchDefinitions`, `refreshDefinitions`, `definedTool`, `sessionToolsOff`) |
| Serving them; names in operations and agents | `apps/server/src/connectors.ts`, `authority/operations.ts`, `catalog.ts`, `extensions.ts` |
| Tests | `tests/defined-tools.test.ts`, and in `node-command`, `ecosystem-command`, `runner-program-tools`, `connectors` |
