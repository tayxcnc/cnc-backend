import type { Prisma } from '../../generated/cnc-client';

/**
 * The advisory lock every write that ties an email to a customer takes
 * first (`cnc:customer-email:<email>`), held to the end of the caller's
 * transaction: a first sign-in, an email change, checkout's "Save my
 * details" (C7), and a booking that links to the customer holding its
 * email (Q35, C6-5).
 *
 * Two of them naming one address then run one after the other: a second
 * first sign-in finds the first's row instead of meeting the unique index
 * as a 500, and a booking made while its guest is signing in for the first
 * time is either linked by the booking (it sees the committed customer) or
 * by the sign-in (it sees the committed booking), never by neither.
 *
 * A plain function, not a `CustomerService` method, so Reception's booking
 * command takes the same lock without depending on the customers module.
 */
export async function lockCustomerEmail(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  email: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cnc:customer-email:${email}`}))`;
}
