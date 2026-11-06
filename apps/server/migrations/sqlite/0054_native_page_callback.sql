-- Where a native sign-in hands its result back (auth.ts): NULL, the app's own pikibun://auth, as before; 'page', the
-- server's /api/auth/native/done page, which an app signing in through its own web view watches for (the client on
-- Native Shell, whose web views navigate only to http and https and which has no URL schemes).
ALTER TABLE oauth_states ADD COLUMN native_callback TEXT CHECK (native_callback IS NULL OR native_callback = 'page');
