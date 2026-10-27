import { Client } from 'pg';

/**
 * A lock between e2e suites over the shared one-row tables (`Settings`,
 * `Business`) and the opening hours.
 *
 * The test database is shared by every suite, in parallel. The settings
 * suite saves those rows through the real routes, which commit (it restores
 * every value it changes); the seed suite asserts that a re-run of the seed
 * changes no row and that the rows hold Q7's values. Run at the same moment,
 * the seed suite would see a version move that the seed did not cause.
 * Each suite holds this lock for the stretch that writes or asserts on
 * those rows, so the two never overlap.
 *
 * A session-level advisory lock on a connection of its own, outside the
 * app's pool of three: holding a pooled connection for a whole suite would
 * leave the routes under test one connection short.
 */
export async function lockSharedRows(
  databaseUrl: string,
): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();
  await client.query(
    `SELECT pg_advisory_lock(hashtext('cnc-test:shared-rows'))`,
  );

  return async () => {
    try {
      await client.query(
        `SELECT pg_advisory_unlock(hashtext('cnc-test:shared-rows'))`,
      );
    } finally {
      await client.end();
    }
  };
}
