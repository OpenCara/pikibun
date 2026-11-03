# Running the server

## Docker

```sh
cp apps/server/.env.example .env
# In .env set APP_ORIGIN (the public https:// origin), SESSION_SECRET (openssl rand -base64 48),
# VAULT_KEY (head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=') and ADMIN_USER_IDS=password:admin, then:
docker compose up -d
docker compose exec pikibun node dist/server/main.js --create-admin admin   # asks for its password
```

The image builds the web app and the bundled server and runs them as a non-root user. The server listens on port 8787 and keeps its SQLite database in the `pikibun-data` volume; it stores no session backups unless you set `STORAGE_URL` (see [Database and backup storage](#database-and-backup-storage)). The image sets `WORKSPACE_DATABASES=true`, so workspace owners can keep their sessions' backups in a Postgres database of their own (see [Workspace session databases](#workspace-session-databases)); set `WORKSPACE_DATABASES=false` in `.env` to turn that off. `GET /api/health` reports which providers are configured, and the image's health check uses it. Migrations run automatically at start-up: to upgrade, update the source and run `docker compose up -d --build`.

The image also sets `PASSWORD_AUTH=true` and `SIGNUP=invite`: people sign in with a [username and password](accounts.md#username-and-password), and with GitHub once you add its OAuth app (see [Sign-in and GitHub apps](#sign-in-and-github-apps)), and new accounts, GitHub ones too, come only through a workspace's [invite link](workspaces.md#invite-links-and-pending-members). So a new server's first account is the administrator `--create-admin` makes (see [Administration](#administration)), who signs in, creates a workspace and shares its invite link; or, with a GitHub OAuth app, a GitHub account that `ADMIN_USER_IDS` lists, which can always sign up. Set `PASSWORD_AUTH=false` in `.env` to sign in with GitHub only, and `SIGNUP=open` to let anyone who reaches the server sign up, or `off` to let in only the operator's accounts (see [Who can create an account](accounts.md#who-can-create-an-account)).

> **Upgrading from Pistead:** every name changed, with nothing that reads the old ones. Back up first. A Docker Compose deployment moves its data to the renamed volumes (`pikibun-data`, and `pikibun-postgres` with the `postgres` profile). Run these in its directory; the lines marked *Postgres* only where it runs the `postgres` profile:
>
> ```sh
> # 1. Stop it with the old files, keeping its volumes (no -v).
> docker compose down
> docker compose --profile postgres down                     # Postgres
>
> # 2. Update the source, then .env: the SQLite file is now pikibun.sqlite (an .env from the old .env.example names
> #    pistead.sqlite), and a published image is ghcr.io/opencara/pikibun under PIKIBUN_IMAGE.
> sed -i -e 's#^DATABASE_URL=sqlite:///data/pistead\.sqlite$#DATABASE_URL=sqlite:///data/pikibun.sqlite#' \
>   -e 's#^PISTEAD_IMAGE=ghcr\.io/opencara/pistead#PIKIBUN_IMAGE=ghcr.io/opencara/pikibun#' -e 's#^PISTEAD_IMAGE=#PIKIBUN_IMAGE=#' .env
>
> # 3. Create the new service and its volumes without starting them.
> docker compose create
> docker compose --profile postgres create                   # Postgres
>
> # 4. Copy the data. Volume names carry the Compose project (the directory's name, lowercased, unless
> #    COMPOSE_PROJECT_NAME is set); `volume inspect` stops here if one is missing, since `docker run -v` would create it.
> P=${COMPOSE_PROJECT_NAME:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}
> docker volume inspect "${P}_pistead-data" "${P}_pikibun-data" >/dev/null && \
>   docker run --rm -v "${P}_pistead-data:/from:ro" -v "${P}_pikibun-data:/to" alpine sh -c \
>   'cp -a /from/. /to/ && cd /to && for f in pistead.sqlite*; do [ -e "$f" ] && mv "$f" "pikibun${f#pistead}"; done; ls -la /to'
> # The Postgres cluster keeps its pistead role and database, so DATABASE_URL stays as it is.
> docker volume inspect "${P}_pistead-postgres" "${P}_pikibun-postgres" >/dev/null && docker run --rm -v "${P}_pistead-postgres:/from:ro" -v "${P}_pikibun-postgres:/to" alpine cp -a /from/. /to/   # Postgres
>
> # 5. Start it, check its workspaces and sessions, and only then remove the old volumes.
> docker compose up -d
> docker compose --profile postgres up -d                    # Postgres
> docker volume rm "${P}_pistead-data"
> docker volume rm "${P}_pistead-postgres"                   # Postgres
> ```
>
> Hosts pair again with `npx pikibun@latest connect`, since the connector keeps its state in `~/.local/share/pikibun/connector`. Sessions whose branch was named before the rename (`pistead/…`) no longer run: start new ones. A connected workspace database starts with empty `pikibun_*` tables, and its `pistead_*` tables stay where they are. A Postgres control plane renames its `pistead_raise()` trigger function to `pikibun_raise()` when it starts.

> **Upgrading to server 0.18.0:** the image now sets `PASSWORD_AUTH=true` and `SIGNUP=invite`. Unless `.env` sets them, the sign-in page offers a username and password, and new accounts, GitHub ones too, need a workspace's invite link (or, with GitHub, a place in `ADMIN_USER_IDS`); existing accounts sign in as before. To keep the previous behavior, set `PASSWORD_AUTH=false` and `SIGNUP=open` in `.env`. An `.env` copied from 0.17.0's `.env.example` already sets both, to empty values that mean unset, so it keeps the previous behavior: remove those two lines to take the image's defaults.

> **Upgrading to server 0.16.0:** its first start rebuilds the `users` table of a SQLite database (to allow password accounts), keeping every row and checking every reference to it before committing; back up the `pikibun-data` volume first, as before any upgrade. Postgres changes the table in place. Nothing else changes until you set `PASSWORD_AUTH` or `SIGNUP`: unset, sign-in and GitHub sign-up work as before.

Each server release (`server-v*` tag) is published as `ghcr.io/opencara/pikibun` (`latest`, `X.Y` and `X.Y.Z`, for linux/amd64 and linux/arm64); to use it instead of building, set `PIKIBUN_IMAGE=ghcr.io/opencara/pikibun:latest` in `.env` and start it with `docker compose up -d --no-build`. A release can also deploy itself to your server (see [Releasing](development.md), `deploy-server.yml`).

Put a reverse proxy with TLS in front of it (Caddy, nginx, Traefik, a cloud load balancer); the app serves plain HTTP. If the proxy sets `X-Forwarded-Proto`/`X-Forwarded-Host`, set `TRUST_PROXY=true`. The proxy must pass WebSocket upgrades on `/api/connectors/socket`, accept request bodies of 32 MiB for dump imports, and route `/.well-known/` to Pikibun if you use `OIDC_SIGNING_KEY`. The server gzips its responses and session event streams itself, and compresses the connector WebSocket for connectors that offer it, so the proxy needs no compression of its own.

## Sign-in and GitHub apps

- **GitHub sign-in** needs a GitHub OAuth app whose callback URL is `<APP_ORIGIN>/api/auth/github/callback`; put its id and secret in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The same app resets session owners' GitHub tokens after pushes that used them. github.com repositories need it: only accounts that sign in with GitHub can read them.
- **Username and password sign-in** is on with `PASSWORD_AUTH=true`, as in the Docker image (see [Username and password](accounts.md#username-and-password)), next to GitHub or instead of it. Create the first administrator with `--create-admin` (see [Administration](#administration)). With neither, the sign-in page says GitHub sign-in isn't configured.
- **Who can create an account** is `SIGNUP`'s choice (see [Who can create an account](accounts.md#who-can-create-an-account)). Unset, anyone with a GitHub account can sign up, as before; on a server the internet can reach, `SIGNUP=invite`, the Docker image's default, limits new accounts to people holding a workspace's invite link.
- **github.com pushes** can use an operator GitHub App with Repository contents read & write: set `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_PRIVATE_KEY`. Without it, each workspace adds its own GitHub App under **Push access**. Either app also gives hosts read-only tokens for single repositories, so that sessions' clones of private repositories don't go through the server.
- **Azure DevOps and Forgejo push identities** trust Pikibun as an OIDC issuer at `APP_ORIGIN` (`/.well-known/openid-configuration`, `/.well-known/jwks.json`): set `OIDC_SIGNING_KEY` to an RSA key (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072`).

## Configuration

Settings are environment variables, read once at start-up; secrets are never logged. [`apps/server/.env.example`](../apps/server/.env.example) documents each one.

| Variable | Default | Purpose |
|---|---|---|
| `APP_ORIGIN` | required | Public origin of the server (scheme and host, no path); HTTPS outside local test mode and `LOCAL_MODE` |
| `SESSION_SECRET` | required | Random string of at least 32 characters |
| `VAULT_KEY` | required | Base64url 32-byte key that encrypts stored tokens and secrets; keep it stable, since secrets stored with one key can't be read with another |
| `HOST`, `PORT` | `0.0.0.0` (`127.0.0.1` with `LOCAL_MODE`), `8787` | Listening address |
| `TRUST_PROXY` | `false` | Honor `X-Forwarded-Proto`/`X-Forwarded-Host` from a trusted proxy |
| `STATIC_DIR` | `dist/web` | Built web app |
| `DATABASE_URL` | `sqlite:///data/pikibun.sqlite` | Control-plane database |
| `DATABASE_WAIT_SECONDS` | `60` | How long start-up retries an unreachable database |
| `STORAGE_URL` | none | Session backup storage; none means no backups |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | AWS SDK chain | S3 credentials; the `AWS_*` names also work |
| `WORKSPACE_DATABASES` | `false` (`true` in the Docker image) | Let workspace owners connect a Postgres database |
| `WORKSPACE_DATABASE_PRIVATE_HOSTS` | `false` | Also allow workspace databases on private networks |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | GitHub OAuth app for sign-in |
| `GOOGLE_CLIENT_ID`/`_SECRET`, `NOTION_CLIENT_ID`/`_SECRET`, `DROPBOX_CLIENT_ID`/`_SECRET`, `MICROSOFT_CLIENT_ID`/`_SECRET` (and `MICROSOFT_TENANT`), `TENCENT_DOCS_CLIENT_ID`/`_SECRET` | none | OAuth apps that let members connect [document sources](repositories.md#document-sources) by signing in |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | none | Operator GitHub App for github.com pushes (PEM as one line with `\n` escapes) |
| `OIDC_SIGNING_KEY` | none | RSA private key (PKCS#8 PEM) for Pikibun's OIDC issuer |
| `GIT_DIRECT` | `on` | Where sessions' Git data goes (see [Network access](hosts.md#network-access)): `on` lets hosts fetch from Git hosts themselves with credentials limited to a repository, `own-hosts` gives credentials only to session owners' own hosts, `off` relays every Git request through the server |
| `SANDBOX_GITHUB_API` | `on` | Whether sessions' `gh` and other GitHub API clients read the workspace's github.com repositories (see [Network access](hosts.md#network-access)): `on` gives every host running a session a read-only GitHub App token for them, which its egress proxy adds, `own-hosts` only session owners' own hosts, `off` none. It applies to gitlab.com and dev.azure.com too, whose credentials (the session owner's own access tokens) only owners' own hosts ever get |
| `WEB_PUSH_CONTACT`, `EXPO_ACCESS_TOKEN` | none | [Notifications](notifications.md#for-operators): the contact push services are given with Web Push (the server's `https://` origin by default), and an Expo access token where the app's Expo project requires one |
| `ADMIN_USER_IDS` | none | Comma-separated user IDs of the server's administrators (see [Administration](#administration)) |
| `RUNNER_URL`, `RUNNER_EVENT_TRANSPORT`, `RUNNER_SHARED_SECRET` | none | Legacy operator-managed runner, for development only; leave empty |
| `TEST_AUTH_ENABLED`, `TEST_AUTH_SECRET`, `TEST_AUTH_EXPIRES_AT` | off | Local test mode, for development only |
| `PASSWORD_AUTH` | off (`true` in the Docker image) | `true` offers sign-in with a username and password (see [Username and password](accounts.md#username-and-password)); not with `LOCAL_MODE` |
| `SIGNUP` | GitHub `open`, passwords `invite` (`invite` in the Docker image) | Who can create an account, with GitHub and with a password: `open` (anyone who reaches the server), `invite` (only through a workspace's invite link) or `off` (only the operator's: `ADMIN_USER_IDS` and `--create-admin`); see [Who can create an account](accounts.md#who-can-create-an-account). Not for `LOCAL_MODE`, which admits only its owner |
| `LOCAL_MODE`, `LOCAL_CLAIM_SECRET` | off | A server for one person on their own computer, as `pikibun serve` runs it: plain HTTP on loopback only, and only the GitHub account that signs in through `/api/auth/local/claim?token=LOCAL_CLAIM_SECRET` first (a base64url 32-byte value) can sign in |

## Administration

The server's administrators see every account, workspace and host under **Settings → Administration** and can suspend accounts. List their user IDs in `ADMIN_USER_IDS`, separated by commas (`ADMIN_USER_IDS=github:12345,github:67890,password:alice`); each person finds theirs under **Settings → Profile**. A GitHub user ID is `github:` and the numeric ID GitHub gives the account, which `https://api.github.com/users/<login>` shows as `id` before anyone signs in. A password account's is `password:` and its username. Nobody can sign up in the app as an account `ADMIN_USER_IDS` lists, so listing one reserves the name; the operator creates it from the server's command line instead, with the password typed at a hidden prompt (or piped in on the first line of standard input, never as an argument):

```sh
# ADMIN_USER_IDS=password:admin and PASSWORD_AUTH=true (the Docker image sets it), in the server's environment
node dist/server/main.js --create-admin admin
docker compose exec pikibun node dist/server/main.js --create-admin admin   # under Docker
```

That needs no sign-in first and no restart afterwards, and a fresh server with `SIGNUP=invite` (as the Docker image has it) or `off` starts this way (or with a GitHub administrator, who can always sign up): the administrator signs in, creates a workspace and shares its invite link. `--reset-password USERNAME` sets a new password for any password account the same way, clears its failed sign-ins and signs it out everywhere. Both are recorded in the audit table, with no actor. The role comes only from this setting: nobody can grant it in the app, and it gives no access inside workspaces or sessions.

- **Overview** counts accounts, workspaces, hosts (and how many are online) and sessions.
- **Accounts**, **Workspaces** and **Hosts** list each one with its owner and how many members, repositories, hosts and sessions it has. They never show session titles, prompts, repository names, models, environment values or credentials.
- **Suspend**, in an account's menu, signs the account out of every browser and app and refuses its sign-ins, disconnects its hosts and keeps them from reconnecting, and closes the sessions it owns to everyone, as when someone leaves a workspace. Sessions other members run on its hosts stop too. Nothing is deleted: **Unsuspend** restores the account, its hosts can reconnect and its sessions open again. Administrators can't be suspended; remove them from `ADMIN_USER_IDS` and restart the server first.

Each suspension and unsuspension is recorded in the server's audit table with the administrator who made it.

## Database and backup storage

Every provider is chosen by a URL:

| Setting | Default | Alternatives |
|---|---|---|
| `DATABASE_URL` | `sqlite:///data/pikibun.sqlite` | `postgres://user:password@host:5432/db` (TLS via `?sslmode=require`; `docker compose --profile postgres up -d` starts one) |
| `STORAGE_URL` (session backups) | none: backups are off | `file:///data/backups` (a directory on the server; under Docker, the `pikibun-data` volume), or `s3://bucket/prefix?endpoint=https://minio.example.com&region=us-east-1` with `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (or the `AWS_*` names); omit `endpoint` for AWS |

Migrations run automatically at start-up on whichever database is configured; `pnpm db:migrate` (or `node dist/server/main.js --migrate-only`) applies them without starting the server. Switching providers later means starting with an empty database: there is no data migration between SQLite and Postgres.

Without `STORAGE_URL` the server keeps no session backups, and session owners can't create any, except in workspaces whose owner connected a database of their own. A backup holds a session's conversation, its files and its owner's personal environment values, so whoever can read the backup store can read those sessions. A server that saved backups before `STORAGE_URL` became optional kept them in `/data/backups`: set `STORAGE_URL=file:///data/backups` to download and restore them again.

## Workspace session databases

With `WORKSPACE_DATABASES=true`, a workspace owner can connect a Postgres database of their own under **Settings → Workspaces → Session database → Connect database**. Session backups of that workspace are then saved there instead of in `STORAGE_URL`, and downloads and restores read them back from it:

- Pikibun creates `pikibun_workspaces`, `pikibun_sessions` (each session's record in a `record` JSONB column), `pikibun_session_backups` (the exact backup bytes; `convert_from(snapshot, 'UTF8')::jsonb` reads one) and `pikibun_audit` (activity) when they are missing, in the first schema of the user's `search_path`. Tables created beforehand are used as they are, so the connecting user needs only `SELECT`, `INSERT` and `UPDATE` on them; they need the columns defined in [`apps/server/src/workspace-databases/postgres.ts`](../apps/server/src/workspace-databases/postgres.ts).
- The control plane keeps each backup's SHA-256 and size, so a snapshot changed in that database is refused on download and restore.
- Only the owner connects, replaces or disconnects it; the password is vault-encrypted and write-only. Whoever can read that database can read the sessions saved there, including their owners' personal environment values, so other members confirm the database before each of their backups is saved there. Pointing the connection at another database asks them again; new credentials for the same one don't. A database is named by its host, port and database name: where that host name resolves is up to whoever controls it, normally the owner.
- Connections use TLS that verifies the server certificate (against the public roots, or a CA certificate the owner pastes), or TLS without verification if the owner chooses it. Hosts must resolve to public addresses; `WORKSPACE_DATABASE_PRIVATE_HOSTS=true` also allows private networks, and unencrypted connections to them.
- If the operator turns the feature off, that workspace's backups stop (they never fall back to `STORAGE_URL`) until its owner disconnects the database.

### Automatic backups

The owner can also have sessions backed up into the database on their own, under **Session database → Automatic backups**: every 15 minutes, hour, 6 hours or day at most (`PUT /api/workspaces/:id/database/automatic-backups` with `minutes` of `15`, `60`, `360`, `1440` or `null`). Replacing the connection keeps the schedule; disconnecting the database ends it.

- A session is backed up when it changed since its last automatic backup (its host reported its agent working), it is idle, and the interval since the last attempt has passed. The server checks every minute and takes at most 10 backups each time, oldest change first. A failed attempt is retried 15 minutes later, and the session's **Details → Backups** shows why it failed.
- Automatic backups go only into the workspace database, never into `STORAGE_URL` instead, and are marked **Automatic** in the backup list and as `automatic: true` in the `backup.created` activity.
- The workspace owner's own sessions take part as soon as the schedule is on. Another member's sessions take part only once that member confirms the database under **Session database → Your sessions** (`PUT /api/workspaces/:id/database/consent` with the `databaseId` they were shown; `DELETE` withdraws it). That confirmation also stops manual backups asking each time. It names the database, so it lapses when the owner points the connection at another one or disconnects it, and when the member leaves the workspace.
- Nothing deletes old automatic backups yet: the database keeps every one, so choose an interval the database has room for.

## Dumps and imports

Operators can dump straight from the database, with every session of a workspace in full:

```sh
node dist/server/main.js --dump-workspace WORKSPACE_ID > workspace.json
node dist/server/main.js --dump-session SESSION_ID > session.json
docker compose exec -T pikibun node dist/server/main.js --dump-workspace WORKSPACE_ID > workspace.json
pnpm -s db:dump --dump-workspace WORKSPACE_ID > workspace.json   # from source
```

Like start-up, a dump applies pending migrations first.

A workspace's owner can import a session or workspace export of that workspace into its session database under **Settings → Workspaces → Session database → Import dump** (up to 32 MiB), or with `POST /api/workspaces/:id/database/import`. This keeps the history of sessions saved before the database was connected, and adds what backups don't carry:

- `pikibun_sessions.data`: each fully exported session's grants, approvals, pushes, backup list and restores; `pikibun_workspaces.data`: the workspace's members, models, agents, repositories, push access and database connection; `pikibun_audit`: every activity entry.
- A session's record and details replace older ones only (by export or save time), and activity entries are added once, so importing a dump again, or an older one, changes nothing. Each import is one transaction.
- The dump must be of that workspace; it is checked before anything is written. Only the workspace database changes; the workspace's activity records the import.

Operators import dumps of up to 256 MiB from the command line, with the server's settings (`WORKSPACE_DATABASES`, `WORKSPACE_DATABASE_PRIVATE_HOSTS` and the `VAULT_KEY` that reads the database password). The dump names its workspace, which needs a connected database:

```sh
node dist/server/main.js --import-dump workspace.json
docker compose exec -T pikibun node dist/server/main.js --import-dump - < workspace.json
pnpm -s db:import workspace.json   # from source
```

An operator's dump holds every session of the workspace, other members' private ones included: importing it gives whoever can read the workspace database their records and activity.
