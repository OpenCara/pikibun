-- Host command grants have one level (docs/design/sharing.md): 'approve' asked the host's owner to decide each
-- command, which went with approvals; such a grant now runs host commands as an 'auto' one does.
UPDATE connector_host_grants SET level = 'auto' WHERE level = 'approve';
