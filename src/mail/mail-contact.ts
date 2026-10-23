import type { Prisma } from '../../generated/cnc-client';
import { phoneForDisplay } from '../common/nigerian-phone';

/**
 * What every customer email says about the person and about CNC: the
 * greeting's first name and CNC's phone. Shared by the booking emails
 * (`ReservationMail`, C6) and the order emails (`OnlineOrderMail`, C7-6),
 * so the two never greet or sign off differently.
 */

/** The first word of a name, for "Hello Ada,"; the whole name if it has none. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** What an email says when the business details hold no phone. */
export const NO_PHONE_TEXT = 'the number on our website';

/**
 * CNC's phone as the site shows it ("0803 123 4567"), from the business
 * details, read in the caller's transaction.
 */
export async function cncPhoneForMail(
  reader: Pick<Prisma.TransactionClient, 'business'>,
): Promise<string> {
  const business = await reader.business.findUnique({
    where: { singleton: true },
    select: { phone: true },
  });

  return business?.phone ? phoneForDisplay(business.phone) : NO_PHONE_TEXT;
}
