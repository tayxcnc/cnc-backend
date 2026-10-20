import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  STAFF_PRINCIPAL_KEY,
  type StaffPrincipal,
  type StaffRequest,
} from '../staff-principal';

/**
 * The signed-in staff member, as `CncStaffGuard` read them on this request
 * (TAY's `@CurrentUser`, narrowed to staff and to the live row).
 *
 * Only meaningful behind `CncStaffGuard`. Used without it there is no
 * principal, and that is a wiring mistake, so it fails loudly as a 500
 * rather than handing a handler `undefined` to treat as an actor.
 *
 * @example
 *   settle(@CurrentStaff() actor: StaffPrincipal) {}
 */
export const CurrentStaff = createParamDecorator(
  (_data: unknown, context: ExecutionContext): StaffPrincipal => {
    const request = context.switchToHttp().getRequest<StaffRequest>();
    const principal = request[STAFF_PRINCIPAL_KEY];

    if (principal === undefined) {
      throw new InternalServerErrorException();
    }

    return principal;
  },
);
