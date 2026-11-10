-- Postgres translation of sqlite/0063_approvals_removed.sql.

-- Approvals were removed (docs/approvals.md): a session runs the tools of its owner's tool group, or refuses them, and
-- nobody is asked. What people decided stays in each session's audit log: every approval review becomes an
-- approval.requested entry there, before its table goes, its operation kept as the text it was stored as.
INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
  SELECT 'approval-' || r.session_id || '-' || r.approval_id, s.workspace_id, r.session_id, r.requested_by, 'approval.requested',
    json_build_object('approvalId', r.approval_id, 'source', r.source, 'operationJson', r.operation_json)::text, r.created_at
  FROM approval_reviews r JOIN sessions s ON s.id = r.session_id
  ON CONFLICT (id) DO NOTHING;
DROP TABLE approval_reviews;
-- One-use capabilities for brokered GitHub calls a person approved.
DROP TABLE broker_capabilities;
-- Requester auto-approve (Always approve, and the workspace setting that allowed it).
DROP TABLE session_auto_approved_requesters;
DROP TABLE workspace_approval_settings;
-- Extensions' tools no longer wait for approval: an enabled extension's tools run where its host allows them.
UPDATE workspace_extensions SET tools_mode = 'automatic' WHERE tools_mode = 'approval';
