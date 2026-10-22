import type { Prisma } from '../../generated/cnc-client';
import { lockCustomerEmail } from '../customers/customer-email-lock';

type Tx = Prisma.TransactionClient;

/**
 * How a booking finds its customer (Q35's default, A15): only on an exact
 * match to a verified email, else a verified phone, and never by creating
 * an account. One module for both directions, so they cannot disagree:
 *
 * - a booking made without a session (Reception's, or a website guest's)
 *   links to the customer already holding its verified email or phone
 *   (`verifiedCustomerId`);
 * - a customer who proves an email with a code (a sign-in, an email
 *   change) collects the unlinked bookings made under that email
 *   (`linkBookingsToVerifiedEmail`), which is what the website's done
 *   screen promises: "Sign in with the phone number or email you gave".
 *
 * Both take the email's advisory lock (`lockCustomerEmail`), so a booking
 * and a first sign-in for one address at once still end linked.
 */

/**
 * The verified customer a booking's contact belongs to, or null. The email
 * is stored lower case on both sides, and a Nigerian phone in its one form
 * (`guestPhone`, `customerPhone`), so an exact match is a real one.
 */
export async function verifiedCustomerId(
  tx: Tx,
  email: string,
  phone: string,
): Promise<string | null> {
  if (email !== '') {
    await lockCustomerEmail(tx, email);

    const byEmail = await tx.customer.findFirst({
      where: { email, emailVerifiedAt: { not: null }, deletedAt: null },
      select: { id: true },
    });

    if (byEmail !== null) return byEmail.id;
  }

  if (phone === '') return null;

  const byPhone = await tx.customer.findFirst({
    where: { phone, phoneVerifiedAt: { not: null }, deletedAt: null },
    select: { id: true },
  });

  return byPhone?.id ?? null;
}

/**
 * Link every booking made under `email` that has no customer yet to the
 * customer who has just proved it, in the caller's transaction (which holds
 * the email's lock). A booking already linked is never moved: it is in
 * someone's app. The booking's `version` is not moved: no screen edits the
 * link, so no open screen holds a stale copy of it. Returns how many.
 */
export async function linkBookingsToVerifiedEmail(
  tx: Tx,
  customerId: string,
  email: string,
): Promise<number> {
  if (email === '') return 0;

  const { count } = await tx.reservation.updateMany({
    where: { email, customerId: null },
    data: { customerId },
  });

  return count;
}
