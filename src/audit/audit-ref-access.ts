import { Injectable } from '@nestjs/common';
import type { StaffPrincipal } from '../auth/staff-principal';

/**
 * Says whether a staff member may read one kind of record, by its human
 * reference. Registered by the module that owns the records (orders,
 * dockets, requests, purchases, waste, online orders, tasks), because only
 * that module knows the row filters plan §6.1 puts on its reads: a
 * Bartender sees Bar orders only, a Kitchen user their own location's
 * waste, anyone the tasks assigned to or raised by them.
 */
export interface AuditRefReader {
  /** True when refs of this shape belong to this reader: `/^CNCB-/`. */
  owns(ref: string): boolean;
  /** Whether `viewer` may read the record `ref` names, under §6.1. */
  mayRead(viewer: StaffPrincipal, ref: string): Promise<boolean>;
}

/**
 * Which records a non-manager may read the history of (plan §4.8).
 *
 * A Reception, Cashier, Waiter, Bartender, Kitchen or Storekeeper user may
 * call `GET /staff/audit` only with a `ref` they can read under §6.1, and
 * the record's own module answers that through an {@link AuditRefReader}
 * registered here, typically in its `onModuleInit`.
 *
 * **It fails closed.** A ref no reader owns is unreadable, so a record
 * whose module registers no reader (attendance, by plan §4.8) has no
 * history a non-manager can read.
 * Managers and the Owner never come here; their rule is the actor filter.
 */
@Injectable()
export class AuditRefAccess {
  private readonly readers: AuditRefReader[] = [];

  register(reader: AuditRefReader): void {
    this.readers.push(reader);
  }

  async mayRead(viewer: StaffPrincipal, ref: string): Promise<boolean> {
    const reader = this.readers.find((candidate) => candidate.owns(ref));

    return reader === undefined ? false : reader.mayRead(viewer, ref);
  }
}
