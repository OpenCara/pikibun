# The workspace tool: managing a workspace from a session

Status: implemented. User docs: [Extensions → Workspace management](../extensions.md#workspace-management-pikiworkspace).

## Why

A workspace's settings (members, repositories, extensions, tool groups, network access) had only the settings
pages and their REST routes. People already ask a session's agent for that kind of change ("add acme/api here",
"allow pypi.org so the tests can install", "make Dan a collaborator"), and the agent could only explain where the
button is. The `workspace` tool lets the agent make the change, within the same rules as the page.

## Decisions

1. **A brokered tool defined as data.** `workspace` is a `BrokeredToolDefinition` in `bundledToolDefinitions`
   (`packages/shared/src/workspace-management.ts`), with route `workspace`. Connectors that read definitions run it
   as soon as the control plane has it, with no connector code of its own. It is named outside `toolNames`, so a
   connector from before tool definitions passes over it in an agent's tool list.

2. **One tool, many actions, flat parameters.** Brokered definitions take string, integer and boolean parameters, at
   most 16. The tool takes `action` and 14 others; `workspaceActionFields` says which each action requires and allows,
   and the control plane refuses any other (a `members` call with a `user`, a `rename` without a `name`). An
   extension's settings travel as a JSON string, the one structured value an action needs.

3. **As the sender, through the routes themselves.** The control plane doesn't reimplement any rule. `agentWorkspace`
   (`apps/server/src/workspace-tool.ts`) mounts the workspace's own route modules (catalog, invites, repositories,
   sources, extensions, tool groups, network) on a fresh in-process Hono app whose only middleware sets the request's
   identity to the message's sender, and calls the matching route. So who may do what (owner only for admins, admins
   not on themselves, the owner's membership untouchable, tool groups with admins, ...) is exactly what the settings
   page enforces, today and as those routes change, and each route records its own audit entry as that person.
   Only paths `run` builds reach that app, each from fixed segments and values already checked (user ids, binding ids,
   tool group ids): the agent never names a path or a method.

4. **The sender, not the session's owner.** Like `sessions`, it acts as the person whose message the agent is working
   on (`actorId`, the run's `initiatedBy`). An admin writing in a member's session acts as the admin; a member writing
   in the owner's session acts as the member. Scheduled prompts run as the session's owner, as they always do.

5. **Gates before any route runs.** In order: the sender can still write to the session; the call comes from the
   session's own host (`requireCallbackScope`); the admission is the sender's, a write message, and live
   (`admissionExpired`); both the session owner's and the sender's tool groups have `workspace` (`requireToolCall`);
   `piki:workspace` is on in the workspace; and a change needs a message that isn't Read-only. The connector checks the
   switch, the tool groups and Read-only too, but the control plane is where they hold, including for connectors that
   don't know `piki:workspace`.

6. **Opt-in, and owners' and admins' by default.** `piki:workspace` is `optIn`, as `piki:tunnel` is: a workspace that
   never listed it has it off, and a host whose answer doesn't turn it on leaves it off (`sessionToolsOff` with
   `failClosedOnly`). `workspace` is a group tool, in the owner and admin role groups only; collaborators gain little
   from it (every change needs an admin) and keep the default narrow. Custom tool groups saved before it existed don't
   have it.

7. **Changes keep what they don't name.** `set_extension` reads the extension first and keeps its `tools` mode and
   settings unless the call gives new settings, because the extensions route replaces the whole entry: turning an
   extension off from a session must not wipe what an admin configured. The network actions read the policy and change
   one thing (the mode, or one domain).

8. **Adding a GitHub repository by name.** The repositories route wants the provider's repository id, which the agent
   rarely knows. For GitHub the tool looks it up with the sender's GitHub sign-in (`githubRepositoryIdentity`), the
   same access the route then verifies with. Other providers' adapters look repositories up by id, so they need
   `repository_id`.

9. **Recorded with the session.** Besides the route's own entry, each change adds `session.workspace_tool.changed` with
   the session, the call id, the action and the values it named, never an extension's settings, which may hold
   anything an admin typed.

10. **What it leaves out.** Hosts and their sharing, invite links, Git accounts and workspace connections, push
    identities, the workspace database, exports and deleting the workspace. They hand out access or credentials, move
    data out, or can't be undone, and a prompt-injected agent with an admin's message would otherwise reach them.

## Where things are

| Part | Where |
|---|---|
| Definition, actions, fields | `packages/shared/src/workspace-management.ts` |
| Switch and group tool | `packages/shared/src/piki-extensions.ts` (`piki:workspace`), `packages/shared/src/tool-groups.ts` |
| Control plane | `apps/server/src/workspace-tool.ts`; routes in `connectors.ts` (`/api/connectors/self/workspace`) and `legacy-runner.ts` |
| Tests | `tests/workspace-tool.test.ts` |
