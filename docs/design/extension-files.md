# Files a host shares with extensions

Many Pi extensions read their settings from a file rather than Pi flags: `pi-web-access` reads `web-search.json`
(provider API keys, a proxy, `ssrf.allowRanges` for a TUN or fake-IP proxy whose DNS answers in `198.18.0.0/15`, domain
rules), found through `PI_CODING_AGENT_DIR`, `XDG_CONFIG_HOME/pi` or `~/.pi/agent`. A workspace's extension settings
are Pi flags and never secrets ([host extensions](host-extensions.md), rule 8): the extension is meant to read its
secrets on the host. In a sandboxed session there is none of the host's files ([extension
isolation](extension-isolation.md)), so such an extension ran there with no configuration at all: no keys, and every
fetch of a fake-IP address refused. This note says how the host's owner gives it the file without it reaching anyone
else.

## Decisions

1. **The host's owner names files, never their contents.** `HostConfig.extensionFiles` lists at most 32 entries, owner
   only (`ownerOnlyHostConfig`), set through `PATCH /api/connectors/:id/config` and audited (`host.config.updated`) like
   the rest of the host's configuration. Each names the extension's package (`npm:<name>` or `git:<url>[#<dir>]`,
   `extensionFilePackage`, so an update keeps it), the file on the host (an absolute path or one from `~/`, without
   `..`) and its place in the session's home (relative, without `.` or `..`, never `.gitconfig` or `.tmp`, one file per
   place). The file's contents stay on the host: Pikibun stores and shows only the path. Admins receive the host's
   configuration as before, so they could read the path; the page shows the list to the owner only.
2. **Bound read-only into the extension's process, never the agent's commands.** On Linux the session's installed
   extensions run in a service of their own (`sandboxLaunch` → `Sandbox.startService`), a `bwrap` apart from each
   command's. When the session opens an extension whose package has entries, `ProcessChannel` asks the session for them
   (`files`), and the next start of that service adds `--ro-bind-try <real host file> <session home>/<place>`. The
   session resolves `~/` against the connector's home and follows links (`extensionFileBinds`), and `startService`
   checks both ends (`serviceBindAllowed` for the host file, so never `/etc`, `/proc` and the like; `homeFileTarget` for
   the place). The agent's commands run in other `bwrap`s without the bind: where the place didn't exist, `bwrap` leaves
   an empty file there, which is all they see. The rest of the session's home stays writable to the extension, which
   `pi-web-access` needs for its fetch cache beside its configuration.
3. **Every installed extension in the session shares that process.** One worker per session runs all of its installed
   extensions, so a bound file is readable by the others too. Splitting the worker per package would cost a process and
   a sandbox per extension per session; the owner is told instead to share only what the extension needs, and never
   Pi's `auth.json`.
4. **Changes apply between calls.** The channel asks for the entries again at most every 30 seconds
   (`FILES_REFRESH_MS`), on a request while none is in flight, and starts the process again only when they changed, as
   it does for a new extension's files. So a file the owner stops sharing leaves a running session within about a minute
   of its next activity, and no tool call is cut short for it. A bind holds the file it was made with, and editors save
   by putting a new file in its place, so each entry carries its file's device, inode, modification time and size
   (`stamp`): a file saved anew counts as a change too. The empty file `bwrap` made for a place stays in the session's
   home after the owner stops sharing it.
7. **Where the agent can reach the place.** The session's home is the agent's to write, so a command could put a link
   where a place's directory goes. `bwrap` makes the place and its directories inside the service's own mount namespace,
   whose only writable mounts are the session's own home, worktree and socket directory, so a link there leads nowhere
   the agent couldn't already write; at worst the extension finds its file somewhere else in its own view, or doesn't
   start. An entry whose host file the sandbox refuses (`serviceBindAllowed`) is left out, and the session told once.
   An entry the host's configuration can't be read for keeps what the extension had, and never stops it opening.
5. **Linux only.** macOS's Seatbelt sandbox can allow paths but not put a file at another one, so there the session says
   once that the extension runs without its shared files. Outside the sandbox (Windows, sessions on the host,
   unsandboxed hosts) extensions run as the owner and read the owner's files themselves, so nothing is bound.
6. **Missing files are left out.** A path that isn't a file when the process starts (absent, a directory, unreadable)
   is left out, and the session's notices say so once.

## Where it lives

| Part | Files |
| --- | --- |
| The setting | `packages/shared/src/host-config.ts` (`extensionFiles`, `parseExtensionFiles`, `extensionFilePackage`); `apps/server/src/host-config.ts`; migrations `sqlite/0092_extension_files.sql`, `postgres/0085_extension_files.sql` |
| The binds | `apps/runner/src/extensions/files.ts`, `extensions/process.ts` (`ProcessChannel.bind`, `files`), `session.ts` (`sharedFiles`), `sandbox.ts` (`startService` `files`, `homeFileTarget`) |
| The page | `apps/nsh/src/settings/host-extensions.tsx` (`ShareFileSheet`) |
| Tests | `tests/extension-files.test.ts`, `tests/extension-sandbox.test.ts`, `tests/connectors.test.ts`, `apps/nsh/tests/settings.test.tsx` |
