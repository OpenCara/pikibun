# Design: the authority's module boundary

> Approvals were removed: nothing in a session waits for a person's approval any more. A call runs, as [What a session may do](../approvals.md) describes, or is refused. What this document says about approval cards, permission requests and Auto-approve describes the design before that.

Status: implemented, as a module boundary inside the server. Running the authority as a service of its own is not
planned; the boundary keeps it possible.

## Why

The server does two kinds of work. It is the **authority**: it knows who people and hosts are, decides what each may
do, records which operations a person approved, holds the credentials that act for session owners, and writes the audit
log. And it **coordinates**: it relays the apps' requests to hosts, shares views among the people watching a session,
runs schedules and messages between sessions, keeps backups and sends notifications.

Hosts already treat the server this way. They ask it before every request and every second of a stream
(`/api/connectors/self/authorize`), for each Git and API credential, and through the brokers for each push, comment
and merge. In the code, though, the two kinds of work were mixed: access checks in `db.ts`, a host's identity in
`connectors.ts`, the relay's permission tables in `runner.ts` and `connector-transport.ts`, and an approval setting
that invalidated the relay's views itself. Drawing the boundary lets the security-relevant code be reviewed as one
piece. It also keeps a later split possible without untangling it first, such as running the authority on its own or
connecting the apps to hosts some other way.

## What it holds

Everything in `apps/server/src/authority`:

| Area | Files |
|---|---|
| Who people are | `auth.ts` (GitHub and session sign-in), `password-auth.ts`, `admin.ts` (the instance's administrators), `invites.ts` (what an invite link's token grants) |
| Who hosts are | `hosts.ts`: a connector's credential and current connection, and whether it still serves a session |
| Who may do what | `access.ts` (membership, roles, each person's access to a session), `host-access.ts` (host admins and host command grants), `runner-access.ts` (what the relay may ask a session's host), `authorize.ts` (the question hosts ask) |
| What a session may run | `tool-groups.ts` and `tool-checks.ts` (the tools of the owner's tool group), `operations.ts`, `run-admissions.ts` (what a message that may act admits), `extension-policy.ts` (which extension tools a workspace's sessions have) |
| Credentials | `vault.ts`, `repositories.ts`, `git/`, `workspace-connections.ts`, `network.ts` and `lfs.ts` (sessions' Git), `api-access.ts`, `push/`, `github-broker.ts`, `pull-request-states.ts`, `sources/` (document sources) |
| The audit log | `audit.ts`, and `changes.ts`, through which the authority says what it changed |

`authority/index.ts` is its whole interface, grouped the same way.

## The rules

`tests/authority-boundary.test.ts` holds four:

1. **From outside, only the interface.** Code in `apps/`, `packages/` and `scripts/` imports the authority only from
   `authority/index.ts`. Tests may import its modules directly.
2. **From inside, only infrastructure.** Authority code imports from the rest of the server only `types.ts` (request
   context and row types), `http.ts` (errors and request helpers), `db.ts` (rows to records, and the session states every
   request checks) and `db/types.ts`. Everything else it needs comes from `packages/shared`.
3. **Loading it loads nothing else.** The authority's runtime imports, followed through those four files, reach none of
   the relay, views or other features.
4. **Only the authority writes the audit log.** Elsewhere, entries go through `auditStatement` or `auditAfterChange`.

When the authority changes what a session's view shows, it says so with `sessionChanged` (`changes.ts`). The view
feeds listen (`view-feed.ts`, `onSessionChange`), so nobody is served a view fetched before the change, and the
authority never reaches into them.

## What moved

- Whole files moved into `authority/` with only their imports changed.
- Parts of files that stay were split out:
  - `db.ts` → `access.ts` and `audit.ts`. `db.ts` keeps the record mappers and the frozen, archived, restoring and moving checks.
  - `connectors.ts` → `hosts.ts`. `connectors.ts` keeps pairing, the manifest and the routes hosts call.
  - `internal.ts` → `authorize.ts`.
  - `runner.ts` and `connector-transport.ts` → `runner-access.ts`. They keep the relay and the tickets it carries.
  - `extensions.ts` → `extension-policy.ts`. `extensions.ts` keeps the hosts' reports, installs and the settings routes.
  - `workspace-invites.ts` → `invites.ts`. `workspace-invites.ts` keeps the links and the queue of requests.
- No behavior changed: no route, query, check or message. The one change in code is that stopping auto-approval of a
  member's requests now invalidates the session's view through `changes.ts` instead of calling `view-feed.ts`.

## Not yet

- **The authority reads tables that aren't its own.** It writes the tables it decides from alone: a fifth rule in
  `tests/authority-boundary.test.ts` lists them (memberships, session grants, host shares, grants and admins, workspace
  extensions, credentials, sign-ins and the rest), and fails if anything outside `authority/` writes one of the listed
  tables. The rest of the server changes the listed tables through statements the authority returns (`memberships.ts`,
  `host-access.ts`, `extension-policy.ts`, `password-auth.ts`), which callers batch with their own writes and audit
  entries, so each change stays one atomic batch. Tables it writes together with the rest of the server
  (`connector_workspaces`, `connector_pairings`, `workspace_join_requests`) aren't on the list. But the authority still reads the rest of the server's tables:
  `sessions` everywhere, and `restore_jobs` and `host_migrations` through `db.ts`. Running it on its own would need an
  interface for each of these.
- **Guards stay SQL.** The fragments it exports (`workspaceAdminSQL`, `sessionCreatorSQL`, `sessionManagerSQL`,
  `managesConnectorSQL`, `personalWorkspaceSQL`) guard other modules' writes to their own tables (`INSERT ... SELECT
  ... WHERE <who may>`), so the check and the write are one statement and a revoked role can't slip between them. A
  function that checked first and returned a boolean would reopen that race, so they stay SQL, named by the authority.
  `workspaceHasSourceSQL` is no longer exported: its only outside user now calls `shareHostStatements`.
- **The routes hosts call are registered together.** `connectors.ts` and `internal.ts` register the authority's routes
  (authorize, credentials, brokers) beside the coordinating ones (activity, schedules, sessions, restores).
- **The relay mints the tickets it carries.** `runner.ts` and `connector-transport.ts` build them, and the authority
  only checks them (`runner-access.ts`). For the apps to reach hosts without the relay, the authority would have to
  issue them, signed with a key the hosts can check.
- **The interface is wide.** It is everything the server used when the boundary was drawn, about 130 names now that
  writes go through it. `repositorySettingsSelect` is still a read that `data-export.ts` embeds.
- **Two permission tables for host requests.** `runner-access.ts` kept both: `requireRunnerAccess`'s and the
  connector ticket's (`connectorPermissions`). They differ only for `restore` (`write` against `manage`), which only the
  session's owner asks for anyway.
