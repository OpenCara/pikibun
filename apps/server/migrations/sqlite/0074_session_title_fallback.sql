-- The title a session stands under until a model names it: set when a person starts a session whose title the client made
-- from its first message (POST /api/sessions with generateTitle), and cleared once that message named it, or a person renamed
-- it. A model's title replaces the session's only while its title is still this one (apps/server/src/session-titles.ts).
ALTER TABLE sessions ADD COLUMN title_fallback TEXT;
