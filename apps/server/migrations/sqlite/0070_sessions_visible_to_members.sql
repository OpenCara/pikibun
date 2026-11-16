-- Private sessions were removed (docs/collaboration.md): every session is visible to its workspace's members, who read it, and
-- message it where their role allows. Access no longer reads the column; the sessions made private before are workspace-visible too.
UPDATE sessions SET visibility = 'workspace' WHERE visibility <> 'workspace';
