import { readOwnerSeedInput, seedOwner } from './owner-seed';
import { createWritingSeedClient } from './seed-client';

/**
 * Creates CNC's first Owner from `CNC_SEED_OWNER_EMAIL` and
 * `CNC_SEED_OWNER_PASSWORD` (and the optional `CNC_SEED_OWNER_NAME`).
 *
 *   npm run db:seed:owner
 *
 * Run once, by hand, after `npm run db:seed`. Deliberately not Prisma's
 * `seed` key, so `migrate reset` never creates a credential. Does nothing if
 * an Owner exists; never changes a row (`owner-seed.ts`).
 *
 * Refuses any database but a local one unless `CNC_SEED_OWNER_ALLOW_REMOTE`
 * is exactly `true` for the run (`local-database.ts`). The password is never
 * printed, logged or stored in plain text.
 */

async function main(): Promise<void> {
  // Validated before any connection, so a missing value fails at once.
  const input = readOwnerSeedInput({
    email: process.env.CNC_SEED_OWNER_EMAIL,
    password: process.env.CNC_SEED_OWNER_PASSWORD,
    name: process.env.CNC_SEED_OWNER_NAME,
  });

  const prisma = createWritingSeedClient(
    'CNC_SEED_OWNER_ALLOW_REMOTE',
    process.env.CNC_SEED_OWNER_ALLOW_REMOTE,
  );

  try {
    const result = await seedOwner(prisma, input);

    if (result.outcome === 'exists') {
      console.log(
        `An Owner account already exists (${result.staffNo}). Nothing was ` +
          `changed: this seed creates the first Owner only.`,
      );
      return;
    }

    console.log(`Created the Owner ${result.staffNo} for ${result.email}.`);
    console.log(
      'Sign in with the password you supplied; the app asks for a new one ' +
        'at first sign-in. It was not stored in plain text and cannot be ' +
        'recovered from the database.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seeding the Owner failed.');
  // A refusal (OwnerSeedRefusal) is a sentence for the operator; any other
  // error is printed by its message only, so no object dump of the input
  // can reach the terminal.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
