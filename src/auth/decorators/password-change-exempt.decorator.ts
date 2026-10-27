import { SetMetadata } from '@nestjs/common';

export const PASSWORD_CHANGE_EXEMPT_KEY = 'cnc:password-change-exempt';

/**
 * Let a staff route through while `mustChangePassword` is still true, copied
 * from TAY. Composes with `CncStaffGuard`; on its own it enforces nothing.
 *
 * Three routes carry it, and the list should stay that short:
 * - `POST /auth/staff/change-password`, the route that clears the flag;
 * - `GET /staff/me` (C3-8), so a reload can tell the app who must change
 *   their password and route them there instead of to the sign-in screen;
 * - `POST /auth/staff/sign-out`, added for CNC: it only ever ends sessions,
 *   and a person handed a temporary password at a shared till must be able
 *   to leave without first choosing a new one. TAY's sign-out is not exempt.
 *
 * The exemption covers the forced change and nothing else: the guard's type,
 * existence and deactivation checks still run. A route that "must" work
 * before the change is a question about why the change was forced.
 */
export const PasswordChangeExempt = () =>
  SetMetadata(PASSWORD_CHANGE_EXEMPT_KEY, true);
