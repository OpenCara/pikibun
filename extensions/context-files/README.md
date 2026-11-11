# Context files, a Pi extension

Adds the files you choose to the system prompt of each message, the way Pi adds a project's `AGENTS.md` or `CLAUDE.md`.
Sessions that don't run Pi's own agent session never load those files. Pikibun's sessions are like that: they run on
pi-durable. This extension loads them again, and lets you choose other files too:

- **Repository files.** `AGENTS.md`, `docs/CONVENTIONS.md`, `.cursor/rules/*.mdc`. Wildcards (`*`, `?`) work in the
  file's name only. `a|b` uses the first of the files that exists, such as `AGENTS.md|CLAUDE.md`, which is the default.
  When the working directory is a repository (Pi run in a project), only that repository is searched. Otherwise each
  repository directly under it is searched, plus the directory itself (a Pikibun worktree holds its clones side by
  side). A path a repository doesn't have is skipped quietly.
- **Host files.** `host:<name>` is a file in the host's context directory. Only the host's owner puts files there. The
  directory is `PI_CONTEXT_FILES_DIR`, or else `context-files` in Pi's agent directory (`~/.pi/agent/context-files`).
  Wildcards work here too: `host:rules/*.md`.
- **Web pages.** `https://…` is fetched from the host at most every five minutes. A page that fails to load again keeps
  its last text.

The prompt section is headed **Project context**. It has one part for each file, labelled with its path
(`app/AGENTS.md`, `host:team.md`, or the URL). A part says what it left out once the files exceed the limit, and lists
entries it couldn't load, such as a missing host file or a page that failed. Files are read again for each message, so
changes take effect from the next one.

A repository cloned during a message, after that message's prompt was built, still gets its files: they are added to
the result of the tool call that made the clone. So the agent sees a new clone's `AGENTS.md` before it works there.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `context-files` | `AGENTS.md\|CLAUDE.md` | The files, separated by commas or new lines; `#` starts a comment. Empty adds nothing |
| `context-max-chars` | `60000` | The most characters of files to add to each message (1,000 to 1,000,000). Files past the limit are cut or left out, and the prompt says so |

For example, to use a repository's own instructions, a team's style guide kept on the host, and a shared page:

```
AGENTS.md|CLAUDE.md, .github/copilot-instructions.md, docs/ai/*.md, host:team.md, https://example.com/agent-rules.md
```

## Safety

Settings come from whoever sets the extension's flags. In Pikibun those are the workspace's owners and admins. The
extension itself runs on the host, as the host's user, outside any sandbox. So it reads only what those settings should
be able to reach:

- Repository paths are relative. They may not contain `..` or `.git` segments. A file that resolves (through links)
  outside its repository, or into a `.git` directory, is refused. So a repository can't link `AGENTS.md` to a file on
  the host, or to `.git/config` with a token in a remote's URL. The file actually opened is checked again, so a link
  swapped in after the first check can't get around this either.
- Only regular files are read, so a FIFO named `AGENTS.md` can't make a message hang.
- Host files come only from the context directory, and a file there that links outside it is refused.
- Only `https://` URLs are fetched, without credentials and with at most three redirects (all `https://`). Pages load
  in parallel, each within 10 seconds. A page that failed is tried again after a minute, or at the next message if
  that message was stopped while it loaded. A URL is
  never fetched from a private, loopback, link-local or reserved network address. This is checked against every
  address its name resolves to, as the connection is made. Pages are fetched directly, not through a proxy from the
  environment. A host whose DNS gives such addresses for public names, such as a fake-IP proxy using `198.18.0.0/15`,
  can let those ranges through with `PI_CONTEXT_FILES_ALLOW_RANGES=198.18.0.0/15` (CIDRs separated by commas). That is
  the host owner's choice, set in the connector's environment.
- No file or page over 1 MB is read.

Whatever these files say reaches the agent as project instructions, just as `AGENTS.md` does in Pi. Name only files
you trust.

## In Pikibun

Every connector has it built in as `piki:context-files`, at the connector's version, so hosts install nothing. Every
workspace has it among its extensions, turned off: its owners and admins turn it on and set its settings under
**Settings → Workspaces →** the workspace **→ Extensions**. See [the design](../../docs/design/piki-extensions.md#the-context-files-pikicontext-files).

A host can also run this directory as a dev extension instead, to try changes in the host owner's own sessions:

```sh
npx pikibun@latest extensions add ./extensions/context-files             # dev mode, from a clone: the host owner's own sessions only
```

## In Pi

```bash
pi install npm:@pikibun/pi-context-files   # from npm
pi install ./extensions/context-files      # from a clone of this repository
pi -e ./extensions/context-files           # or for one run only
```

Its settings are Pi flags, such as `--context-files "docs/ai/*.md, host:team.md"`. Pi loads `AGENTS.md` and `CLAUDE.md`
itself, and this extension doesn't add again a file Pi already loaded. So in Pi, list only the other files you want.
