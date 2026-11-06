-- The version a host's connector reported when it last connected (the x-pikibun-version header of its manifest, see
-- packages/shared/src/version.ts), which the host's page shows. NULL for connectors that report none: those from before
-- they did, and development builds.
ALTER TABLE connectors ADD COLUMN connector_version TEXT;
