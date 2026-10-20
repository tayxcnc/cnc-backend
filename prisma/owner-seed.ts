import { Prisma, StaffRole, type PrismaClient } from '../generated/cnc-client';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password';
import { generateQrToken } from '../src/common/qr-token';
import { watToday } from '../src/common/wat';
import { drawNumber } from '../src/prisma/sequences';

/**
 * Creates CNC's first Owner account (plan §12.1, Q9), the one account that
 * cannot be created through the API: staff are created in Staff & Access by
 * an Owner, and an Owner needs an account to sign in. Copied from TAY's
 * first-admin seed and adapted.
 *
 * ## Kept off Prisma's `seed` key
 *
 * `migrate reset` runs the `seed` key, and a reset must never mint a
 * credential: a reset in the wrong terminal would create an Owner wherever it
 * pointed. This runs only as `npm run db:seed:owner`, by hand.
 *
 * ## Only ever the first Owner
 *
 * The seed does nothing when any Owner account exists, active or not, and it
 * never updates a row. A re-run that reset the password would make the one
 * in the operator's shell history work again; a re-run after the Owner
 * changed their email would mint a second Owner. Both are worse than doing
 * nothing. It refuses an email that already belongs to another staff member
 * rather than promote them.
 *
 * ## A temporary password
 *
 * `mustChangePassword` is true (A14, and the C3 gate's first step: "Sign in
 * as the Owner and change the temporary password"). TAY seeds its first
 * admin with the flag off because the operator chose the password; CNC's
 * plan treats the seeded password as temporary, so it has travelled through
 * a `.env` file and a shell and is changed at first sign-in.
 *
 * No audit row: like the opening hours the migration seeds, this is the
 * initial state, not a staff member's action.
 */

/** The `.env.example` placeholder, refused so a copied example never becomes a credential. */
export const EXAMPLE_PASSWORD =
  'choose_a_real_password_before_running_the_seed';

/** The name used when `CNC_SEED_OWNER_NAME` is unset. The Owner renames themselves in the app. */
export const DEFAULT_OWNER_NAME = 'Owner';

/** A shape check, not a deliverability check: the address must look like one. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Advisory lock key: two runs at once must not both find no Owner. */
const OWNER_SEED_LOCK = 'cnc-seed-owner';

export interface OwnerSeedInput {
  email: string;
  password: string;
  name: string;
}

/** The variables as read from the environment, unvalidated. */
export interface OwnerSeedVariables {
  email: string | undefined;
  password: string | undefined;
  name: string | undefined;
}

/** A refusal the operator can act on. Its message never contains the password. */
export class OwnerSeedRefusal extends Error {}

/**
 * Validate the variables before any connection is opened, so a missing or
 * placeholder value fails in a millisecond with a readable reason. There is
 * no default email or password: a seeded Owner with a guessable credential
 * is worse than no Owner.
 */
export function readOwnerSeedInput(
  variables: OwnerSeedVariables,
): OwnerSeedInput {
  const email = variables.email?.trim().toLowerCase() ?? '';
  const password = variables.password ?? '';
  const name = variables.name?.trim() || DEFAULT_OWNER_NAME;

  if (email === '' || password === '') {
    throw new OwnerSeedRefusal(
      'Set both CNC_SEED_OWNER_EMAIL and CNC_SEED_OWNER_PASSWORD before ' +
        'seeding the Owner: in .env for a local run, or in the shell for a ' +
        'one-off. There is no default for either.',
    );
  }

  if (!EMAIL_SHAPE.test(email)) {
    throw new OwnerSeedRefusal('CNC_SEED_OWNER_EMAIL is not an email address.');
  }

  if (password === EXAMPLE_PASSWORD) {
    throw new OwnerSeedRefusal(
      'CNC_SEED_OWNER_PASSWORD is still the .env.example placeholder, which ' +
        'is public in this repository. Choose a real password.',
    );
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new OwnerSeedRefusal(
      `CNC_SEED_OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  return { email, password, name };
}

export type OwnerSeedResult =
  | { outcome: 'created'; staffNo: string; email: string }
  | { outcome: 'exists'; staffNo: string; email: string };

/**
 * The seed's work inside a transaction the caller owns. Exported for the
 * e2e spec, which runs it inside a transaction it rolls back.
 */
export async function seedOwnerInTransaction(
  tx: Prisma.TransactionClient,
  input: OwnerSeedInput,
  passwordHash: string,
  now: Date,
): Promise<OwnerSeedResult> {
  // Serialise concurrent runs: without it, two could both see no Owner.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OWNER_SEED_LOCK}))`;

  const owner = await tx.staff.findFirst({
    where: { role: StaffRole.OWNER },
    orderBy: { createdAt: 'asc' },
    select: { staffNo: true, email: true },
  });

  if (owner !== null) {
    return { outcome: 'exists', ...owner };
  }

  const holder = await tx.staff.findUnique({
    where: { email: input.email },
    select: { staffNo: true },
  });

  if (holder !== null) {
    throw new OwnerSeedRefusal(
      `${input.email} already belongs to staff member ${holder.staffNo}, who ` +
        `is not an Owner. The seed never promotes an account; use another ` +
        `email for the first Owner.`,
    );
  }

  const created = await tx.staff.create({
    data: {
      staffNo: await drawNumber(tx, 'staff'),
      name: input.name,
      email: input.email,
      role: StaffRole.OWNER,
      isActive: true,
      passwordHash,
      mustChangePassword: true,
      qrToken: generateQrToken(),
      joinedOn: watToday(now),
    },
    select: { staffNo: true, email: true },
  });

  return { outcome: 'created', ...created };
}

/** Create the first Owner unless one exists. */
export async function seedOwner(
  prisma: PrismaClient,
  input: OwnerSeedInput,
  now: Date = new Date(),
): Promise<OwnerSeedResult> {
  // Hashed before the transaction: argon2 takes tens of milliseconds and
  // needs no lock.
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction((tx) =>
    seedOwnerInTransaction(tx, input, passwordHash, now),
  );
}
