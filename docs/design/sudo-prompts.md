# sudo's password, asked per use

A session of the host's owner that runs on the host itself, in their private workspace, can run commands as root with
`sudo -A`. sudo then asks the owner for their password in Pikibun, in a password box of its own beside the chat box, and
the call waits for the answer. Nothing keeps the password: it goes to that one `sudo` and nowhere else.

## Why per use, not once

Three ways were weighed (#332's discussion):

1. **The agent gives the commands, the owner runs them in a terminal** (what the install chat did before). The safest,
   and it stays the fallback: the opening message says so, and a declined prompt ends there.
2. **sudo asks the owner each time** (this design).
3. **The owner types the password once, for the session.** Rejected: the session runs as the owner, without the
   sandbox, so whatever holds the password for it (an environment variable, a file, a helper that answers) is within
   the agent's reach, and printing it puts it in the transcript, the server, backups and a share link. Asked per use,
   the agent can still run the helper itself, but each run shows the owner a prompt they can decline.

Keeping the password from the session is therefore not the protection: the agent runs as the owner and could read it
out of any process that holds it. What protects it is that it never rests anywhere, each use is the owner's decision,
and they see the command it is for.

## How it works

- **The helper** (`apps/runner/src/sudo-prompts.ts`). Each such session has a `SudoPrompts`: a Unix socket in a
  private directory under the system's temporary directory (short enough for a socket path), and beside it
  `askpass`, a `/bin/sh` script that runs the connector's own Node.js on `askpass.cjs`. The script holds the socket's path
  and a random token, so only it can ask; a connection without the token is declined. sudo runs it with its prompt as
  the argument, it sends `{ token, prompt }` and prints the password it gets back, or exits 1 when declined.
- **Only through `sudo -A`.** On-host commands get `SUDO_ASKPASS` (`HostWorkspace#spawn`), and the agent's instructions
  say to use `sudo -A`. sudo reads the helper on its own only where there is no terminal and `DISPLAY` is set; setting
  `DISPLAY` would change how GUI programs started from a session behave, so the agent is told instead. Pikibun's own
  Git steps (the isolated environment) don't get it.
- **The prompt in the view.** A waiting prompt is the session view's `sudo` (`{ id, prompt, command, requestedAt,
  expiresAt }`), with the command running at the time (`HostWorkspace.activeCommand`, cut to 400 characters), and makes
  the session's activity `waiting`. That sends the owner a notification, now worded "Waiting for you", and the session
  list says "Needs you". Prompts queue, one shown at a time. One lapses, declined, after five minutes; one whose sudo
  went away (stopped, timed out) is dropped.
- **The time limit stops while it waits.** A command's limit is the host's command time limit; time a prompt waits
  for its answer doesn't count against it (`waitedSince`), so a 30-second limit doesn't end a command whose owner took
  a minute to type.
- **The answer** (`POST /api/sessions/:id/sudo`, `apps/server/src/session-sudo.ts`) is `{ id, password }` or
  `{ id, decline: true }`. Only the session's owner, who must also be its host's owner, answers, and a password only in a
  session of their private workspace; anywhere else they can only decline. The server relays it to the host as the
  runner action `sudo`, with a random `nonce` so the ticket's body hash can't be used to check a guessed password, and
  audits `session.sudo.answered` or `declined` with the prompt's id, never the password. Requests' bodies are never
  logged. The host checks it all again (`Session.sudoAction`): the actor is the host's owner, the prompt is this
  session's, and a password only where the workspace is the owner's private one.
- **Which workspace is private.** The host learns it from the workspace extensions answer it already reads
  (`ownerPrivate`), not from the session's binding, which is immutable and compared on restores and moves. An older
  server sends no `ownerPrivate`, so its hosts offer no `sudo -A`; an older connector ignores it, and its sessions have no
  prompts, as before. A workspace that stops being the private one (it can't) or a host whose answer can't be read
  offers none: the helper and its socket are removed before the next command. A session that is closing offers none
  either, so a command still in flight as it closes doesn't start a helper nobody removes. A failed fetch keeps the last
  answer for the agent's instructions but takes no password until a fetch succeeds.
- **Started when needed.** The helper starts before a command runs (`prepare`), not once: a session restart closes it
  with the session and the next command starts it again, and one that failed to start (a full temporary directory)
  is tried again at the next command, leaving nothing behind.
- **The box** (`apps/nsh/src/components/SudoPrompt.tsx`) sits above the chat box, apart from it, with a masked field.
  Its heading is Pikibun's own; sudo's prompt, which whoever runs the helper chooses, is shown quoted as "sudo's
  prompt", never as the field's label, beside the command and the host. It clears the field as the answer is sent, so the text isn't left
  on screen or in a draft. People who aren't the host's owner see that sudo waits, but no field or button.

## What it doesn't protect against

A prompt the agent triggers on purpose, by running the helper itself, looks like any other; the owner decides from the
command it shows. Text the agent reads can still steer it (see [Sessions on the host](security-rationale.md#sessions-on-the-host)),
and with the owner's password a command runs as root. sudo caches a successful password per its own rules
(`timestamp_timeout`, by terminal or parent process), so a later `sudo` in the same command may not ask again. Windows has
no sudo, and gets none of this.
