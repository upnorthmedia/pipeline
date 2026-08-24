-- The `alembic_version` row, not just the table.
--
-- `alembic_version` is the marker that says which schema version a database is
-- at, and `src/db/schema-parity.test.ts` reads it to prove it is comparing
-- against a database at the recorded version. Every database the deleted Python
-- migration chain built carries `012`; a database built from this baseline
-- carries the same shape, so it is at the same version and has to say so.
-- Without this a fresh database has the table and no row, and the parity check
-- fails on every new checkout and every CI run.
--
-- Guarded rather than unconditional: an existing database already has its row,
-- and this must not add a second one to a single-column primary key.
INSERT INTO "alembic_version" ("version_num")
SELECT '012' WHERE NOT EXISTS (SELECT 1 FROM "alembic_version");
