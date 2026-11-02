# End-to-end encryption of session conversations (evaluation)

Status: evaluation, nothing implemented. Question: can Pikibun encrypt chat so that the server never saves (or never
sees) a plain chat message?

## Short answer

Two different goals, with very different costs:

| Goal | What it protects against | Cost |
|---|---|---|
| **A. The server never *stores* plaintext chat** | Database, S3/filesystem and backup leaks; old dumps | Small: two durable places hold chat today (below) |
| **B. The server never *sees* plaintext chat** (true end-to-end: apps ⇄ host) | Also a curious operator, server memory and log leaks | Large: moves redaction, brief output and paging to the host, adds device keys and key distribution |

Both are feasible because the architecture already does most of the work: a session's conversation lives on its host
(Pi's database), and the server is a relay with a short-lived in-memory cache (`view-feed.ts`: views idle for 60 s are
dropped, at most 256 feeds). The ends of an end-to-end design are therefore **the apps** and **the host**, not two
users: the host must read every message anyway, because the agent runs there.

Some limits hold whatever we build. These things stay readable by the server, or outside what Pikibun's encryption can protect:

- **The model provider** gets every prompt in plaintext from the host. End-to-end encryption doesn't change that.
- **Operations the server performs itself** must stay readable to it: GitHub comments, issue titles and bodies, merges
  (`github-broker.ts` posts them with the owner's token), push details, `web_search` queries (sent to the provider and
  audited in `audit.detail_json`), document source reads, and relayed Git data. Their approval records
  (`approval_reviews.operation_json`) are checked by the server against the exact operation.
- **Metadata** stays visible: who sent what, and when, sizes, session status, models and probably titles.
- **An actively malicious server** can't be stopped fully. The web app, and the Mac app's remote window, run JavaScript
  the server serves, so a malicious server could serve code that exfiltrates keys. The server is also the authority on
  membership and grants, so it can tell a host to trust a device key it controls. The native iPhone and iPad app with
  bundled code, plus device-key verification, is the only end where this holds.

So goal B mostly guards against a *passive* operator and against leaks; it doesn't protect against a hostile operator who
uses the web app.

## Where plaintext chat is today

Durable, so goal A must fix these:

1. **Backups**: `backups.ts` writes the host's snapshot (the whole conversation, files and the owner's personal environment
   values) as plain JSON to `STORAGE_URL` (`sessions/<owner>/<session>/<backup>.json`) or to the workspace session
   database. Automatic backups do the same. This is by far the biggest store of chat on the server side.
2. **Scheduled prompts**: `session_schedules.content` (up to 60,000 characters) and its derived `name`, in plaintext.
3. **Session titles**: `sessions.title`, set by people or the agent, often a paraphrase of the task.
4. **Approval operations**: `approval_reviews.operation_json` holds shell commands, file paths and GitHub comment and
   issue bodies the agent wrote. These aren't chat, but they often quote it.
5. **Audit details**: `web.search` stores the query. Message submissions store only ids, options and image counts, not text.

Not stored: `run_admissions` keeps only `content_hash` (a hash of text and images), and `session_messages` (between
sessions) keeps ids and status, not text. Exports exclude conversations.

In memory or in transit only, which goal B must fix:

- Message submission (`submitMessage` in `sessions.ts`): text and images go to the host through the server, which hashes
  them for the run admission.
- Transcript views (`view-feed.ts`): the server receives raw views and keeps `raw`, `full` and `shown` snapshots in
  memory. It **redacts secrets** (`redaction.ts`), applies **brief tool output**, **pages** entries and computes **view
  patches** for each viewer.
- Share links (`session-links.ts`), the session file browser (`session-files.ts`, redacted on the server), side asks,
  cross-session messages, and their notifications (which the server writes itself).

## Goal A: the server never stores plaintext chat

1. **Encrypted backups.** The host encrypts the snapshot before upload: XChaCha20-Poly1305 with a random key, wrapped
   (X25519 sealed box) to:
   - the owner's **backup public key**, and
   - optionally, a recovery key the owner prints once.

   Automatic backups keep working, because the host needs only the public key. Restoring and moving sessions need the
   owner's app: it unwraps the key and wraps it again to the target host's public key, which the server relays. The
   server keeps its `sha256` over the ciphertext. Downloading a backup gives the ciphertext, and the app decrypts it.
2. **Scheduled prompts.** The app encrypts `content` to the session host's public key. The server stores the
   ciphertext and passes it to the host when the schedule fires, and the host decrypts it. `name` becomes a label
   the person chooses, not the first line of the prompt, or it's encrypted too.
3. **Titles (optional).** Encrypt to a per-user key in the apps, or document that titles are plaintext metadata.
4. **Logging hygiene.** Add a test that no route logs a request body, and keep audit details free of message text.

A cheaper interim step is server-side encryption at rest with the existing vault key (`vault.ts`), for backups and
schedule content. It protects against leaked buckets and database dumps, but not against the operator. It's worth
doing first because it's a few days' work.

## Goal B: apps ⇄ host end-to-end

**Keys**
- **Host key**: an X25519 key pair made at pairing. Its public key is registered with the server, and its fingerprint is
  shown in the pairing command's output and under **Settings → Hosts**.
- **Device keys**: each app install has an X25519 key pair (a non-extractable WebCrypto key in IndexedDB on the web,
  the Keychain on iOS and macOS). Devices are signed by the user's **identity key** (cross-signing, as in Matrix), so a
  new device must be approved from an existing one or with the recovery key.
- **Session content key**: made by the host for each session, in epochs. The host wraps it to every authorized device.
  The authorized list comes from the server (owner, grants, workspace visibility, admins). To limit the server's power to
  add devices, the host trusts only device keys signed by the user's identity key, pinned on first use, and shows a
  warning when it changes.

**Data flow**
- Messages and side asks: the app encrypts `{content, images}` to the host key. The server forwards the ciphertext.
  The run admission's `content_hash` is computed over the ciphertext, which keeps the provenance binding.
- Transcript: the host redacts, makes the brief version and pages *itself* (`redaction.ts` and `transcript-display.ts`
  are already in `packages/shared`), then encrypts each entry with the session content key. Associated data is
  `session id ‖ entry id ‖ revision`, so the server can't reorder or swap entries. The server's shared feed and
  `view-patch` keep working on opaque entries keyed by id and revision.
- Approval cards: shell commands can be encrypted too, with the review hash over the ciphertext. Server-executed
  operations (GitHub, pushes, web search) stay plaintext; see the limits above.
- Share links: the link carries a read key for the session (or for the link) in the URL fragment, which already holds
  the token and never reaches the server. Replacing or turning off the link starts a new key epoch.
- Revocation: removing a grant, making a session private or removing a member starts a new epoch. Like the README's
  "can't recall what was already seen", old entries stay readable to people who already had them.
- Cross-session messages: host A encrypts to host B's public key. The server's own notification text (status only)
  stays plaintext.
- File browser: host-side redaction, then encrypt to the requesting device.

**What changes for people**
- Losing every device and the recovery key loses access to backups. Live sessions stay readable by re-adding a device,
  because the host holds the plaintext.
- Admins who "manage every session" need wrapped keys too. That's fine, but it should be visible.
- Server-side search or analysis of transcripts becomes impossible. Pikibun has none today, so nothing is lost.
- Older connectors and apps can't take part. Make it a per-workspace setting that needs connector and app capabilities.

## Recommendation and effort

1. **Now (about a week):** encrypt backups and scheduled-prompt content at rest with the vault key, and add a test that
   payloads are never logged. This removes plaintext chat from the database and storage for leaks.
2. **Next (2–3 weeks):** host-key encryption of backups and scheduled prompts (goal A against the operator too), with the
   owner's backup key and a recovery key.
3. **Later, only if needed (6–10 weeks):** goal B. That means device keys and cross-signing, host-side redaction,
   brief output and paging, encrypted feed entries, share-link fragment keys, epochs, and UI to verify devices. Treat
   it as protection against leaks and passive operators, not hostile ones, unless the web app's code delivery is
   pinned too (bundled desktop or mobile apps only).

Use libsodium (`libsodium-wrappers` / `sodium-native`) or WebCrypto X25519 and AES-GCM. Don't use custom primitives.
A full Signal or MLS ratchet isn't needed: the host is always online and holds the plaintext, so forward secrecy against
the host gains nothing, and the epoch keys above give forward secrecy across revocations.
