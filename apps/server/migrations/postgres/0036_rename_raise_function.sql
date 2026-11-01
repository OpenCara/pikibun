-- Pistead became Pikibun: 0001_schema.sql now creates pikibun_raise(), but databases it ran on before the rename hold the
-- function as pistead_raise(). Renaming it keeps every trigger working (they reference the function itself, not its
-- name) and lets later migrations call pikibun_raise(). A database created after the rename has no pistead_raise().
DO $$
BEGIN
  IF to_regprocedure('pistead_raise()') IS NOT NULL AND to_regprocedure('pikibun_raise()') IS NULL THEN
    ALTER FUNCTION pistead_raise() RENAME TO pikibun_raise;
  END IF;
END
$$;
