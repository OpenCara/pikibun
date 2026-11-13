-- Postgres translation of sqlite/0067_host_grant_levels.sql.
-- Host command grants have one level (docs/hosts.md#host-admins-and-host-command-grants): 'approve' asked the host's owner to decide each
-- command, which went with approvals; such a grant now runs host commands as an 'auto' one does.
UPDATE connector_host_grants SET level = 'auto' WHERE level = 'approve';
