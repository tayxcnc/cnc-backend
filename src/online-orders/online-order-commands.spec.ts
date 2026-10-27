import {
  AddressZone,
  Department,
  Fulfilment,
  OnlineFulfilmentStatus as S,
  OnlineOrderMode as Mode,
} from '../../generated/cnc-client';
import { lineProblem } from '../common/command-lines';
import {
  EDIT_MENU_ITEM_MESSAGE,
  INVALID_FULFILMENT_STATUS_MESSAGE,
  NEXT_STAGE_MESSAGE,
  STATUS_MODE_MESSAGE,
} from './online-order-messages';
import {
  barDifference,
  completedStatus,
  correctStatusProblem,
  editLineProblem,
  fulfilmentPath,
  isClosed,
  modeFulfilment,
  modeZone,
  nextStageProblem,
  onlineTargetKobo,
  zoneFeeKobo,
} from './online-order-rules';

/**
 * The demo's `online.*` rules (`staff/lib/domain.ts`, card C7-4), pinned
 * one sentence at a time.
 */
describe('the fulfilment path', () => {
  it('is Paid, Preparing, Out for Delivery, Completed for a delivery', () => {
    expect(fulfilmentPath(Mode.WITHIN_JOS)).toEqual([
      S.RECEIVED,
      S.PREPARING,
      S.ON_THE_WAY,
      S.DELIVERED,
    ]);
    expect(fulfilmentPath(Mode.OUTSIDE_JOS)).toEqual(
      fulfilmentPath(Mode.WITHIN_JOS),
    );
  });

  it('is Paid, Preparing, Ready for Pickup, Completed for a pickup', () => {
    expect(fulfilmentPath(Mode.PICKUP)).toEqual([
      S.RECEIVED,
      S.PREPARING,
      S.READY,
      S.COLLECTED,
    ]);
    expect(completedStatus(Mode.PICKUP)).toBe(S.COLLECTED);
  });

  it('counts completed and cancelled orders as closed', () => {
    expect(isClosed(S.DELIVERED)).toBe(true);
    expect(isClosed(S.COLLECTED)).toBe(true);
    expect(isClosed(S.CANCELLED)).toBe(true);
    expect(isClosed(S.READY)).toBe(false);
  });
});

describe('nextStageProblem (online.status)', () => {
  it('allows the current stage and the next one only', () => {
    expect(nextStageProblem(Mode.WITHIN_JOS, S.RECEIVED, S.RECEIVED)).toBe(
      null,
    );
    expect(nextStageProblem(Mode.WITHIN_JOS, S.RECEIVED, S.PREPARING)).toBe(
      null,
    );
    expect(nextStageProblem(Mode.WITHIN_JOS, S.PREPARING, S.ON_THE_WAY)).toBe(
      null,
    );
    expect(nextStageProblem(Mode.WITHIN_JOS, S.ON_THE_WAY, S.DELIVERED)).toBe(
      null,
    );
  });

  it('refuses a skip, a step back, the other mode’s stage and a non-stage', () => {
    for (const [mode, from, to] of [
      [Mode.WITHIN_JOS, S.RECEIVED, S.DELIVERED],
      [Mode.WITHIN_JOS, S.PREPARING, S.RECEIVED],
      [Mode.WITHIN_JOS, S.PREPARING, S.READY],
      [Mode.PICKUP, S.PREPARING, S.ON_THE_WAY],
      [Mode.PICKUP, S.READY, S.DELIVERED],
      [Mode.PICKUP, S.RECEIVED, 'COMPLETED'],
      [Mode.PICKUP, S.RECEIVED, S.CANCELLED],
    ] as const) {
      expect(nextStageProblem(mode, from, to)).toBe(NEXT_STAGE_MESSAGE);
    }
  });
});

describe('correctStatusProblem (online.correctStatus)', () => {
  it('allows any stage on the order’s own path, backwards included', () => {
    for (const status of fulfilmentPath(Mode.PICKUP)) {
      expect(correctStatusProblem(Mode.PICKUP, status)).toBe(null);
    }
  });

  it('refuses a word that is no stage before one of the other mode', () => {
    expect(correctStatusProblem(Mode.PICKUP, S.CANCELLED)).toBe(
      INVALID_FULFILMENT_STATUS_MESSAGE,
    );
    expect(correctStatusProblem(Mode.PICKUP, 'Paid')).toBe(
      INVALID_FULFILMENT_STATUS_MESSAGE,
    );
    expect(correctStatusProblem(Mode.PICKUP, S.ON_THE_WAY)).toBe(
      STATUS_MODE_MESSAGE,
    );
    expect(correctStatusProblem(Mode.WITHIN_JOS, S.READY)).toBe(
      STATUS_MODE_MESSAGE,
    );
    expect(correctStatusProblem(Mode.WITHIN_JOS, S.COLLECTED)).toBe(
      STATUS_MODE_MESSAGE,
    );
  });
});

describe('the money (the demo’s target, Q21, Q27)', () => {
  it('is the bill plus the fee, and nothing once cancelled', () => {
    expect(
      onlineTargetKobo({
        cancelled: false,
        billTotalKobo: 1075000,
        feeKobo: 500000,
      }),
    ).toBe(1575000);
    expect(
      onlineTargetKobo({ cancelled: true, billTotalKobo: 1, feeKobo: 1 }),
    ).toBe(0);
  });

  it('prices a zone from the fees the order snapshotted', () => {
    const fees = { deliveryJosKobo: 500000, deliveryOutsideKobo: 1000000 };

    expect(zoneFeeKobo(Mode.PICKUP, fees)).toBe(0);
    expect(zoneFeeKobo(Mode.WITHIN_JOS, fees)).toBe(500000);
    expect(zoneFeeKobo(Mode.OUTSIDE_JOS, fees)).toBe(1000000);
    expect(modeZone(Mode.OUTSIDE_JOS)).toBe(AddressZone.PLATEAU);
    expect(modeZone(Mode.PICKUP)).toBe(null);
    expect(modeFulfilment(Mode.WITHIN_JOS)).toBe(Fulfilment.DELIVERY);
  });
});

describe('editLineProblem (online.edit)', () => {
  const plain = {
    name: 'Zobo',
    active: true,
    choiceLabel: null,
    choiceOptions: [],
  };
  const withChoice = {
    name: 'Pancakes',
    active: true,
    choiceLabel: 'Style',
    choiceOptions: ['Sweet', 'Savoury'],
  };

  it('refuses a dish that is not on the menu, or off sale and not held', () => {
    expect(editLineProblem(null, '', false)).toBe(EDIT_MENU_ITEM_MESSAGE);
    expect(editLineProblem({ ...plain, active: false }, '', false)).toBe(
      EDIT_MENU_ITEM_MESSAGE,
    );
    expect(editLineProblem({ ...plain, active: false }, '', true)).toBe(null);
  });

  it('answers the demo’s choice sentences', () => {
    expect(editLineProblem(withChoice, '', false)).toBe(
      'Choose style for Pancakes.',
    );
    expect(editLineProblem(withChoice, 'Sweet', false)).toBe(null);
    expect(editLineProblem(plain, 'Large', false)).toBe('Zobo has no options.');
  });

  it('keys duplicates by dish and option, as positiveLines does', () => {
    const rules = {
      idKey: 'menuItemId',
      idMessage: EDIT_MENU_ITEM_MESSAGE,
      qtyKey: 'qty',
      minQty: 1 as const,
      qtyMessage: 'Quantities must be whole numbers above zero.',
      emptyMessage: 'Add at least one item.',
      lineKey: (line: Record<string, unknown>) =>
        `${String(line.menuItemId)}|${typeof line.option === 'string' ? line.option : ''}`,
    };

    expect(
      lineProblem(
        [
          { menuItemId: 'p', option: 'Sweet', qty: 1 },
          { menuItemId: 'p', option: 'Savoury', qty: 1 },
        ],
        rules,
      ),
    ).toBe(null);
    expect(
      lineProblem(
        [
          { menuItemId: 'p', option: 'Sweet', qty: 1 },
          { menuItemId: 'p', option: 'Sweet', qty: 2 },
        ],
        rules,
      ),
    ).toBe('Combine duplicate items into one quantity.');
  });
});

describe('barDifference (D30)', () => {
  const drink = (menuItemId: string, qty: number, name = menuItemId) => ({
    menuItemId,
    name,
    qty,
    department: Department.BAR,
  });
  const paired = new Map([
    ['zobo', 'stock-b'],
    ['chapman', 'stock-a'],
  ]);

  it('moves each paired drink by its difference, in stock id order', () => {
    expect(
      barDifference(
        [drink('zobo', 3), drink('chapman', 1)],
        [drink('zobo', 1), drink('chapman', 4)],
        paired,
      ),
    ).toEqual({
      moves: [
        { stockItemId: 'stock-a', delta: -3 },
        { stockItemId: 'stock-b', delta: 2 },
      ],
      unpaired: [],
    });
  });

  it('returns every drink on a cancellation and ignores food', () => {
    expect(
      barDifference(
        [
          drink('zobo', 2),
          { ...drink('rice', 5), department: Department.RESTAURANT },
        ],
        [],
        paired,
      ),
    ).toEqual({ moves: [{ stockItemId: 'stock-b', delta: 2 }], unpaired: [] });
  });

  it('moves nothing for an unchanged drink and names an unpaired one', () => {
    expect(
      barDifference(
        [drink('zobo', 2), drink('mystery', 1, 'Mystery')],
        [drink('zobo', 2), drink('mystery', 3, 'Mystery')],
        paired,
      ),
    ).toEqual({ moves: [], unpaired: ['Mystery'] });
  });
});
