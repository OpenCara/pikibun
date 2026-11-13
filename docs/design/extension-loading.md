# Loading Pikibun's extensions without a connector release

Status: a plan. Nothing here is implemented yet; the phases at the end say what lands in which order.

## Why

Hosts update their connectors slowly, so anything compiled into the connector reaches a host only when its owner
restarts it on a newer release. Every `piki:` extension is compiled in today ([Pikibun's extensions](piki-extensions.md),
rule 2): its version is the connector's, a fix to the pull request flow's prompt waits for each host to update, and
two hosts of one workspace can run two versions of the same extension.

Adding one costs a connector release too, even when its code needs nothing of the connector:

- The catalogue (`packages/shared/src/piki-extensions.ts`) is compiled into the connector, the control plane and the
  client, and the connector builds a `piki:` extension only from that catalogue and its own table of factories
  (`apps/runner/src/extensions/piki/index.ts`).
- The extension store refuses every `piki:` source (`apps/runner/src/extensions/store.ts`), so there is no other way
  in.

Two things already load without a release. Installed extensions (`npm:`, `git:`) come from the store, side by side by
version, with no restart ([host extensions](host-extensions.md)). And six tools are data the control plane serves
([tool definitions](tool-definitions.md)). This plan extends both to Pikibun's own extensions, and leaves in the
connector only what has to be there.

## What is embedded today

The catalogue's entries are four kinds of thing, and each kind leaves the connector a different way, or not at all.

| Kind | Which | What the connector holds | Where it goes |
|---|---|---|---|
| Hook packages | `piki:pr-flow`, `piki:context-files`, `piki:prompt-audit` | A static import of `extensions/<name>/`, which is also published to npm as `@pikibun/pi-<name>` | A **managed package**: the npm package, at a version the control plane pins (decisions 2 to 9) |
| Tools as data | `node`, `rust`, `go`, `dotnet`, `make`, `source_read`, switched by `piki:node` and the like | An engine; the definitions come from the control plane | Already there. `gh`, `glab`, `az`, then `git` and `python`, join them (decision 10) |
| Tools that hold authority | The file tools, `git_push`, `github_*`, `sessions`, `schedule`, `browser`, `tunnel` | The tool itself; its `piki:` entry is only a switch | They stay (decision 11) |
| The catalogue | Titles, descriptions, which tools an entry switches | A compiled copy | Served by the control plane to its clients (decision 12) |

`piki:auto-mode` runs on the control plane and no connector loads it, so it is already free of connector releases.

## Decisions

1. **By kind, not one mechanism.** "Load everything on the fly" would have to load the sandbox backends and the brokers'
   callers too, which are the trust boundary. Code that only reacts to Pi's events loads as a package; a tool the
   engine can express is data; a tool that needs new authority on the host is a connector change, and should be.

2. **A managed package backs a `piki:` extension.** The control plane's release holds a list of pins
   (`managedExtensions`, `packages/shared/src/managed-extensions.ts`):

   ```ts
   { source: "piki:pr-flow", package: "@pikibun/pi-pr-flow", version: "0.2.0",
     integrity: "sha512-...", minimumConnector: "0.31.0" }
   ```

   `integrity` is the registry's own digest of that version's tarball (`dist.integrity`), and `minimumConnector` the
   oldest connector release that can run it. A connector installs the package into the extension store and loads it in
   place of its bundled copy. The source stays `piki:<name>`: workspace rows, default extensions, migrations and a
   host's required extensions name it as they do now, and none of them names a version.

3. **The control plane's release sets the version, for every host.** A workspace pins the version of an `npm:`
   extension because someone else publishes it. Pikibun publishes these, so their version is the control plane
   release's, as it was the connector release's. One pin per source also means every host of a control plane runs the
   same version, which they don't today, unless a host already has a newer one (decision 7). A pin is added only once
   its version is published. Versions only go up: a bad version is withdrawn by publishing and pinning a newer one,
   never by pinning the one before.

4. **Pins travel in the sync a connector already makes.** The answer to `POST /api/connectors/self/extensions`
   (`ExtensionsSyncAnswer`) gains `managed`, the whole list. The connector decides which pins it can use, since it is
   the one that has to refuse a bad one. A connector from before reads only `requests` and ignores the rest; a control
   plane from before sends no `managed`, which a connector takes as no pins (decision 7: its bundled copies, on a host
   that never loaded a managed version). Nothing new is reported: the
   connector reports each `piki:` source as it does now, with the managed package's `version` where it runs one
   (`InstalledExtension.version`), so the host's page shows which version a host has.

5. **Installed by the store, in a place of its own.** Managed packages install as other packages do (`npm install`
   of the exact version, `--ignore-scripts`, no peer dependencies) into `<state-dir>/extensions/managed/<digest>/`, with
   their own index beside `sources.json`. They don't count among a host's 64 installed sources, `pikibun extensions
   remove` refuses them, and `pikibun extensions list` shows them as managed, with their version. The index marks a
   version once a session has loaded it. At the first sync after it starts, the connector deletes the versions that
   are neither pinned nor the newest loaded one of their source (decision 7 needs that one). Not sooner: an open
   session may still run an older one, and the connector doesn't track which session loaded which. Until then a host
   keeps one directory for each version pinned since it started, a few files each.

6. **What the connector checks before loading one.** All of these, or it doesn't load the package:
   - The package is in the `@pikibun/` scope. The scope is a constant of the connector, not something a pin can widen.
   - Its own release is at least `minimumConnector`.
   - The lock file npm wrote names that one package and nothing else, at the pinned version, and its `integrity`
     equals the pin's. Published extensions import only Node's modules and their peer dependencies
     (`scripts/check-extension-packages.mjs`), so a second package in the lock file is a reason to refuse.
   - Every module loads without an error.

   A package that fails a check is removed, the reason goes to the connector's log, and the pin is tried again no
   sooner than ten minutes later, so an unreachable registry isn't asked every sync. That wait is kept in memory: a
   connector that restarts tries each pin once more, which costs one install for each start.

7. **The newest version a host can vouch for runs.** For each `piki:` source the connector has up to three candidates:
   - the pinned package, once it has passed decision 6;
   - the newest managed version this host has loaded before, while it is still installed;
   - its bundled copy, whose version is the one committed in `extensions/<name>/package.json`.

   It runs the candidate with the highest version, compared as semantic versions, and nothing where it has none.
   That is the whole rule: no candidate is passed over for any other reason, neither the bundled copy because a pin
   exists nor a loaded version because a pin failed. Where two are equal, the pinned package goes before the loaded
   one, and either before the bundled copy. The connector installs a pinned package only when its version is at least
   the other two's, so only when it would run.

   | Bundled | Loaded before | Pin | Runs |
   |---|---|---|---|
   | 0.2.0 | none | 0.3.0, passes | The pinned 0.3.0 |
   | 0.2.0 | none | 0.1.5 | The bundled 0.2.0; the pin isn't installed |
   | 0.2.0 | 0.4.0 | 0.2.5 | The loaded 0.4.0; the pin isn't installed, and decision 5 keeps 0.4.0 |
   | 0.3.0 | 0.4.0 | 0.2.5 | The loaded 0.4.0, not the bundled copy |
   | 0.2.0 | 0.4.0 | 0.5.0, fails a check or can't be installed | The loaded 0.4.0 |
   | 0.5.0 | 0.4.0 | 0.6.0, fails a check or can't be installed | The bundled 0.5.0: a connector update still reaches the host |
   | 0.5.0 | 0.4.0 | none | The bundled 0.5.0 |
   | none | 0.1.0 | none, or one that fails | The loaded 0.1.0 |
   | none | none | 0.1.0, fails a check or can't be installed | Nothing: the extension is missing |

   So neither a mistaken pin nor a compromised control plane takes a host back to an older version, with whatever
   that version got wrong, and a host that is offline or can't reach npm goes on as it was. This matters most for a
   guard: a host that requires `piki:prompt-audit` takes no messages while it can't run it, and must not stop because
   a registry is down. An extension added later has no bundled copy (the last two rows); where a host is without it,
   its page says why, and it is treated as any missing extension is ([host extensions](host-extensions.md), "Missing
   means without", and "The host's owner requires extensions" for a required one).

   Three connectors have the bundled copy as their only candidate, whatever is pinned and whatever is on disk, and
   install nothing: one run from source (`dev`), which is there to run the working tree's `extensions/`; one started
   with `--no-remote-installs`; and one started without `--managed-extensions`. The last two are the host owner's own
   way back to the bundled copies.

   For the comparison to mean anything, the committed version in `extensions/<name>/package.json` has to be the
   published one: the extension release refuses a tag that differs from it (today it sets the tag's version, and the
   committed one need not match).

   Some sources run only from their bundled copy, whatever is pinned: a list in the connector, which holds
   `piki:prompt-audit` until phase 4 (it needs the host's model keys, which the extension process of phase 2 won't
   have). The connector ignores a pin for one of them.

8. **A new version applies when a session next opens.** A session loads its extensions when it opens and keeps them
   (`SessionExtensions.ensure` skips a source it has opened), so a session never changes version under a running
   message. Versions sit side by side by path, as in the store, so no restart is needed. A managed package's tools,
   should one register any, are an installed extension's tools in every respect (`extension.tool`); none does today,
   and a tool Pikibun wants every session to have belongs to decision 10 or 11.

9. **Who is trusted with what.** Today a host runs Pikibun's extension code because its owner started that connector
   release. With managed packages it runs code its connector fetched since. What bounds that:
   - Two parties must agree. The registry serves the tarball and the control plane names its digest: a compromised
     publish alone changes nothing a pin names, and a compromised control plane alone can only name versions already
     published under `@pikibun/`, each with provenance from this repository's release workflow, and none of them
     older than what the host already runs (decision 7).
   - Nothing runs at install (`--ignore-scripts`), and nothing else is installed (decision 6).
   - The host's owner can refuse it: `--no-remote-installs`.
   - It is off until the extension process exists. An extension runs in the connector's own process, and a version
     that reaches every host within a sync must not be able to stall or crash a connector. So phase 1 loads managed
     packages only where the host's owner starts the connector with `--managed-extensions`; phase 2 puts installed
     and managed extensions in a child process per session ([extension isolation](extension-isolation.md), steps 1
     and 2) and makes it the default wherever remote installs are allowed. The sandbox of step 3 is what later
     confines the code itself.

   These reasons move to [security-rationale.md](security-rationale.md) with the code of phase 1.

10. **Tools become definitions where the engine can express them.** This is [tool definitions](tool-definitions.md)'
    own "Later", in the order use asks for:
    - `gh`, `glab` and `az` are program tools in the sandbox already. A definition needs four things the engine
      lacks: the token variables the proxy's placeholder goes in, an allow-list of commands for the `read-only`
      setting, the arguments that would print a credential (refused in every spelling, [Pikibun's
      extensions](piki-extensions.md), rule 4), and a default for an option (`--interval 30` on a watch). Running one
      on the host with the host's own sign-in (rule 9) stays connector code.
    - `git` and `python` need an allow-list of first words, options matched as the program reads them, modules
      followed as programs, and one more parameter (`venv`).

    Each new kind of rule is a connector change, once; tools that use it afterwards are not.

11. **What stays in the connector.** The file tools, `git_push`, the brokers' callers, `sessions`, `schedule`,
    `browser`, `tunnel`, the sandboxes and the proxy. They decide what a session may reach, they are reviewed with the
    connector, and loading them from elsewhere would need a stable interface to the sandbox, the leases and the
    brokers that nothing else needs. What changes often in them belongs on the control plane, as `source_read`'s kinds
    are.

12. **The catalogue is served.** The control plane has the catalogue of its own release, so its pages need nothing.
    Installed apps compile a copy and would show a new extension by its source alone until they update, so the
    workspace's and host's extension routes return the entries they show (title, description, tools) and the client
    prefers those. The connector needs no catalogue entry for a managed package: it takes the name and description
    from the package, as it does for an installed one, and accepts a `piki:` name it has never heard of when a pin
    names it.

## What adding an extension touches

| Adding | Today | After |
|---|---|---|
| An extension that only reacts to Pi's events | Connector, control plane and client releases | A package published to npm and a control plane release (its catalogue entry and pin); phase 1 |
| A program or brokered tool the engine can express | A control plane release | The same |
| A command-line tool with the proxy's credentials (a `tea` for Gitea) | Connector, control plane and client releases | A control plane release; phase 3 |
| An extension that needs a Pi event the connector doesn't map, or a new kind of rule | A connector release | A connector release, once for that event or rule |
| A tool that needs new authority on the host | A connector release | A connector release, always |

A managed extension that needs a newer connector says so in `minimumConnector`: older hosts keep their bundled copy,
or are without it, and their page says to update.

## Phases

Each is one pull request, and leaves every host working as before until its owner opts in or updates.

| Phase | What lands | How it is held |
|---|---|---|
| 1 | Managed packages (decisions 2 to 9) behind `--managed-extensions`, with an empty list of pins. A connector accepts a pin for a `piki:` name it doesn't know. | `tests/managed-extensions.test.ts`: every row of decision 7's table, with all three versions set in each, so that a choice which looks at the bundled copy first, or at the pin first, fails one; the kept version survives a restart and the pruning after it; each check of decision 6 (a wrong digest, a second package in the lock file, another scope, a newer `minimumConnector`, a module that fails) makes the pin no candidate; a managed package that runs reports its version; a connector from source, one with `--no-remote-installs` and one without `--managed-extensions` run the bundled copy with a newer managed version on disk; a pin for `piki:prompt-audit` is ignored; a pin for a `piki:` name the connector doesn't know loads; an open session keeps its version; a control plane without `managed` changes nothing |
| 2 | The extension process, unsandboxed ([extension isolation](extension-isolation.md), steps 1 and 2), for installed and managed extensions. Managed packages become the default where remote installs are allowed, and `--managed-extensions` goes. | The extension tests run through the process; a hook that blocks the event loop ends its process, not the connector |
| 3 | `gh`, `glab` and `az` as definitions | `tests/piki-extensions.test.ts`' refusals and read-only cases run against the engine |
| 4 | `prompt-audit` as a managed package, once the extension process can ask the connector for a model call; the sandbox for the extension process (isolation, step 3) | `tests/prompt-audit.test.ts` through the process; `tests/sandbox-conformance.test.ts` |
| 5 | `git` and `python` as definitions | Their own tests against the engine |
| 6 | The catalogue served to clients | A client with an older catalogue shows a newer extension's title and tools |

The first pins are added by the release after phase 1: publish the extension (`ext-<name>-v`), read its digest
(`npm view @pikibun/pi-<name>@<version> dist.integrity`), add the pin, release the control plane. `docs/development.md`
gets that step with phase 1.

Phase 2 changes one line of [extension isolation](extension-isolation.md), which keeps every `piki:` extension in the
connector: a bundled copy and the command extensions stay there, but a managed package is a store package and runs in
the extension process like any other.

`prompt-audit` waits for phase 4 because it calls a model with the host's keys (`ctx.modelRegistry`), which the
extension process doesn't have. Until then it runs from its bundled copy, in the connector (decision 7).

## Phase 1, where the changes are

| Part | Where |
|---|---|
| The pin's type, the list, its parser, the scope | `packages/shared/src/managed-extensions.ts` (new) |
| `managed` in the sync answer | `packages/shared/src/host-extensions.ts` (`ExtensionsSyncAnswer`, `parseExtensionsSyncAnswer`); `apps/server/src/extensions.ts` |
| Installing, checking the lock file, marking a version loaded, pruning | `apps/runner/src/extensions/store.ts` |
| The committed version is the published one | `.github/workflows/release-extensions.yml`, `scripts/set-release-version.mjs` |
| Choosing among the pinned package, the newest loaded version and the bundled copy for each `piki:` source | `apps/runner/src/extensions/load.ts` (`loadInstalled`), `host.ts` (`HostExtensions`). `refreshIfChanged` tells store sources from bundled ones by `factories`; a managed source has files, so it needs a mark of its own |
| Passing the pins on | `apps/runner/src/connector.ts` (`syncExtensions`) |
| The option, and the list | `apps/runner/src/connect-cli.ts`, `extensions-cli.ts` |
| For people | `docs/extensions.md`, `host-extensions.md`, `piki-extensions.md` (rule 2), `security-rationale.md`, `docs/development.md` |

`apps/runner/src/extensions/adapter.ts` needs no change: it takes a `piki:` source with `factories` as bundled and anything with files
as a package.

## Not chosen

- **The three as plain `npm:` extensions.** It needs no new mechanism, but every workspace would pin a version, every
  host's owner would click **Install** for each new one, the default extensions and their migrations would name
  versions, and a host's required guard would lapse at each update until its owner installed it.
- **The control plane serving the code itself.** One party would then decide what runs on every host. With npm and a
  pin, two must agree, and the package carries provenance.
- **No bundled copies.** Smaller, but a host without the registry, or one that requires the prompt audit, would stop.
  Once phase 2 has run for a while and installs prove reliable, the copies of `pr-flow` and `context-files` can go.
- **Loading the session's own tools from packages.** Decision 11.
