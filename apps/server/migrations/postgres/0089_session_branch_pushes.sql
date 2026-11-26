-- Postgres translation of sqlite/0096_session_branch_pushes.sql.

-- A session pushes its own branch through Pikibun (the egress relay or a direct push grant, audited as
-- git.push.session_branch) and may then open that branch's pull request with gh or az, which Pikibun doesn't see.
-- Such a push now records the branch in session_branches, so the pull request sweep finds its pull request as it does
-- for the branches a host reports (docs/pushes.md). This adds the branches sessions not yet archived pushed before.
INSERT INTO session_branches (session_id, repository, branch, reported_at)
SELECT a.session_id, r.full_name, a.detail_json::jsonb ->> 'branch', MAX(a.created_at)
FROM sessions s
INNER JOIN audit a ON a.session_id = s.id AND a.action = 'git.push.session_branch'
INNER JOIN workspace_repositories r ON r.id = a.detail_json::jsonb ->> 'bindingId' AND r.workspace_id = s.workspace_id
  AND ((r.provider = 'github' AND r.host = 'github.com') OR (r.provider = 'azure-devops' AND r.host = 'dev.azure.com'))
WHERE s.status <> 'archived' AND jsonb_typeof(a.detail_json::jsonb -> 'branch') = 'string'
  AND replace(COALESCE(a.detail_json::jsonb ->> 'new', 'x'), '0', '') <> ''
GROUP BY a.session_id, r.full_name, a.detail_json::jsonb ->> 'branch'
ON CONFLICT (session_id, repository, branch) DO NOTHING;
