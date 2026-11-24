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
   in the owner's session acts as the member. Scheduled prompts run as the schedule's owner ([workspace-schedules.md](workspace-schedules.md)).

5. **Gates before any route runs.** In order: the sender can still write to the session; the call comes from the
   session's own host (`requireCallbackScope`); the admission is the sender's, a write message, and live
   (`requireAdmission`); both the session owner's and the sender's tool groups have `workspace` (`requireToolCall`);
   `piki:workspace` is on in the workspace; and a change needs a message that isn't Read-only. The connector checks the
   switch, the tool groups and Read-only too, but the control plane is where they hold, including for connectors that
   don't know `piki:workspace`.

6. **Opt-in, and owners' and admins' by default.** `piki:workspace` is `optIn`, as `piki:tunnel` is: a workspace that
   never listed it has it off, and a host whose answer doesn't turn it on leaves it off (`sessionToolsOff` with
   `failClosedOnly`). `workspace` is a group tool, in the owner and admin role groups only; collaborators gain little
   from it (every change needs an admin) and keep the default narrow. Custom tool groups saved before it existed don't
   have it.

7. **Changes keep what they don't name.** `set_extension` reads the extension first and keeps whether it is on, its
   `tools` mode and its settings unless the call names them, because the extensions route replaces the whole entry:
   changing an extension's settings from a session must not turn it on, and turning it off must not wipe what an admin
   configured. A `piki:` extension the workspace doesn't have yet is added on (decision 12 covers the others). The network actions read the policy and change
   one thing (the mode, or one domain), then save the whole policy as the settings page does, so two saves at the same
   moment keep the later one, as two saves from the page would.

8. **Adding a repository by its URL or name.** The repositories route wants the provider's repository id, which the
   agent rarely knows. The tool reads `repository` as the settings page's **By URL** does (`repositoryFullName`: a web
   or clone URL, an SSH remote, or the name itself), takes the provider from a github.com, gitlab.com, bitbucket.org or
   dev.azure.com URL and the host from a self-hosted one, and looks the id up by name with the sender's own account for
   that provider (`lookupRepository`), the same access the route then verifies with. It binds the canonical name the
   provider answers with, so a name typed in another case still binds. `repository_id` skips the lookup.

9. **Recorded with the session.** Besides the route's own entry, each change adds `session.workspace_tool.changed` with
   the session, the call id, the action and the values it named, never an extension's settings, which may hold
   anything an admin typed. It is written once the route has made the change, and the route's own entry is already
   recorded then; if this second entry fails, the server logs it and the call still answers with the change it made,
   so the agent doesn't retry a change that happened.

10. **What it leaves out.** Hosts and their sharing, invite links, Git accounts and workspace connections, push
    identities, the workspace database, exports and deleting the workspace. They hand out access or credentials, move
    data out, or can't be undone, and a prompt-injected agent with an admin's message would otherwise reach them.

11. **The gates are the controls, not the wording.** The tool's description and instructions tell the agent to change
    the workspace only when asked. That is guidance a crafted message or file could talk an agent out of: a prompt
    injection in an owner's or admin's session could steer it to widen network access or add a member. What actually
    bounds it is decision 5's gates: the extension is opt-in, both tool groups must have `workspace` (owners and admins
    only by default), the sender's role limits every change through the routes, a Read-only message changes nothing, and
    the most sensitive settings aren't reachable at all (decision 10). Workspaces that turn it on should keep it to the
    people they would trust to make those changes by hand, and every change is in the workspace's activity.

12. **No new third-party code from a session.** The settings page's rule (an owner or admin may add any `npm:` or
    `git:` source) is not enough for an agent: on sandboxed hosts a listed `npm:` extension is fetched and run in every
    session without the host owner installing it ([extension-planes.md](extension-planes.md), phase 2), so a
    prompt-injected agent in an admin's session could otherwise run a package of its choosing in everyone's sessions.
    This is the one place the tool is narrower than its sender's role. `set_extension` normalizes the source and
    compares it with the workspace's list before it calls the route (`requireListedSource`):
    - a `piki:` source is always taken: built-ins are Pikibun's own code, already on the host or the Pikibun server;
    - an `npm:` or `git:` source is taken only when the workspace lists exactly that source, so the call can only
      turn it on or off or change its settings;
    - anything else is refused with `403 extension_source_not_listed`: a source the workspace doesn't list, and
      another version or commit of one it lists. A new version is new code, and the workspace's integrity lock belongs
      to the version a person chose, so an update is a person's decision too. Allowing "the same integrity" would
      allow nothing more than the exact-source rule does, since a different version never has the same digest.

    The refusal names the page (**Settings → Workspaces →** the workspace **→ Extensions**) so the agent tells the
    person rather than looks for another way. `remove_extension` runs no new code, so this rule doesn't apply to it (decision 13 refuses removing a guard).

    The other actions were read for the same hole when this was added. None adds code or a remote MCP server: the
    tool has no remote MCP action, and `sources` only reads. Two of the reachable built-in behaviours are now a
    person's too (decision 13): adding a remote context page, and turning off a guard. What a steered agent can still
    reach, which decision 11 leaves to the gates:
    - it can add `piki:skills` (repositories' skills are then listed for the model), `piki:tunnel` and
      `piki:artifacts`;
    - it can open the network (`set_network_mode`, `allow_domain`), add a repository its sender can read, and move a
      member to a tool group with more tools.

13. **Remote context and guards are a person's.** Two settings changes reach every session as surely as new code
    does, so `set_extension` and `remove_extension` refuse them before calling the route, with the same pointer to
    **Settings → Workspaces →** the workspace **→ Extensions** ("A person decides this ... in the app's settings: tell
    them so, and don't try another way"):
    - **A new remote context page** (`403 context_url_not_listed`, `requireListedContextUrls`). `piki:context-files`
      fetches each `https://` entry of its `context-files` setting into the system prompt of every session, so a URL
      the agent names would put text of an attacker's choosing in front of every model there. Each entry of the new
      value that holds `://` (split on commas, new lines and `|`, comments skipped, compared as `new URL().href`, so
      `https://Docs.Example.com/a` is the listed `https://docs.example.com/a`; `contextFileUrls` in
      `packages/shared/src/workspace-management.ts`) must already be in the current value. Any scheme counts, not
      only `https://`, so a URL the extension skips today can't be planted for a later version that reads it. Adding
      `piki:context-files` anew, or after `remove_extension`, compares against nothing, so it takes no URL.
    - **A guard turned off, removed or reconfigured** (`403 guard_extension_kept`, `requireGuardKept`). The guards
      are `workspaceGuardExtensions`: `piki:prompt-audit` (checks each message before it reaches the agent) and
      `npm:cc-safety-net` in any version (checks the commands the agent runs). `remove_extension` refuses them;
      `set_extension` refuses `enabled: false` on one that is on, and any settings other than the current ones,
      because a guard's settings (prompt audit's `audit`, `policy` and `model`) can let through as much as turning it
      off would.

    What stays allowed, because it narrows or keeps what a person chose: removing URLs from `context-files` and
    changing its other entries (files in a clone, `host:<name>` files the host's owner placed) and `context-max-chars`;
    turning `piki:context-files` on or off with the URLs a person listed; turning a guard on, adding
    `piki:prompt-audit` with its default settings, and saving a guard with its settings unchanged. A guard that is
    already off stays off when the call leaves `enabled` out. Other extensions that shape the prompt (`piki:skills`,
    `piki:pr-flow`, `piki:sub-agents`) are Pikibun's own text or the workspace's repositories, not pages anyone on the
    web can change, so they stay with decision 11's gates.

## Where things are

| Part | Where |
|---|---|
| Definition, actions, fields | `packages/shared/src/workspace-management.ts` |
| Switch and group tool | `packages/shared/src/piki-extensions.ts` (`piki:workspace`), `packages/shared/src/tool-groups.ts` |
| Control plane | `apps/server/src/workspace-tool.ts`; routes in `connectors.ts` (`/api/connectors/self/workspace`) and `legacy-runner.ts` |
| Tests | `tests/workspace-tool.test.ts` |
