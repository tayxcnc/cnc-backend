import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { OtpPurpose, Prisma } from '../../generated/cnc-client';
import { TOO_MANY_ATTEMPTS_MESSAGE } from '../auth/auth-throttle';
import { deriveKey } from '../common/derived-key';
import { CncConfigService } from '../config/cnc.config';
import type {
  MailTemplateName,
  MailTemplateParams,
} from '../mail/mail-templates';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  generateOtpCode,
  maskEmail,
  OTP_ADDRESS_LIMIT,
  OTP_CAP_WINDOW_MS,
  OTP_CONTACT_LIMIT,
  OTP_DAILY_FAILED_LIMIT,
  OTP_DAILY_WINDOW_MS,
  OTP_HASH_KEY_INFO,
  OTP_MAX_ATTEMPTS,
  OTP_PATTERN,
  OTP_RESEND_AFTER_MS,
  OTP_TTL_MS,
  otpCodeHash,
} from './one-time-code';

/** No code is waiting for this email (400). The account app's wording. */
export const ASK_FOR_NEW_CODE_MESSAGE = 'Ask for a new code.';

/** The newest code has expired (400). The account app's wording. */
export const CODE_EXPIRED_MESSAGE = 'That code has expired. Ask for a new one.';

/** The newest code's tries are spent (400). The account app's wording. */
export const CODE_ATTEMPTS_SPENT_MESSAGE =
  'Too many attempts. Ask for a new code.';

/** A wrong code with tries left (400). The account app's wording. */
export function wrongCodeMessage(left: number): string {
  return `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
}

/** A new code asked for inside the resend gap (429). The account app's wording. */
export function resendWaitMessage(seconds: number): string {
  return `Please wait ${seconds} seconds before asking for a new code.`;
}

/** The templates whose parameters are a code and its lifetime. */
export type CodeTemplate = {
  [Name in MailTemplateName]: MailTemplateParams[Name] extends {
    code: string;
    minutes: number;
  }
    ? Name
    : never;
}[MailTemplateName];

/** What the code screen is told: never the code. */
export interface CodeSent {
  sentTo: string;
  resendInSec: number;
}

/** A code that matched, for the caller's transaction to act on. */
export interface MatchedCode {
  id: string;
  contact: string;
}

type Tx = Prisma.TransactionClient;

/**
 * One-time codes for the customer realm (A15): issue one by email, check
 * one, spend one. Purpose-generic, so the email change (C6-3) runs through
 * the same caps and sentences as sign-in.
 *
 * **The code exists in clear only in the request that draws it and in the
 * email.** The row holds its keyed digest (`codeHash`, HMAC-SHA256 under a
 * key derived from `CNC_JWT_SECRET`: `otpCodeHash`), the queued email holds
 * it sealed (`MessageSeal`), and no response or log line carries it.
 *
 * **Issuance caps count the stored rows**, not memory, so they hold across
 * instances and restarts (A18 leaves the in-memory throttler per instance):
 * a new code per email only after `OTP_RESEND_AFTER_MS`, at most
 * `OTP_CONTACT_LIMIT` per email and `OTP_ADDRESS_LIMIT` per address in
 * `OTP_CAP_WINDOW_MS`, and none once the email's codes have taken
 * `OTP_DAILY_FAILED_LIMIT` wrong tries in `OTP_DAILY_WINDOW_MS`, which
 * bounds a patient guesser. The rows are kept a day past expiry for exactly this
 * (`OTP_RETENTION_HOURS`). Issuance for one email is serialised by an
 * advisory lock, so two requests at once cannot both pass a cap.
 *
 * **Checking a code** reads the email's newest code of the purpose; an
 * older code is superseded the moment a newer one is sent, as in the
 * account app. A wrong code spends a try by one conditional increment;
 * the right one is spent by one conditional update inside the caller's
 * transaction (`consume`), so two verifies of one code cannot both win,
 * and a failure after it leaves the code unspent.
 */
@Injectable()
export class OtpService {
  /** The key `codeHash` is computed under; the database never holds it. */
  private readonly hashKey: Buffer;

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly outbound: OutboundMessagesService,
    config: CncConfigService,
  ) {
    this.hashKey = deriveKey(config.jwtSecret, OTP_HASH_KEY_INFO);
  }

  /**
   * Draw a code for `contact`, store its hash, queue its email, and send it
   * after the commit. A send that fails, or mail that is not configured,
   * leaves the email queued for the retry sweep; the answer is the same.
   */
  async issue(input: {
    purpose: OtpPurpose;
    contact: string;
    customerId: string | null;
    ipAddress: string;
    template: CodeTemplate;
  }): Promise<CodeSent> {
    const now = new Date();
    // The code exists here, in the sealed email and nowhere else in clear.
    const code = generateOtpCode();

    const messageId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cnc:otp:${input.purpose}:${input.contact}`}))`;

      await this.assertMayIssue(tx, input, now);

      const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
      const row = await tx.otpCode.create({
        data: {
          purpose: input.purpose,
          contact: input.contact,
          customerId: input.customerId,
          codeHash: otpCodeHash(this.hashKey, code),
          expiresAt,
          resendAfter: new Date(now.getTime() + OTP_RESEND_AFTER_MS),
          ipAddress: input.ipAddress,
        },
        select: { id: true },
      });

      return this.outbound.enqueue(tx, {
        to: input.contact,
        template: input.template,
        params: { code, minutes: Math.floor(OTP_TTL_MS / 60_000) },
        dedupeKey: `otp:${row.id}`,
        // The email is worthless once the code has expired.
        expiresAt,
      });
    });

    await this.outbound.dispatch(messageId);

    return {
      sentTo: maskEmail(input.contact),
      resendInSec: OTP_RESEND_AFTER_MS / 1000,
    };
  }

  /**
   * Check `code` against the newest code of `purpose` sent to `contact`,
   * then run `then` in one transaction with the code spent. A wrong code
   * spends a try and throws the account app's sentence.
   *
   * `customerId`, when given, narrows the codes to those issued for that
   * customer: an email change's code proves the new address to the account
   * that asked for it, and to no other signed-in account, even one whose
   * holder can read that inbox.
   */
  async verify<T>(
    input: {
      purpose: OtpPurpose;
      contact: string;
      code: string;
      customerId?: string;
    },
    then: (tx: Tx, matched: MatchedCode) => Promise<T>,
  ): Promise<T> {
    const now = new Date();

    const newest = await this.prisma.otpCode.findFirst({
      where: {
        purpose: input.purpose,
        contact: input.contact,
        ...(input.customerId === undefined
          ? {}
          : { customerId: input.customerId }),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        contact: true,
        codeHash: true,
        attempts: true,
        expiresAt: true,
        consumedAt: true,
      },
    });

    if (newest === null || newest.consumedAt !== null) {
      throw new BadRequestException(ASK_FOR_NEW_CODE_MESSAGE);
    }

    if (newest.expiresAt <= now) {
      throw new BadRequestException(CODE_EXPIRED_MESSAGE);
    }

    if (newest.attempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException(CODE_ATTEMPTS_SPENT_MESSAGE);
    }

    if (
      !OTP_PATTERN.test(input.code) ||
      !this.matches(input.code, newest.codeHash)
    ) {
      throw new BadRequestException(await this.spendTry(newest.id));
    }

    return this.prisma.$transaction(async (tx) => {
      const spent = await tx.otpCode.updateMany({
        where: {
          id: newest.id,
          consumedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: OTP_MAX_ATTEMPTS },
        },
        data: { consumedAt: now },
      });

      // Spent by a verify that finished first, or expired in between.
      if (spent.count !== 1) {
        throw new BadRequestException(ASK_FOR_NEW_CODE_MESSAGE);
      }

      return then(tx, { id: newest.id, contact: newest.contact });
    });
  }

  /** Record the customer a spent code signed in, for the record. */
  async attribute(tx: Tx, otpId: string, customerId: string): Promise<void> {
    await tx.otpCode.update({
      where: { id: otpId },
      data: { customerId },
    });
  }

  /** The caps, under the email's lock. Throws 429 with the sentence. */
  private async assertMayIssue(
    tx: Tx,
    input: { purpose: OtpPurpose; contact: string; ipAddress: string },
    now: Date,
  ): Promise<void> {
    const latest = await tx.otpCode.findFirst({
      where: { purpose: input.purpose, contact: input.contact },
      orderBy: { createdAt: 'desc' },
      select: { resendAfter: true },
    });

    if (latest !== null && latest.resendAfter > now) {
      const seconds = Math.ceil(
        (latest.resendAfter.getTime() - now.getTime()) / 1000,
      );
      throw new HttpException(
        resendWaitMessage(seconds),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const since = new Date(now.getTime() - OTP_CAP_WINDOW_MS);

    const toContact = await tx.otpCode.count({
      where: { contact: input.contact, createdAt: { gt: since } },
    });

    if (toContact >= OTP_CONTACT_LIMIT) {
      throw new HttpException(
        TOO_MANY_ATTEMPTS_MESSAGE,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const fromAddress = await tx.otpCode.count({
      where: { ipAddress: input.ipAddress, createdAt: { gt: since } },
    });

    if (fromAddress >= OTP_ADDRESS_LIMIT) {
      throw new HttpException(
        TOO_MANY_ATTEMPTS_MESSAGE,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // The long cap: wrong tries on every code sent to this email in the
    // day, whatever the purpose, so restarting the short window does not
    // restart a guessing run.
    const failed = await tx.otpCode.aggregate({
      where: {
        contact: input.contact,
        createdAt: { gt: new Date(now.getTime() - OTP_DAILY_WINDOW_MS) },
      },
      _sum: { attempts: true },
    });

    if ((failed._sum.attempts ?? 0) >= OTP_DAILY_FAILED_LIMIT) {
      throw new HttpException(
        TOO_MANY_ATTEMPTS_MESSAGE,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** A typed code against a stored digest, in constant time. */
  private matches(code: string, codeHash: string): boolean {
    const offered = Buffer.from(otpCodeHash(this.hashKey, code), 'hex');
    const held = Buffer.from(codeHash, 'hex');

    return offered.length === held.length && timingSafeEqual(offered, held);
  }

  /**
   * Spend one try on a wrong code and say what is left. One conditional
   * increment, so two wrong guesses at once spend two tries and neither
   * can push the count past the limit.
   */
  private async spendTry(id: string): Promise<string> {
    const spent = await this.prisma.otpCode.updateMany({
      where: { id, consumedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });

    if (spent.count !== 1) {
      return CODE_ATTEMPTS_SPENT_MESSAGE;
    }

    const row = await this.prisma.otpCode.findUniqueOrThrow({
      where: { id },
      select: { attempts: true },
    });
    const left = OTP_MAX_ATTEMPTS - row.attempts;

    return left > 0 ? wrongCodeMessage(left) : CODE_ATTEMPTS_SPENT_MESSAGE;
  }
}
