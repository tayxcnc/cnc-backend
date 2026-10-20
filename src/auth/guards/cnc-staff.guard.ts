import {
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { type StaffRole, SubjectType } from '../../../generated/cnc-client';
import { CncPrismaService } from '../../prisma/cnc-prisma.service';
import type { CncTokenPayload } from '../cnc-token.service';
import { PASSWORD_CHANGE_EXEMPT_KEY } from '../decorators/password-change-exempt.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import {
  STAFF_PRINCIPAL_KEY,
  type StaffPrincipal,
  type StaffRequest,
} from '../staff-principal';
import { ROLE_REFUSED_MESSAGE, roleMayRun } from '../staff-roles';
import { CNC_JWT_STRATEGY } from '../strategies/cnc-jwt.strategy';

/**
 * The refusal for a deactivated staff account, on every staff route (403).
 *
 * The demo has no sign-in, so it has no sentence for this. The plan's C3
 * gate quotes its opening ("This staff account has been deactivated…"), and
 * the close is in the demo's own voice ("Ask the manager if you need
 * access."). The staff app signs the person out when it sees it (plan §14).
 */
export const STAFF_DEACTIVATED_MESSAGE =
  'This staff account has been deactivated. Ask the Owner or a manager if ' +
  'you believe this is a mistake.';

/**
 * The refusal while `mustChangePassword` is true (403), on every staff route
 * but the exempt ones. It names the action, because the caller can clear it
 * themselves in one request.
 */
export const PASSWORD_CHANGE_REQUIRED_MESSAGE =
  'Change your password before you continue.';

/** A valid customer token on a staff route (403, not 401). */
export const CUSTOMER_TOKEN_ON_STAFF_ROUTE_MESSAGE =
  'This route is for staff. The token presented is a customer token.';

/** A valid token whose staff row is gone (401). */
export const ACCOUNT_GONE_MESSAGE =
  'The account this token was issued to no longer exists.';

/**
 * Staff tokens only, from accounts that are still active, composed with
 * `@Roles()` and `@PasswordChangeExempt()`. Copied from TAY's
 * `TayStaffGuard`.
 *
 * ## The row is read on every request (A14)
 *
 * `isActive`, `mustChangePassword` and the role come from the database on
 * every request, in one primary-key lookup. A deactivation or a role change
 * takes effect on the next request, not when a fifteen-minute token
 * expires: an answer to "this person no longer works here" that waits for
 * the token is advisory. The token carries no role at all.
 *
 * ## Status codes
 *
 * - **401**: no token, a bad signature (a TAY token included), an expired
 *   token, or a token whose staff row no longer exists. Signing in again is
 *   the honest instruction.
 * - **403**: a valid customer token (the caller is known and simply not
 *   staff; a 401 would send a valid client into a re-login loop), a
 *   deactivated account, a pending forced password change, or a role that
 *   may not run the route.
 *
 * The principal it read (`StaffPrincipal`) is left on the request for
 * `@CurrentStaff()`, so a handler acts as the role the row holds now.
 */
@Injectable()
export class CncStaffGuard extends AuthGuard(CNC_JWT_STRATEGY) {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: CncPrismaService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Signature, expiry and payload shape. Throws 401 on any failure.
    await super.canActivate(context);

    const request = context
      .switchToHttp()
      .getRequest<StaffRequest & { user: CncTokenPayload }>();

    if (request.user.type !== SubjectType.STAFF) {
      throw new ForbiddenException(CUSTOMER_TOKEN_ON_STAFF_ROUTE_MESSAGE);
    }

    const principal = await this.assertAccountUsable(request.user.sub, context);

    const allowed = this.reflector.getAllAndOverride<StaffRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles at all: any active staff member. @Roles() with an empty
    // list still means managers only, so the check runs whenever the
    // metadata is present.
    if (allowed !== undefined && !roleMayRun(principal.role, allowed)) {
      throw new ForbiddenException(ROLE_REFUSED_MESSAGE);
    }

    request[STAFF_PRINCIPAL_KEY] = principal;

    return true;
  }

  /**
   * Read the live account, refuse it if it may not be here, and return the
   * principal. The select names exactly what the guard needs: it runs on
   * every staff request and has no business holding a password hash or a
   * QR token.
   */
  private async assertAccountUsable(
    staffId: string,
    context: ExecutionContext,
  ): Promise<StaffPrincipal> {
    const staff = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: {
        id: true,
        staffNo: true,
        name: true,
        role: true,
        isActive: true,
        mustChangePassword: true,
      },
    });

    // 401, not 403: there is nobody to refuse. Staff rows are never
    // deleted in normal operation, so the token outlived its subject.
    if (staff === null) {
      throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);
    }

    if (!staff.isActive) {
      throw new ForbiddenException(STAFF_DEACTIVATED_MESSAGE);
    }

    const exempt = this.reflector.getAllAndOverride<boolean | undefined>(
      PASSWORD_CHANGE_EXEMPT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (staff.mustChangePassword && exempt !== true) {
      throw new ForbiddenException(PASSWORD_CHANGE_REQUIRED_MESSAGE);
    }

    return {
      id: staff.id,
      staffNo: staff.staffNo,
      name: staff.name,
      role: staff.role,
    };
  }
}
