# Artifacts

Status: implemented (#401). The user's view is in [Sessions → Artifacts](../sessions.md#artifacts); this note says why it
is built the way it is. It follows Pine v2's `pine.artifacts` (`v2/docs/artifacts.md` in `igaryhe/pine`), kept smaller
and fitted to Pikibun's host, Pikibun server and client.

## The tool

`publish_artifact { name, kind, content, title? }` (`apps/runner/src/session/tools/artifacts.ts`) is one of the
session's own tools, switched by `piki:artifacts` like the other Pikibun tools, so it is off until a workspace adds it
and runs under the session's rules: it needs a shared message that may act (`calls.actor(api, true)`,
`calls.check(..., { write: true })`), so a side ask or a **Read only** message can't publish. It isn't one of the tool
groups' tools: it writes nothing in the worktree and reaches nothing outside the session, and a new group tool would be
dropped by apps from before it whenever they save a group. Whoever may send a message that acts may have the agent
publish.

- `name` is `^[a-z0-9][a-z0-9_-]{0,63}$`, `kind` one of `html`, `svg`, `markdown`, `text`, `content` at most 1 MiB of
  UTF-8 and the title at most 120 characters on one line (the name where there is none).
- Its answer's first line is `Published artifact <name> version <n> (<kind>).`, the title on the second. The client
  draws the transcript card from that text alone (`artifactResult`, `publishedArtifact`): the Pikibun server redacts
  tool results and a share link keeps only an entry's text, and brief tool output keeps the first line, so the card
  is the same everywhere the result is.
- `replay: "safe"` with the call's task ID stored on the version: a call run again after a crash gets the version it
  wrote, never a second one.

## Where the versions live

In the session's own pi-durable store (`session.sqlite`), as two session documents (`apps/runner/src/session/artifacts.ts`):
`workspace.artifacts`, the index (each name's versions: kind, title, size, time, call), and `workspace.artifact`, a
family with one document per version (`<name>@<version>`) holding its content. The tool writes both in one commit
(`api.commit`), and the limits are checked inside it, so a refused version writes nothing.

- Not the worktree: deleting files, cloning again or packing don't touch them, and the agent can't change a version.
- The store is what a backup, a conversation-only backup, a move to another host and attaching a portable session to
  another server already carry, so artifacts go with them with nothing added. A fork copies entries, not documents,
  so it starts without them. Going back to an earlier message leaves session documents as they are.
- Pine keeps them in a file store beside its host's store. Pikibun hosts have nothing like it that backups carry, and
  a backup is one JSON document of at most 24 MiB, so a session keeps at most 16 MiB of artifacts (and 256 names, 256
  versions each), which leaves room for the rest of it.
- Nothing is ever removed; a version's number is the count of the name's versions before it plus one, and none is
  deleted, so numbers are never reused.

## Reading them

A new runner action, `artifacts` (permission `read`), answers `{}` with the list and `{ name, version }` with one
version. The Pikibun server serves it as `GET /api/sessions/:id/artifacts[?name=&version=]` to whoever may read the
session, and as `GET /api/shared/artifacts` to a share link, read as the session's owner as the link's view is, the
link checked again after the host answers. Both check the host's answer (`checkArtifactList`, `checkArtifact`: the
version asked for and no other), redact titles and content as the transcript is redacted, and say `redacted` when
they changed something. Like `view`, the action is allowed on archived, packed and frozen sessions and during a move:
it only reads the store. A host whose connector predates it doesn't advertise `artifacts`, and the server answers
`409 artifacts_unsupported` without asking it.

The client caches versions it read (they never change) but reads the list again as the transcript moves.

## Showing them

HTML and SVG run in Native Shell's `WebView`, given the page as `html` (`artifactFrame` in
`packages/shared/src/artifacts.ts`), `incognito`, with no `onMessage`. See
[Security rationale → Artifacts](security-rationale.md#artifacts) for the frame's policy. An SVG becomes an `<img>` of
a `data:` URL inside that page, so its scripts never run. Markdown goes through the transcript's `TextView` with HTML
read as text (`options.html: false`) and images other than `data:` drawn as their alt text, so it loads nothing.
Text is a code view. Where the platform has no web engine, HTML and SVG show their source.

## Left out

As in Pine's first version: people editing or deleting artifacts, the agent reading or patching one, public links,
libraries or network for HTML, frames sized to their content, and a sub-agent's artifacts in its parent.
