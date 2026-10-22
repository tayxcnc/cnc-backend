import { PurchaseStatus } from '../../generated/cnc-client';
import { INT4_MAX } from '../prisma/int4';
import {
  correctionMoves,
  hasReceived,
  isApprovedPurchase,
  isClosedPurchase,
  isLineCost,
  purchaseTotalKobo,
  receivedValueKobo,
  receiveTaskTitle,
  reviewTaskTitle,
  taskForStatus,
} from './purchase-rules';

describe('purchase rules', () => {
  it('calls Approved and Fulfilled purchases approved, and nothing else (Q25, purchase.edit)', () => {
    expect(
      Object.values(PurchaseStatus).filter((status) =>
        isApprovedPurchase(status),
      ),
    ).toEqual([PurchaseStatus.APPROVED, PurchaseStatus.FULFILLED]);
  });

  it('totals packs × cost per pack, as the demo’s purchaseTotal', () => {
    expect(
      purchaseTotalKobo([
        { qtyPacks: 3, costKobo: 4500000 },
        { qtyPacks: 2, costKobo: 3800000 },
      ]),
    ).toBe(21100000);
    expect(purchaseTotalKobo([])).toBe(0);
  });

  it('values what was received only', () => {
    expect(
      receivedValueKobo([
        { receivedPacks: 2, costKobo: 7000000 },
        { receivedPacks: 0, costKobo: 1000000 },
      ]),
    ).toBe(14000000);
    expect(hasReceived([{ receivedPacks: 0 }, { receivedPacks: 1 }])).toBe(
      true,
    );
    expect(hasReceived([{ receivedPacks: 0 }])).toBe(false);
  });

  it('puts archived, Fulfilled, Rejected and Cancelled purchases in History', () => {
    expect(
      isClosedPurchase({ archived: false, status: PurchaseStatus.PENDING }),
    ).toBe(false);
    expect(
      isClosedPurchase({ archived: false, status: PurchaseStatus.APPROVED }),
    ).toBe(false);
    expect(
      isClosedPurchase({ archived: true, status: PurchaseStatus.APPROVED }),
    ).toBe(true);

    for (const status of [
      PurchaseStatus.FULFILLED,
      PurchaseStatus.REJECTED,
      PurchaseStatus.CANCELLED,
    ]) {
      expect(isClosedPurchase({ archived: false, status })).toBe(true);
    }
  });

  it('accepts a whole cost above zero that fits an Int column', () => {
    expect(isLineCost(1)).toBe(true);
    expect(isLineCost(INT4_MAX)).toBe(true);

    for (const bad of [0, -1, 1.5, INT4_MAX + 1, '100', null, undefined]) {
      expect(isLineCost(bad)).toBe(false);
    }
  });

  it('moves the Store by the corrected quantity less what was received', () => {
    // The demo's revision test: 2 bags received, corrected to 3, so +1.
    expect(
      correctionMoves(
        [{ stockItemId: 'rice', receivedPacks: 2 }],
        [{ stockItemId: 'rice', qtyPacks: 3 }],
      ),
    ).toEqual([{ stockItemId: 'rice', qty: 1 }]);

    // A line removed gives back what it received; a new line adds its packs;
    // an unchanged line moves nothing.
    expect(
      correctionMoves(
        [
          { stockItemId: 'rice', receivedPacks: 2 },
          { stockItemId: 'beans', receivedPacks: 4 },
          { stockItemId: 'oil', receivedPacks: 1 },
        ],
        [
          { stockItemId: 'oil', qtyPacks: 1 },
          { stockItemId: 'yam', qtyPacks: 5 },
        ],
      ),
    ).toEqual([
      { stockItemId: 'rice', qty: -2 },
      { stockItemId: 'beans', qty: -4 },
      { stockItemId: 'yam', qty: 5 },
    ]);
  });

  it('gives a Pending purchase its review and an Approved one its receiving (R1)', () => {
    expect(taskForStatus(PurchaseStatus.PENDING)).toBe('REVIEW');
    expect(taskForStatus(PurchaseStatus.APPROVED)).toBe('RECEIVE');

    for (const status of [
      PurchaseStatus.REJECTED,
      PurchaseStatus.CANCELLED,
      PurchaseStatus.FULFILLED,
    ]) {
      expect(taskForStatus(status)).toBeNull();
    }
  });

  it('titles the automatic tasks in the demo’s words', () => {
    expect(reviewTaskTitle('PR-000091', 'Plateau Fresh Foods')).toBe(
      'Review purchase PR-000091 from Plateau Fresh Foods',
    );
    expect(receiveTaskTitle('PR-000091')).toBe('Receive goods for PR-000091');
  });
});
