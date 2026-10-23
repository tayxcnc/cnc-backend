import {
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SubjectType } from '../../../generated/cnc-client';
import { CncPrismaService } from '../../prisma/cnc-prisma.service';
import type { CncTokenPayload } from '../cnc-token.service';
import {
  CUSTOMER_PRINCIPAL_KEY,
  type CustomerRequest,
} from '../customer-principal';
import { CNC_JWT_STRATEGY } from '../strategies/cnc-jwt.strategy';
import { ACCOUNT_GONE_MESSAGE } from './cnc-staff.guard';

/** A valid staff token on a customer route (403, not 401). */
export const STAFF_TOKEN_ON_CUSTOMER_ROUTE_MESSAGE =
  'This route is for customers. The token presented is a staff token.';

/**
 * Customer tokens only, from customers whose row still exists: the
 * customer realm's guard, the mirror of `CncStaffGuard` (plan §5: "C").
 *
 * The two realms share one signing secret and one token shape, told apart
 * by the token's `type`, which only CNC's own signer writes. So a staff
 * token here is a known caller in the wrong place: 403, as a customer token
 * on a staff route is, never 401, which would send a valid client into a
 * re-login loop. A TAY token fails the signature: 401.
 *
 * The row is read on every request, so a customer whose account is
 * deleted (Q36: `deletedAt` set and the row anonymised) is refused on
 * their next request rather than when the fifteen-minute token expires:
 * 401, because there is nobody left to refuse.
 */
@Injectable()
export class CncCustomerGuard extends AuthGuard(CNC_JWT_STRATEGY) {
  constructor(private readonly prisma: CncPrismaService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Signature, expiry and payload shape. Throws 401 on any failure.
    await super.canActivate(context);

    const request = context
      .switchToHttp()
      .getRequest<CustomerRequest & { user: CncTokenPayload }>();

    if (request.user.type !== SubjectType.CUSTOMER) {
      throw new ForbiddenException(STAFF_TOKEN_ON_CUSTOMER_ROUTE_MESSAGE);
    }

    const customer = await this.prisma.customer.findFirst({
      where: { id: request.user.sub, deletedAt: null },
      select: { id: true, memberNo: true },
    });

    if (customer === null) {
      throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);
    }

    request[CUSTOMER_PRINCIPAL_KEY] = customer;

    return true;
  }
}
