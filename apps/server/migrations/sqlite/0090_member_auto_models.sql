-- A member's own choice, per workspace, of the models auto mode may choose for the messages they send (apps/server/src/auto-mode.ts).
-- No row: every model the workspace's models setting allows. models_json: a JSON array of provider/modelId keys; Auto chooses
-- only among those, within the workspace's setting.
CREATE TABLE member_auto_models (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  models_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
