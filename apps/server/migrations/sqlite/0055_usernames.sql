-- Usernames (password-auth.ts). A password account's is the name in its user ID, password:<username>; a GitHub account
-- chooses its own once, after signing up, and can then also sign in with it and a password it sets. One namespace for
-- both, so a username names one account whichever way it signs in. NULL until chosen; a unique index allows many NULLs.
ALTER TABLE users ADD COLUMN username TEXT CHECK (username IS NULL OR length(username) BETWEEN 3 AND 39);
UPDATE users SET username = substr(id, 10) WHERE auth_kind = 'password' AND id LIKE 'password:%';
CREATE UNIQUE INDEX users_username ON users(username);

-- How a browser or app signed in, where the account's kind doesn't say: 'password' for a username and password, so
-- turning PASSWORD_AUTH off ends a GitHub account's password sign-ins at once too; NULL for the account's own method.
ALTER TABLE auth_sessions ADD COLUMN method TEXT CHECK (method IS NULL OR method = 'password');
