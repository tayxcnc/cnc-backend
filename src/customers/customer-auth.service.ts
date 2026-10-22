import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OtpPurpose, SubjectType } from '../../generated/cnc-client';
import {
  CncTokenService,
  INVALID_REFRESH_TOKEN_MESSAGE,
} from '../auth/cnc-token.service';
import type { IssuedSession } from '../auth/staff-auth.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { CustomerService } from './customer.service';
import type {
  CodeSentResponse,
  CustomerSessionResponse,
  CustomerSignInResponse,
} from './dto/customer-auth.dto';
import { OtpService } from './otp.service';

/**
 * The customer's sign-in by email code (A15, plan §5.2): ask for a code,
 * verify it, refresh, sign out. The staff realm's `StaffAuthService` is the
 * model; the password is replaced by the code.
 *
 * - **Asking for a code never says whether the email has an account.** The
 *   same step creates one (the sign-in screen: "New to CNC? The same step
 *   creates your account."), so there is nothing to hide, but the answer is
 *   also the same either way.
 * - **Verifying creates the customer on first use**, marks the email
 *   verified, and starts a session in the customer realm: a `CUSTOMER`
 *   token and the `cnc_refresh_token` cookie, never a staff one.
 * - **No audit row.** Sign-in is not a command in the staff app's record,
 *   as staff sign-in is not; the code row records who verified, from which
 *   address and when.
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly otp: OtpService,
    private readonly customers: CustomerService,
    private readonly tokens: CncTokenService,
  ) {}

  async requestCode(
    email: string,
    ipAddress: string,
  ): Promise<CodeSentResponse> {
    const known = await this.prisma.customer.findUnique({
      where: { email },
      select: { id: true },
    });

    return this.otp.issue({
      purpose: OtpPurpose.SIGN_IN,
      contact: email,
      customerId: known?.id ?? null,
      ipAddress,
      template: 'customer.sign-in-code',
    });
  }

  async verify(
    email: string,
    code: string,
  ): Promise<IssuedSession<CustomerSignInResponse>> {
    const signedIn = await this.otp.verify(
      { purpose: OtpPurpose.SIGN_IN, contact: email, code },
      async (tx, matched) => {
        const customer = await this.customers.findOrCreateVerified(
          tx,
          matched.contact,
        );
        await this.otp.attribute(tx, matched.id, customer.id);

        return customer;
      },
    );

    const session = await this.issueSession(signedIn.id);

    return {
      body: { ...session.body, isNew: signedIn.isNew },
      refreshToken: session.refreshToken,
    };
  }

  /**
   * Spend a customer refresh token and issue the next session. A customer
   * whose row is gone is refused with the same 401 as a spent token.
   */
  async refresh(
    rawToken: string,
  ): Promise<IssuedSession<CustomerSessionResponse>> {
    const customerId = await this.tokens.redeemRefreshToken(
      rawToken,
      SubjectType.CUSTOMER,
    );

    const exists = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });

    if (exists === null) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    return this.issueSession(customerId);
  }

  /** Sign out on every device: every refresh token the customer holds. */
  async signOut(customerId: string): Promise<void> {
    await this.tokens.revokeAllForSubject(customerId, SubjectType.CUSTOMER);
  }

  private async issueSession(
    customerId: string,
  ): Promise<IssuedSession<CustomerSessionResponse>> {
    const { accessToken, refreshToken } = await this.tokens.issueTokenPair(
      customerId,
      SubjectType.CUSTOMER,
    );

    return {
      body: { accessToken, customer: await this.customers.profile(customerId) },
      refreshToken,
    };
  }
}
