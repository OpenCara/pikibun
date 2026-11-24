-- New defaults for what nobody has chosen yet (docs/design/security-rationale.md, "Open defaults"): a workspace without a
-- network policy row now has network access Open (defaultNetworkPolicy in packages/shared/src/network.ts), and a member
-- without a GitHub reach row now reaches any repository they can access (defaultGitHubReach in
-- packages/shared/src/github-reach.ts). Shared workspaces that exist already keep what they had: this writes the
-- defaults they ran under, Off and the workspace's repositories only, as rows of their own, for every such workspace and
-- every member it has now. Private workspaces get no rows: they have one member, whose sessions run on their own hosts,
-- so they follow the new defaults. Rows that exist are someone's choice and stay as they are.
INSERT INTO workspace_network_policies (workspace_id, mode, domains_json, package_registries, updated_by, updated_at)
  SELECT w.id, 'off', '[]', 1, w.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM workspaces w
  WHERE NOT EXISTS (SELECT 1 FROM personal_workspaces p WHERE p.workspace_id = w.id)
  ON CONFLICT (workspace_id) DO NOTHING;
INSERT INTO member_github_reach (workspace_id, user_id, any_repository, updated_at)
  SELECT m.workspace_id, m.user_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM workspace_members m
  WHERE NOT EXISTS (SELECT 1 FROM personal_workspaces p WHERE p.workspace_id = m.workspace_id)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;
