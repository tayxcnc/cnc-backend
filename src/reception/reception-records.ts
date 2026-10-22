import { type Prisma, TableSessionStatus } from '../../generated/cnc-client';
import { formatIsoDate } from '../common/calendar-date';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import type {
  ReservationResponse,
  TableSessionResponse,
} from './dto/reception.response';
import { isReminderDue } from './free-table-reminder';
import { clockText, tableRef } from './reservation-rules';

/**
 * Reception's shared reads and shapes: a table with its room, a booking and
 * a seating as the API answers them, and the per-table lock every table
 * and booking command takes.
 *
 * Inside a command's transaction, a row's relations are read with separate
 * queries awaited in turn, never a nested `select` (*Data and
 * migrations*), so these readers take one client and ask it one question
 * at a time.
 */

type Tx = Prisma.TransactionClient;

/** The client a reader runs on: the base client or a command's transaction. */
export type Reader = Pick<
  Tx,
  'diningTable' | 'venue' | 'reservation' | 'tableSession' | 'staff'
>;

/**
 * The advisory-lock namespace for a table, hashed into the first key of
 * the two-key form (as `MoneyControlService`'s and the kitchen day's are).
 */
const TABLE_LOCK = 'cnc:table';

/**
 * Take each table's advisory lock, in id order, for the rest of the
 * transaction.
 *
 * Every command that books, seats, locks, checks in at or frees a table
 * takes it first, so the checks that span two kinds of row (a booking for
 * today against the guests seated now, a walk-in against today's
 * booking) cannot both pass for two commands at once: no index spans a
 * booking and a seating. The partial unique indexes still decide a clash
 * within one kind, whatever path wrote it. Id order means a booking moved
 * between two tables cannot deadlock a command on either.
 */
export async function lockTables(
  tx: Pick<Tx, '$executeRaw'>,
  tableIds: readonly string[],
): Promise<void> {
  for (const id of [...new Set(tableIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext(${TABLE_LOCK}), hashtext(${id}))`;
  }
}

/**
 * A clash on `TableSession_tableId_key`, the one open seating per table
 * (plan §4.5), read by its field through `uniqueViolationTargets`.
 */
export function isTableSessionClash(error: unknown): boolean {
  const targets = uniqueViolationTargets(error);

  return targets.length === 1 && targets[0] === 'tableId';
}

/** A table with what its room says about it. */
export interface TableInfo {
  id: string;
  ref: string;
  code: string;
  name: string;
  capacity: number;
  active: boolean;
  venueSlug: string;
  venueName: string;
  bigParty: number;
}

/** A table and its room, or null when there is no such table. */
export async function readTable(
  client: Pick<Tx, 'diningTable' | 'venue'>,
  id: string,
): Promise<TableInfo | null> {
  const table = await client.diningTable.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      name: true,
      capacity: true,
      active: true,
      venueId: true,
    },
  });

  if (table === null) return null;

  const venue = await client.venue.findUniqueOrThrow({
    where: { id: table.venueId },
    select: { slug: true, staffName: true, bigParty: true },
  });

  return {
    id: table.id,
    ref: tableRef(venue.staffName, table.code),
    code: table.code,
    name: table.name,
    capacity: table.capacity,
    active: table.active,
    venueSlug: venue.slug,
    venueName: venue.staffName,
    bigParty: venue.bigParty,
  };
}

/** The columns a booking is answered from. */
export const RESERVATION_COLUMNS = {
  id: true,
  number: true,
  tableId: true,
  customerId: true,
  name: true,
  phone: true,
  email: true,
  businessDate: true,
  startMinutes: true,
  party: true,
  status: true,
  source: true,
  note: true,
  depositKobo: true,
  depositUsedKobo: true,
  cancelledAt: true,
  createdAt: true,
  version: true,
} satisfies Prisma.ReservationSelect;

export type ReservationRow = Prisma.ReservationGetPayload<{
  select: typeof RESERVATION_COLUMNS;
}>;

/** A booking as the API answers it. */
export function reservationResponse(
  row: ReservationRow,
  table: Pick<TableInfo, 'ref' | 'name' | 'venueSlug' | 'venueName'>,
): ReservationResponse {
  return {
    id: row.id,
    number: row.number,
    tableId: row.tableId,
    tableRef: table.ref,
    tableName: table.name,
    venueSlug: table.venueSlug,
    venueName: table.venueName,
    customerId: row.customerId,
    name: row.name,
    phone: row.phone,
    email: row.email,
    businessDate: formatIsoDate(row.businessDate),
    time: clockText(row.startMinutes),
    startMinutes: row.startMinutes,
    party: row.party,
    status: row.status,
    source: row.source,
    note: row.note,
    depositKobo: row.depositKobo,
    depositUsedKobo: row.depositUsedKobo,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** One booking, read in turn with its table (404 is the caller's). */
export async function readReservation(
  client: Reader,
  id: string,
): Promise<ReservationResponse> {
  const row = await client.reservation.findUniqueOrThrow({
    where: { id },
    select: RESERVATION_COLUMNS,
  });
  const table = await readTable(client, row.tableId);

  return reservationResponse(row, table!);
}

/** The columns a seating is answered from. */
export const SESSION_COLUMNS = {
  id: true,
  tableId: true,
  status: true,
  guest: true,
  party: true,
  note: true,
  since: true,
  endedAt: true,
  reservationId: true,
  openedById: true,
  version: true,
} satisfies Prisma.TableSessionSelect;

export type SessionRow = Prisma.TableSessionGetPayload<{
  select: typeof SESSION_COLUMNS;
}>;

/** A seating as the API answers it. */
export function sessionResponse(
  row: SessionRow,
  table: Pick<TableInfo, 'ref' | 'name'>,
  openedByName: string,
  reminderMinutes: number,
  now: Date,
): TableSessionResponse {
  return {
    id: row.id,
    tableId: row.tableId,
    tableRef: table.ref,
    tableName: table.name,
    status: row.status,
    guest: row.guest,
    party: row.party,
    note: row.note,
    since: row.since.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    reservationId: row.reservationId,
    openedByName,
    reminderDue:
      row.endedAt === null &&
      row.status === TableSessionStatus.OCCUPIED &&
      isReminderDue(row.since, now, reminderMinutes),
    version: row.version,
  };
}

/** One seating, read in turn with its table and who opened it. */
export async function readSession(
  client: Reader & Pick<Tx, 'settings'>,
  id: string,
  now: Date,
): Promise<TableSessionResponse> {
  const row = await client.tableSession.findUniqueOrThrow({
    where: { id },
    select: SESSION_COLUMNS,
  });
  const table = await readTable(client, row.tableId);
  const staff = await client.staff.findUniqueOrThrow({
    where: { id: row.openedById },
    select: { name: true },
  });
  const settings = await client.settings.findUniqueOrThrow({
    where: { singleton: true },
    select: { freeTableReminderMinutes: true },
  });

  return sessionResponse(
    row,
    table!,
    staff.name,
    settings.freeTableReminderMinutes,
    now,
  );
}
