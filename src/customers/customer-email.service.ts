import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { OtpPurpose } from '../../generated/cnc-client';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { linkBookingsToVerifiedEmail } from '../reception/customer-link';
import { CustomerService } from './customer.service';
import type { CodeSentResponse } from './dto/customer-auth.dto';
import type { CustomerProfileResponse } from './dto/customer-profile.response';
import { maskEmail } from './one-time-code';
import { OtpService } from './otp.service';

/**
 * The new email is the one the account already has (400). New: the demo
 * saved an email without a code, so there was nothing to refuse.
 */
export const SAME_EMAIL_MESSAGE = 'That is already your email address.';

/**
 * The new email belongs to another account (409). New, in the form of the
 * phone's sentence. Told only after the code proves the caller holds the
 * address, so the route cannot be used to learn which emails have
 * accounts.
 */
export const EMAIL_TAKEN_MESSAGE =
  'That email address is already on another CNC account.';

/**
 * Changing the sign-in email (plan §5.2, C6-3): a code to the new address,
 * then the code back. The account keeps its email until the code is
 * verified, so a typo never locks anyone out.
 *
 * - **The code runs through `OtpService`** with purpose `CHANGE_EMAIL`:
 *   the same six digits, ten minutes, five tries, 30-second resend and the
 *   per-email and per-address caps as sign-in, and the account app's
 *   sentences. The code is issued for the asking customer and verified
 *   only by that customer.
 * - **Whether another account holds the address is answered at verify**,
 *   once the caller has shown they read its inbox. Asking for a code says
 *   nothing either way.
 * - **The old address is told** (`customer.email-changed`), with the new
 *   one masked: if someone holding the session changed it, the owner hears
 *   of it at the address they know. Sessions are kept: the person who
 *   changed it is signed in, and changing the email back needs a code at
 *   an inbox the owner holds.
 */
@Injectable()
export class CustomerEmailService {
  constructor(
    private readonly customers: CustomerService,
    private readonly otp: OtpService,
    private readonly outbound: OutboundMessagesService,
  ) {}

  /** `POST /me/email/code`: send a code to the new address. */
  async requestCode(
    customerId: string,
    email: string,
    ipAddress: string,
  ): Promise<CodeSentResponse> {
    const current = await this.customers.profile(customerId);

    if (current.email === email) {
      throw new BadRequestException(SAME_EMAIL_MESSAGE);
    }

    return this.otp.issue({
      purpose: OtpPurpose.CHANGE_EMAIL,
      contact: email,
      customerId,
      ipAddress,
      template: 'customer.email-change-code',
    });
  }

  /**
   * `POST /me/email/verify`: check the code and move the account to the
   * new address, marked verified. Under the email's lock, so a first
   * sign-in with that address at the same moment either creates its
   * account first (and this answers 409) or finds this one.
   */
  async verify(
    customerId: string,
    email: string,
    code: string,
  ): Promise<CustomerProfileResponse> {
    const noticeId = await this.otp.verify(
      { purpose: OtpPurpose.CHANGE_EMAIL, contact: email, code, customerId },
      async (tx, matched) => {
        await this.customers.lockEmail(tx, email);

        const current = await this.customers.lockLive(tx, customerId);

        if (current.email === email) return null;

        const holder = await tx.customer.findUnique({
          where: { email },
          select: { id: true },
        });

        if (holder !== null) {
          throw new ConflictException(EMAIL_TAKEN_MESSAGE);
        }

        await tx.customer.update({
          where: { id: customerId },
          data: { email, emailVerifiedAt: new Date() },
        });

        // The new address is proved: its guest bookings join the account
        // (A15, C6-5), under the email's lock taken above.
        await linkBookingsToVerifiedEmail(tx, customerId, email);

        if (current.email === null) return null;

        return this.outbound.enqueue(tx, {
          to: current.email,
          template: 'customer.email-changed',
          params: { newEmailMasked: maskEmail(email) },
          dedupeKey: `email-changed:${matched.id}`,
        });
      },
    );

    if (noticeId !== null) await this.outbound.dispatch(noticeId);

    return this.customers.profile(customerId);
  }
}
