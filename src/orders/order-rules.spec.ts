import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Department, OrderStatus, StaffRole } from '../../generated/cnc-client';
import {
  BAR_POS_ONLY_MESSAGE,
  ITEM_UNAVAILABLE_MESSAGE,
  NO_OPTIONS_MESSAGE,
  ORDER_LOCKED_MESSAGE,
  PREVIOUS_DAY_MESSAGE,
} from './order-messages';
import {
  assertDepartmentAllowed,
  assertEditable,
  isEditable,
  lineProblem,
  type LineItem,
} from './order-rules';

const TODAY = new Date(Date.UTC(2026, 9, 21));
const YESTERDAY = new Date(Date.UTC(2026, 9, 20));

describe('assertDepartmentAllowed (the demo’s order() Bartender rule)', () => {
  it('lets a Bartender work Bar orders only', () => {
    expect(() =>
      assertDepartmentAllowed(StaffRole.BARTENDER, Department.BAR),
    ).not.toThrow();
    expect(() =>
      assertDepartmentAllowed(StaffRole.BARTENDER, Department.RESTAURANT),
    ).toThrow(new ForbiddenException(BAR_POS_ONLY_MESSAGE));
  });

  it('leaves every other role to its route’s roles', () => {
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.OWNER]) {
      expect(() =>
        assertDepartmentAllowed(role, Department.RESTAURANT),
      ).not.toThrow();
    }
  });
});

describe('assertEditable (the demo’s allowOrder)', () => {
  const refusal = (status: OrderStatus, businessDate: Date) => {
    try {
      assertEditable({ status, businessDate }, TODAY);
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      return (error as ConflictException).message;
    }

    return null;
  };

  it('allows an open order of today', () => {
    expect(
      isEditable({ status: OrderStatus.OPEN, businessDate: TODAY }, TODAY),
    ).toBe(true);
    expect(refusal(OrderStatus.OPEN, TODAY)).toBeNull();
  });

  it('sends an order from an earlier day to a new order', () => {
    expect(refusal(OrderStatus.OPEN, YESTERDAY)).toBe(PREVIOUS_DAY_MESSAGE);
    expect(refusal(OrderStatus.PAYMENT, YESTERDAY)).toBe(PREVIOUS_DAY_MESSAGE);
  });

  it('locks any other order of today until a manager reopens it', () => {
    for (const status of [
      OrderStatus.PAYMENT,
      OrderStatus.SETTLED,
      OrderStatus.CANCELLED,
    ]) {
      expect(refusal(status, TODAY)).toBe(ORDER_LOCKED_MESSAGE);
    }
  });
});

describe('lineProblem (order.quantity’s item and option rules)', () => {
  const pancakes: LineItem = {
    name: 'Pancakes',
    department: Department.RESTAURANT,
    active: true,
    choiceLabel: 'Style',
    choiceOptions: ['Suya beef', 'Sweet with Plateau honey'],
  };
  const jollof: LineItem = {
    name: 'Jollof Rice',
    department: Department.RESTAURANT,
    active: true,
    choiceLabel: null,
    choiceOptions: [],
  };

  it('needs one of a dish’s options, in the demo’s words', () => {
    expect(lineProblem(pancakes, Department.RESTAURANT, '', 1)).toBe(
      'Choose style for Pancakes.',
    );
    expect(lineProblem(pancakes, Department.RESTAURANT, 'Nonsense', 1)).toBe(
      'Choose style for Pancakes.',
    );
    expect(
      lineProblem(pancakes, Department.RESTAURANT, 'Suya beef', 2),
    ).toBeNull();
  });

  it('refuses an option on a dish that has none', () => {
    expect(lineProblem(jollof, Department.RESTAURANT, 'Medium', 1)).toBe(
      NO_OPTIONS_MESSAGE,
    );
    expect(lineProblem(jollof, Department.RESTAURANT, '', 1)).toBeNull();
  });

  it('refuses a missing dish, the other department’s, or one off sale', () => {
    expect(lineProblem(null, Department.RESTAURANT, '', 1)).toBe(
      ITEM_UNAVAILABLE_MESSAGE,
    );
    expect(lineProblem(jollof, Department.BAR, '', 1)).toBe(
      ITEM_UNAVAILABLE_MESSAGE,
    );
    expect(
      lineProblem({ ...jollof, active: false }, Department.RESTAURANT, '', 1),
    ).toBe(ITEM_UNAVAILABLE_MESSAGE);
  });

  it('always lets a line go to zero, whatever the option or the dish’s state', () => {
    expect(
      lineProblem({ ...pancakes, active: false }, Department.RESTAURANT, '', 0),
    ).toBeNull();
    expect(lineProblem(null, Department.RESTAURANT, '', 0)).toBe(
      ITEM_UNAVAILABLE_MESSAGE,
    );
  });
});
