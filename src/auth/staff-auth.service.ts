import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { StaffRole, SubjectType } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import { MoneyControlService } from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  CncTokenService,
  INVALID_REFRESH_TOKEN_MESSAGE,
} from './cnc-token.service';
import type { ChangePasswordRequest } from './dto/change-password.request';
import type { StaffAuthResponse } from './dto/staff-auth.response';
import type { StaffSignInRequest } from './dto/staff-sign-in.request';
import type { StaffSummaryResponse } from './dto/staff-summary.response';
import type { TemporaryPasswordResponse } from './dto/temporary-password.response';
import { ACCOUNT_GONE_MESSAGE } from './guards/cnc-staff.guard';
import {
  generateTemporaryPassword,
  hashPassword,
  readTemporaryPassword,
  verifyPassword,
} from './password';
import type { StaffPrincipal } from './staff-principal';

/**
 * The one sign-in refusal (401), TAY's wording: an unknown email, a wrong
 * password and a deactivated account answer identically, so the route never
 * tells a caller which addresses hold accounts.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';

/** Change-password with a wrong current password (401), TAY's wording. */
export const CURRENT_PASSWORD_INCORRECT_MESSAGE =
  'The current password is incorrect.';

/**
 * Change-password with the current password again (400). Without it a
 * forced change could be "completed" by typing the temporary password
 * twice, and the password a manager read out would stay the password.
 */
export const SAME_PASSWORD_MESSAGE =
  'Choose a new password that is different from the current one.';

/** The demo's sentence for a staff id that names nobody (`staff.photo`), 404. */
export const STAFF_NOT_FOUND_MESSAGE = 'Staff account not found.';

/**
 * The admin reset aimed at the caller's own account (403). Change-password
 * asks for the current password precisely so a stolen access token cannot
 * take an account over; an admin reset of oneself would skip that check.
 */
export const OWN_PASSWORD_RESET_MESSAGE =
  'Use Change Password to change your own password.';

/**
 * The columns a session is built from: the summary's fields, plus
 * `isActive` so sign-in and refresh can refuse a deactivated account. Never
 * `passwordHash`; the two reads that need it add it explicitly.
 */
const STAFF_SESSION_SELECT = {
  id: true,
  staffNo: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
} as const;

interface StaffSessionRow {
  id: string;
  staffNo: string;
  name: string;
  email: string;
  role: StaffRole;
  mustChangePassword: boolean;
}

/**
 * A session this service issued, split into what the caller may see and
 * what the controller writes to the cookie. The refresh token is not a field
 * of the response class, so a controller that returned the whole object
 * instead of `body` would fail to compile rather than leak it.
 */
export interface IssuedSession<Body> {
  body: Body;
  refreshToken: string;
}

/**
 * Staff sign-in, refresh, sign-out, change-password and the admin reset,
 * copied from TAY's `TayAuthService` (staff half) and `StaffService`
 * (`resetPassword`), and adapted to CNC's one-role staff.
 *
 * Hashing is `password.ts`'s and tokens are `CncTokenService`'s; this class
 * decides who gets a session.
 *
 * **Audited:** a password change (`staff.changePassword`) and an admin
 * reset (`staff.resetPassword`), each inside its own transaction, with the
 * account's staff number as the ref and nothing but `mustChangePassword` in
 * the change; never a password or a hash. Sign-in and refresh write no
 * audit row: the demo has no such commands, and the application log
 * records a failed sign-in.
 */
@Injectable()
export class StaffAuthService {
  private readonly logger = new Logger(StaffAuthService.name);

  /**
   * A hash nobody knows the password to, verified against when the email is
   * unknown, so an unknown address costs the same argon2 work as a wrong
   * password. TAY's sign-in returns early there, and the timing tells a
   * caller which addresses hold accounts even though the body does not.
   * Made once, on first use.
   */
  private decoyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly tokens: CncTokenService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
  ) {}

  /**
   * Sign a staff member in.
   *
   * The deactivated check runs after the password, and answers the same 401
   * as a wrong password: the response, the message and the order of the
   * checks must not tell a deactivated account from a wrong guess. Once
   * signed in, a later deactivation is the guard's 403 with its own
   * sentence (the person has proved who they are by then).
   */
  async signIn(
    request: StaffSignInRequest,
    ipAddress: string,
  ): Promise<IssuedSession<StaffAuthResponse>> {
    const staff = await this.prisma.staff.findUnique({
      where: { email: request.email },
      select: { ...STAFF_SESSION_SELECT, passwordHash: true },
    });

    if (staff === null) {
      await this.passwordMatches(
        { passwordHash: await this.decoy(), mustChangePassword: false },
        request.password,
      );
      // No audit row can name an account that does not exist; the
      // application log is the record. The address the caller typed, never
      // the password.
      this.logger.warn(
        `Staff sign-in failed for an email no account holds: ` +
          `${JSON.stringify(request.email)} from ${ipAddress}.`,
      );
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const matches = await this.passwordMatches(staff, request.password);

    if (!matches || !staff.isActive) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    return this.issueSession(staff);
  }

  /**
   * Spend a staff refresh token and issue the next session.
   *
   * A deactivated account is refused with the same 401 as a spent token,
   * after the token is spent: a fresh access token for an account every
   * route refuses would be a session that can do nothing, and a client that
   * kept refreshing it would never learn it had ended. The staff app signs
   * out on a failed refresh (plan §14).
   */
  async refresh(rawToken: string): Promise<IssuedSession<StaffAuthResponse>> {
    const staffId = await this.tokens.redeemRefreshToken(
      rawToken,
      SubjectType.STAFF,
    );

    const staff = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: STAFF_SESSION_SELECT,
    });

    if (staff === null || !staff.isActive) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    return this.issueSession(staff);
  }

  /** Sign out on every device: every refresh token the account holds. */
  async signOut(staffId: string): Promise<void> {
    await this.tokens.revokeAllForSubject(staffId, SubjectType.STAFF);
  }

  /**
   * Change one's own password and hand back a fresh session.
   *
   * The change revokes every refresh token the account holds, so returning
   * nothing would sign the caller out at the moment they did as they were
   * told; under a forced change that is a loop. The new pair is issued after
   * the commit: minted inside, it would outlive a rollback.
   */
  async changePassword(
    actor: StaffPrincipal,
    request: ChangePasswordRequest,
    ipAddress: string,
  ): Promise<IssuedSession<StaffAuthResponse>> {
    const staff = await this.prisma.staff.findUnique({
      where: { id: actor.id },
      select: { ...STAFF_SESSION_SELECT, passwordHash: true },
    });

    // The guard has just read this row; this covers a delete in between.
    if (staff === null) {
      throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);
    }

    if (!(await this.passwordMatches(staff, request.currentPassword))) {
      // A different sentence from sign-in's, safely: the caller has proved
      // which account is theirs, so the only thing this tells them is which
      // field they got wrong.
      throw new UnauthorizedException(CURRENT_PASSWORD_INCORRECT_MESSAGE);
    }

    // The current password in any form it is accepted in: a temporary
    // password typed loosely as the "new" one is still the same password.
    if (
      request.newPassword === request.currentPassword ||
      (await this.passwordMatches(staff, request.newPassword))
    ) {
      throw new BadRequestException(SAME_PASSWORD_MESSAGE);
    }

    // Hashed before the transaction opens: argon2id is slow on purpose, and
    // a transaction should not hold its row lock across it.
    const passwordHash = await hashPassword(request.newPassword);

    await this.prisma.$transaction(async (tx) => {
      // The new password and the end of the old sessions commit together.
      // A new password with the old sessions alive is the state that must
      // never exist: whoever knew the old one may already be signed in.
      await this.tokens.revokeAllForSubject(staff.id, SubjectType.STAFF, tx);

      await tx.staff.update({
        where: { id: staff.id },
        data: { passwordHash, mustChangePassword: false },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'staff.changePassword',
          ref: staff.staffNo,
          before: { mustChangePassword: staff.mustChangePassword },
          after: { mustChangePassword: false },
          ipAddress,
        },
        tx,
      );
    });

    return this.issueSession({ ...staff, mustChangePassword: false });
  }

  /**
   * An Owner or a manager resets another account's password (TAY's admin
   * reset, plan §5.4).
   *
   * A new random password replaces the old at once, the account must change
   * it at first sign-in, and every session it holds ends. Staff rows are
   * never deleted and passwords cannot be read back, so without this a
   * forgotten password is permanent.
   *
   * TAY emails the new password inside the transaction; CNC returns it to
   * the caller once, for handing over in person
   * (`TemporaryPasswordResponse`, `generateTemporaryPassword`).
   *
   * The target is locked while the rules are checked, so a role change that
   * lands at the same moment cannot slip a Manager account past the
   * Owner-only rule.
   */
  async resetPassword(
    actor: StaffPrincipal,
    targetId: string,
    ipAddress: string,
  ): Promise<TemporaryPasswordResponse> {
    if (targetId === actor.id) {
      throw new ForbiddenException(OWN_PASSWORD_RESET_MESSAGE);
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    await this.prisma.$transaction(async (tx) => {
      const [target] = await tx.$queryRaw<
        { role: StaffRole; staffNo: string; mustChangePassword: boolean }[]
      >`
        SELECT "role", "staffNo", "mustChangePassword"
          FROM "Staff" WHERE "id" = ${targetId} FOR UPDATE`;

      if (target === undefined) {
        throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
      }

      // The demo's `staff.save` rule: resetting a manager's password is
      // taking over their account until they change it.
      this.money.mayChangeAccount(actor, { currentRole: target.role });

      await this.tokens.revokeAllForSubject(targetId, SubjectType.STAFF, tx);

      await tx.staff.update({
        where: { id: targetId },
        data: { passwordHash, mustChangePassword: true },
      });

      // Never the password: it is returned once and recorded nowhere.
      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'staff.resetPassword',
          ref: target.staffNo,
          before: { mustChangePassword: target.mustChangePassword },
          after: { mustChangePassword: true },
          ipAddress,
        },
        tx,
      );
    });

    return { temporaryPassword };
  }

  /** A token pair for a row, and the summary built from it field by field. */
  private async issueSession(
    staff: StaffSessionRow,
  ): Promise<IssuedSession<StaffAuthResponse>> {
    const summary: StaffSummaryResponse = {
      id: staff.id,
      staffNo: staff.staffNo,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      mustChangePassword: staff.mustChangePassword,
    };

    const { accessToken, refreshToken } = await this.tokens.issueTokenPair(
      staff.id,
      SubjectType.STAFF,
    );

    return { body: { accessToken, staff: summary }, refreshToken };
  }

  private decoy(): Promise<string> {
    this.decoyHash ??= hashPassword(generateTemporaryPassword());

    return this.decoyHash;
  }

  /**
   * Whether `typed` is the account's password. An account still on a
   * temporary password (`mustChangePassword`) also matches it typed loosely
   * (`readTemporaryPassword`): the founder's new staff could not sign in on
   * the iPad with the password read off the PC (2026-11-06). The second
   * verification runs whenever the text reads as a temporary password,
   * whatever the account, so how long a refusal takes never says which
   * accounts are on one.
   */
  private async passwordMatches(
    staff: { passwordHash: string; mustChangePassword: boolean },
    typed: string,
  ): Promise<boolean> {
    if (await verifyPassword(staff.passwordHash, typed)) return true;

    const read = readTemporaryPassword(typed);

    if (read === null || read === typed) return false;

    const matches = await verifyPassword(staff.passwordHash, read);

    return matches && staff.mustChangePassword;
  }
}
