import { nextSequenceCode } from './sequence-code';
import type { CncPrismaService } from './cnc-prisma.service';

/**
 * Every human-number sequence, with the prefix and digit count it prints
 * (plan §4, "Sequences"; A12).
 *
 * The one list. Each sequence is created by the C3 core migration
 * (`20261020223514_c3_core`), and a unit test holds the two in step: a name
 * here that no migration creates fails at the first draw, and that test
 * fails first.
 *
 * Callers draw by the key, never by spelling a sequence name or a prefix at
 * the call site, so the format of a number has one home and two call sites
 * cannot print the same kind of record two ways.
 *
 * `minDigits` is a floor (see `nextSequenceCode`): `CNC-S999` is followed by
 * `CNC-S1000`. Staff numbers have 3 digits, every other number 6.
 */
export const SEQUENCES = {
  /** A Restaurant order, from the till or the web (D29). */
  orderRestaurant: {
    sequence: 'order_restaurant_no_seq',
    prefix: 'CNCR-',
    minDigits: 6,
  },
  /** A Bar order (D29). */
  orderBar: { sequence: 'order_bar_no_seq', prefix: 'CNCB-', minDigits: 6 },
  /** An online order, drawn only when its payment is confirmed. */
  onlineOrder: {
    sequence: 'online_order_no_seq',
    prefix: 'WEB-',
    minDigits: 6,
  },
  payment: { sequence: 'payment_no_seq', prefix: 'PAY-', minDigits: 6 },
  cashCount: { sequence: 'cash_count_no_seq', prefix: 'CASH-', minDigits: 6 },
  reservation: {
    sequence: 'reservation_no_seq',
    prefix: 'RSV-',
    minDigits: 6,
  },
  stockRequest: {
    sequence: 'stock_request_no_seq',
    prefix: 'SR-',
    minDigits: 6,
  },
  purchase: { sequence: 'purchase_no_seq', prefix: 'PR-', minDigits: 6 },
  waste: { sequence: 'waste_no_seq', prefix: 'W-', minDigits: 6 },
  task: { sequence: 'task_no_seq', prefix: 'T-', minDigits: 6 },
  maintenance: {
    sequence: 'maintenance_no_seq',
    prefix: 'MT-',
    minDigits: 6,
  },
  /** `Staff.staffNo`, `CNC-S001` (D44). */
  staff: { sequence: 'staff_no_seq', prefix: 'CNC-S', minDigits: 3 },
  /** `Customer.memberNo`, `CNC-000001`. */
  customer: {
    sequence: 'customer_member_no_seq',
    prefix: 'CNC-',
    minDigits: 6,
  },
} as const satisfies Record<
  string,
  { sequence: string; prefix: string; minDigits: number }
>;

export type SequenceName = keyof typeof SEQUENCES;

/**
 * Draw the next human number of a kind: `drawNumber(tx, 'orderBar')` →
 * `CNCB-000044`.
 *
 * Pass the command's transaction client when there is one. `nextval` is not
 * rolled back with the transaction (the number is burned either way), but
 * drawing through the same client keeps the command on one connection, which
 * matters on a pool of three.
 */
export function drawNumber(
  prisma: Pick<CncPrismaService, '$queryRawUnsafe'>,
  name: SequenceName,
): Promise<string> {
  const { sequence, prefix, minDigits } = SEQUENCES[name];

  return nextSequenceCode(prisma, sequence, prefix, minDigits);
}
