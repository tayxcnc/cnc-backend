import type { StaffRole } from '../../generated/cnc-client';

/**
 * The signed-in staff member as `CncStaffGuard` read them from the database
 * on this request: who acts (A10, by id, never by name), and the name and
 * role an audit row snapshots.
 *
 * Live, never from the token: the token carries only the subject's id. A
 * role changed or an account renamed a minute ago is what a command sees.
 */
export interface StaffPrincipal {
  /** Staff.id: the actor of every command (A10). */
  id: string;
  staffNo: string;
  name: string;
  role: StaffRole;
}

/** The request property the guard writes the principal to. */
export const STAFF_PRINCIPAL_KEY = 'cncStaff';

/** A request as `CncStaffGuard` leaves it. */
export interface StaffRequest {
  [STAFF_PRINCIPAL_KEY]?: StaffPrincipal;
}
