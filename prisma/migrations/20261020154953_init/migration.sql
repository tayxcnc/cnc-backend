-- The first migration, empty on purpose (plan C1-4).
--
-- It starts the migration history while the schema has no models, so that
-- `prisma migrate deploy` has a history to read from day one: in CI against
-- the test container, and in C2 against the new, empty CNC staging database.
-- The first models arrive in C3 as the next migration.
SELECT 1;
