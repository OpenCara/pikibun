# Personal connections

A member signs in to a service once, in their profile, and brings that sign-in to the workspaces they choose, instead
of signing in again in each workspace or having one person's account shared by everyone. This document covers remote
MCP servers, the first kind of service that works this way. Git accounts (`git_credentials`, the GitHub sign-in) and
document accounts (`source_accounts`) were already per member: a session reads with its owner's own account. They stay
as they are and are listed in the same place, **Settings → Profile → Connected accounts**.

## The model

A **connection** is a sign-in owned by one member, for one exact target, by one method:

- **Owner**: the member. A workspace's own sign-in (a server's headers, or the OAuth sign-in an owner or admin made,
  [extension-planes.md](extension-planes.md), "Remote MCP OAuth") is unchanged and is still the workspace's.
- **Target**: the server's `https://` address, exactly as a workspace's server has it (`remoteMcpUrl`). A connection's
  secret is only ever sent there. A member has one connection per address (`UNIQUE (user_id, url)`), at most 32.
- **Method**: any sign-in a workspace's server takes: OAuth (the same MCP authorization client as a workspace's sign-in:
  protected resource metadata, authorization server metadata, the client ID metadata document or dynamic client
  registration, PKCE), a token (`Authorization: Bearer`), a username and password (`Authorization: Basic`), a custom
  header, or none. All but OAuth are headers built on the client (`remoteMcpSignInHeaders`), so the server stores and
  sends headers without knowing the method, as it does for a workspace's server.

`mcp_connections` keeps the connection (`headers_ciphertext`, VAULT_KEY context `mcp-connection:<id>`;
`oauth_ciphertext`, context `mcp-connection-oauth:<id>`), never shown, audited or sent anywhere but its address.
Saving headers that hold an `Authorization` drops the OAuth sign-in, which would otherwise replace it, as for a
workspace's server. The address can't change: a member removes the connection and adds another, so no secret ever
follows a connection to a new address.

## Bringing a connection to a workspace

A connection serves no workspace until its member brings it there (`PUT /api/mcp-connections/:id/workspaces/:workspace`,
kept in `mcp_connection_workspaces`). Bringing it needs the member to belong to the workspace and the workspace to have a
server at the connection's address (`mcp_server_not_in_workspace` otherwise); `DELETE` withdraws it. Both are audited in
the workspace (`workspace.mcp.connection_brought`, `workspace.mcp.connection_withdrawn`). It is an explicit choice, not
automatic, because a personal account often spends the member's own money (generation credits, say), and because a
workspace's owners could otherwise add a server at an address they choose and have every member's connection to it
used there.

A brought connection serves only while its member is still a member of the workspace: the lookup
(`broughtConnection`) joins `workspace_members`, so leaving a workspace stops it at once without deleting anything.
Deleting the connection deletes every place it was brought to; deleting a workspace's server leaves the connection.

## Whose sign-in a server calls with

Each workspace server has `sign_in_as`, which its owners and admins set:

- `workspace` (the default, and what every existing server keeps): the workspace's own sign-in, as before. Members'
  connections count for nothing here.
- `members`: the requester's own connection, brought to this workspace. Without one, the call is refused
  (`mcp_connection_required`, nothing sent), never made with the workspace's sign-in or anyone else's.
- `members-then-workspace`: the requester's own connection where they brought one, else the workspace's sign-in.

**The requester's**, not the session owner's: the account used is that of the person whose message made the call
(`actorId`, the same person the run admission and tool grants are checked for). So a collaborator sending a message in
someone else's session spends their own account, never the owner's, and nobody needs to grant anyone their account.
Scheduled runs act as the owner, so they use the owner's. Every call's audit (`workspace.mcp.called`) names the
connection it used, so owners and admins still see what ran with whose account even though they don't manage it.

## Sharing a connection with a whole workspace

Bringing a connection serves only its member's own requests. A member can also **share** a connection with a whole
workspace, so that every member's requests there call the server with that one account, as a workspace's own sign-in
would, without anyone typing its secret into the workspace. It is managed in **Settings → MCP sharing**, which lists
each of the member's connections with the workspaces they could share it with and a switch for each.

- **Who**: only an owner or admin of the workspace shares with it (`PUT /api/mcp-connections/:id/shares/:workspace`,
  `forbidden` otherwise), since sharing adds a server, and so tools, to every session there, which only they do
  otherwise. The page lists only the workspaces the member owns or administers (`McpConnection.shares`), plus any
  they shared with before and no longer administer, so they can still withdraw it.
- **What**: sharing adds a server to the workspace (`workspace_mcp_servers.shared_connection_id`, unique per workspace
  and connection) with the connection's name and address, a prefix made from its name (`remoteMcpSharedPrefix`), no
  headers or OAuth sign-in of its own, `sign_in_as = 'workspace'`, and its tools listed with the connection. It counts
  toward the workspace's 8 servers, and a workspace that already has a server at the address can't take it
  (`mcp_server_at_address`): members bring their own connections to that one instead.
- **Its sign-in stays the member's**: the connection's secret is never copied into the workspace. A call
  (`chooseCredentials`) decrypts the connection's own headers or OAuth sign-in, and only while the member who shared it
  still belongs to the workspace (`sharedConnection` joins `workspace_members`); once they leave, its tools aren't
  offered (`workspaceRemoteTools`) and a call is refused (`mcp_share_ended`, nothing sent). Every call's audit names
  the connection.
- **What the workspace's owners and admins still do**: rename it, turn it off, mark its read-only tools, list its
  tools again (with the shared connection) and remove it. They can't change its address, headers, OAuth sign-in or
  `signInAs` (`mcp_server_shared`), since any of those would send the member's account somewhere else or replace it.
- **Ending it**: the member withdraws it from the page (`DELETE …/shares/:workspace`, whatever their role there now),
  removes the connection (the server goes with it, `ON DELETE CASCADE`), or leaves the workspace. An owner or admin
  removing the server ends it too. Checking the connection (changing its sign-in, signing in, **Check again**) lists
  the tools again for every workspace it is shared with, or notes the error there.

Both are audited in the workspace (`workspace.mcp.connection_shared`, `workspace.mcp.connection_unshared`). Sharing
asks the member to confirm, because what members do with the server is done as them and may spend what their account
pays for.

## The tool list

A workspace offers one list of tools per server (`tools_json`), whoever calls it. A server set to `members` often has
no sign-in of its own, so it couldn't list its tools. So:

- Bringing a connection lists the tools with it for the workspace's servers at that address that sign in with members'
  accounts and have no tools listed or an error.
- An owner or admin who lists a server's tools again (or changes its address, headers or `signInAs`) on a server with no
  sign-in of its own lists them with their own brought connection, if they have one (audited `listedWithOwnConnection`).
- Checking a connection (adding it, changing its sign-in, signing in, **Check again**) lists the tools for the
  workspaces it was brought to in the same way.

Accounts on one service can differ in what they offer; a tool a member's account can't use fails for that member with
the server's own answer.

## OAuth for a connection

The flows are those of a workspace's server, with the same callbacks (`/api/mcp-servers/oauth/callback` and
`/api/mcp-servers/oauth/app/callback`) so the same OAuth clients and the same client ID metadata document serve both:

- From the web, `GET /api/mcp-connections/:id/oauth/start` keeps the state, PKCE verifier and registered client
  (encrypted) in `mcp_connection_sign_ins` (`app = 0`) for that member, connection and address, sets the same state
  cookie, and the callback, finding no workspace server's state, finishes the connection's sign-in and returns to the
  profile. Only the member who started it finishes it (`invalid_oauth_state` for anyone else, and no code is exchanged).
- From an app, `POST /api/mcp-connections/:id/oauth/app` gives the one-time link, and the begin page, callback and
  `POST /api/mcp-servers/oauth/app/finish` fall back to `mcp_connection_sign_ins` (`app = 1`) as they find no workspace
  server's sign-in. Finishing answers `{ connection }` where a workspace server's answers `{ workspaceId, server }`. The
  code binds the flow to the member as it does for a workspace's server (`not_your_sign_in`).

Renewal is the same code as a workspace's (`withCredentials` in `remote-mcp/credentials.ts`), over an `OAuthKeeper` that
says where the sign-in is kept and swaps a rotated refresh token with a compare-and-set on the ciphertext. A refused
renewal tells the member to sign in again in their profile rather than an owner or admin.

## What isn't here yet

- Other services. The model (owner, exact target, method, explicit bringing, whose account a request uses) is meant to
  carry over; Git and document accounts already follow its first half.
- Model provider logins. They are kept on each host by design and never reach the Pikibun server, and moving them would
  change that.
- A tool list per account. One list per server keeps what sessions are offered the same for everyone in a workspace.
