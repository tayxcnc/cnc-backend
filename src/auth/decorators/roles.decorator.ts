import { SetMetadata } from '@nestjs/common';
import type { StaffRole } from '../../../generated/cnc-client';

export const ROLES_KEY = 'cnc:roles';

/**
 * Restrict a staff route by role, with the demo's `requireRole` meaning
 * (plan §6.2): **managers (the Owner and Managers) always pass**, and so does
 * every role listed. `@Roles()` with no roles is "M", managers only;
 * `@Roles(StaffRole.CASHIER, StaffRole.BARTENDER)` is "R(Cashier,
 * Bartender)". A route with no `@Roles` at all is open to every active staff
 * member.
 *
 * The refusal is 403 with the demo's sentence, "Your current staff role
 * cannot perform this action." Owner-only rules ("O") are not roles here:
 * they carry their own sentences ("Only the Owner can …") and live with the
 * money controls (C3-4) and the staff rules.
 *
 * Composes with `CncStaffGuard`, which reads this metadata; the decorator on
 * its own enforces nothing.
 *
 * @example
 *   @Roles(StaffRole.RECEPTION)
 *   @UseGuards(CncStaffGuard)
 *   checkIn() {}
 */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);
