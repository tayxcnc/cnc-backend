import { Injectable } from '@nestjs/common';
import { AuditActorKind, Prisma } from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { auditModule } from './audit-sentences';

/**
 * Who acted. A staff member is the live principal `CncStaffGuard` read on
 * the request (A10: by id; the name and role are snapshotted on the row so
 * it reads the same after a rename or a role change). A customer arrives
 * with C6; `SYSTEM` is a scheduled job or a webhook, named for display.
 */
export type AuditActor =
  | { kind: 'STAFF'; staff: Pick<StaffPrincipal, 'id' | 'name' | 'role'> }
  | { kind: 'CUSTOMER'; customerId: string; name: string }
  | { kind: 'SYSTEM'; name: string };

/** The usual actor: the signed-in staff member. */
export function staffActor(
  staff: Pick<StaffPrincipal, 'id' | 'name' | 'role'>,
): AuditActor {
  return { kind: 'STAFF', staff };
}

/**
 * One audit row: who did what to which record, and what changed.
 *
 * - `action` is the command's name, as the staff app spells it
 *   (`order.settle`, `staff.save`); the module is derived from it here,
 *   never passed in, so a row cannot be filed under the wrong screen.
 * - `ref` is the record's human reference, the one the screens show and
 *   filter by: an order or purchase number, a `KOT-` ref, a staff number,
 *   a menu item's slug. `GET /staff/audit?ref=` matches it exactly.
 * - `before` and `after` are plain JSON the sentences are built from.
 *   They are never returned raw (A13), and must never hold a credential:
 *   {@link AuditService.record} refuses a row that carries one. Write a
 *   business date as `YYYY-MM-DD`.
 * - `ipAddress` is `clientAddressOf(request)`, evidence rather than proof.
 */
export interface AuditEntry {
  actor: AuditActor;
  action: string;
  ref?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  channel?: string | null;
  ipAddress?: string | null;
}

/**
 * Keys that name a credential. A row whose `before` or `after` holds one at
 * any depth is refused: a password hash, a QR token or a token of any kind
 * in the append-only log could never be removed again. Exact names only:
 * a broad pattern would refuse a table's `code` (B1, TS1).
 */
const CREDENTIAL_KEYS = new Set([
  'password',
  'passwordHash',
  'temporaryPassword',
  'currentPassword',
  'newPassword',
  'qrToken',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'codeHash',
]);

/**
 * The one writer of `AuditLog` (A13), copied from TAY's `ActivityLogService`
 * and given CNC's actor kinds and snapshots.
 *
 * **It writes through the command's transaction, and the transaction is
 * required.** An audit row committed for a change that rolled back is a
 * false record; a change committed without its row is an invisible one
 * (A6). TAY's writer falls back to the base client; this one has no
 * fallback, so a command cannot forget to pass its transaction.
 *
 * The table is append-only by trigger, so there is nothing here but an
 * insert. `grep -rn "auditLog.create" src/` should find only this file.
 */
@Injectable()
export class AuditService {
  async record(entry: AuditEntry, tx: Prisma.TransactionClient): Promise<void> {
    const before = toJson(entry.before);
    const after = toJson(entry.after);

    assertNoCredentials(before, 'before');
    assertNoCredentials(after, 'after');

    const { actor } = entry;

    await tx.auditLog.create({
      data: {
        actorKind: AuditActorKind[actor.kind],
        staffId: actor.kind === 'STAFF' ? actor.staff.id : null,
        customerId: actor.kind === 'CUSTOMER' ? actor.customerId : null,
        actorName: actor.kind === 'STAFF' ? actor.staff.name : actor.name,
        actorRole: actor.kind === 'STAFF' ? actor.staff.role : null,
        action: entry.action,
        module: auditModule(entry.action),
        ref: entry.ref ?? null,
        before: before === null ? Prisma.DbNull : before,
        after: after === null ? Prisma.DbNull : after,
        reason: blankToNull(entry.reason),
        channel: entry.channel ?? null,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  }
}

/** A value as it will be stored: Dates as ISO strings, `undefined` gone. */
function toJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue | null;
}

function assertNoCredentials(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentials(item, where);
    return;
  }

  if (value === null || typeof value !== 'object') return;

  for (const [key, inner] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key)) {
      // A programming error, so a 500 that names the field and never the
      // value: the command rolls back rather than write the credential.
      throw new Error(
        `An audit row's ${where} carries the credential field "${key}". ` +
          'Leave it out of the audit entry.',
      );
    }

    assertNoCredentials(inner, where);
  }
}

function blankToNull(text: string | null | undefined): string | null {
  const trimmed = text?.trim();

  return trimmed ? trimmed : null;
}
