import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Department, OrderStatus, StaffRole } from '../../generated/cnc-client';
import {
  BAR_POS_ONLY_MESSAGE,
  chooseOptionMessage,
  ITEM_UNAVAILABLE_MESSAGE,
  NO_OPTIONS_MESSAGE,
  ORDER_LOCKED_MESSAGE,
  PREVIOUS_DAY_MESSAGE,
} from './order-messages';

/**
 * The till's rules that need no database, ported from the demo's
 * `execute()` helpers (`order()`, `allowOrder`, `editable`, and the
 * option check of `order.quantity`). Pure, so a unit test pins each
 * sentence and its order.
 */

/**
 * The demo's `order()` Bartender rule: a Bartender works the Bar POS only,
 * so a Restaurant order (or department) is refused with 403 and its
 * sentence. Every other role passes; their route's `@Roles` decided the
 * rest.
 */
export function assertDepartmentAllowed(
  role: StaffRole,
  department: Department,
): void {
  if (role === StaffRole.BARTENDER && department !== Department.BAR) {
    throw new ForbiddenException(BAR_POS_ONLY_MESSAGE);
  }
}

/** The demo's `editable(o, now)`: open, and opened on today's business date. */
export function isEditable(
  order: { status: OrderStatus; businessDate: Date },
  today: Date,
): boolean {
  return (
    order.status === OrderStatus.OPEN &&
    order.businessDate.getTime() === today.getTime()
  );
}

/**
 * The demo's `allowOrder` refusal: lines, details and the guest change only
 * on an open order of today. An order from an earlier date is told to start
 * a new order (food added on a previous day is locked, plan §7.1 step 7);
 * any other order is locked until a manager reopens it. 409: the request is
 * well formed and the order's state refuses it (A7).
 */
export function assertEditable(
  order: { status: OrderStatus; businessDate: Date },
  today: Date,
): void {
  if (isEditable(order, today)) return;

  throw new ConflictException(
    order.businessDate.getTime() !== today.getTime()
      ? PREVIOUS_DAY_MESSAGE
      : ORDER_LOCKED_MESSAGE,
  );
}

/** The menu item fields `order.quantity` judges a line by. */
export interface LineItem {
  name: string;
  department: Department;
  active: boolean;
  choiceLabel: string | null;
  choiceOptions: readonly string[];
}

/**
 * What is wrong with setting a dish to `qty` with `option` on an order of
 * `department`, in the demo's order, or null:
 *
 * 1. the dish is missing, belongs to the other department, or is not
 *    Available for Sale (a line may always be set to zero, so a dish taken
 *    off sale can still be removed from a bill);
 * 2. for a quantity above zero, a dish with a choice needs one of its
 *    options, and a dish without one takes no option.
 */
export function lineProblem(
  item: LineItem | null,
  department: Department,
  option: string,
  qty: number,
): string | null {
  if (
    item === null ||
    item.department !== department ||
    (!item.active && qty !== 0)
  ) {
    return ITEM_UNAVAILABLE_MESSAGE;
  }

  if (qty === 0) return null;

  if (item.choiceOptions.length > 0) {
    return item.choiceOptions.includes(option)
      ? null
      : chooseOptionMessage(item.choiceLabel ?? 'an option', item.name);
  }

  return option === '' ? null : NO_OPTIONS_MESSAGE;
}
