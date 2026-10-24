import { StockLocation } from '../../generated/cnc-client';
import {
  expectedArrivalItem,
  lowStockItem,
  purchaseApprovalItem,
  stockRequestItem,
  unsettledBillItem,
  wasteApprovalItem,
} from './staff-bell-items';

describe('staff bell items (C8-2), in the demo’s words', () => {
  it('Purchase Approval: the number and the note, or the fallback', () => {
    expect(
      purchaseApprovalItem({ id: 'p1', number: 'PR-000004', note: 'Rice' }),
    ).toEqual({
      id: 'purchase:p1',
      title: 'Purchase Approval',
      detail: 'PR-000004 · Rice',
      page: 'purchasing',
      category: 'Approval',
    });
    expect(
      purchaseApprovalItem({ id: 'p2', number: 'PR-000005', note: '' }).detail,
    ).toBe('PR-000005 · Requisition awaiting review');
  });

  it('Waste Approval: the number, the quantity, the item and the location', () => {
    expect(
      wasteApprovalItem({
        id: 'w1',
        number: 'W-000002',
        qty: 3,
        itemName: 'Rice',
        location: StockLocation.KITCHEN,
      }),
    ).toEqual({
      id: 'waste:w1',
      title: 'Waste Approval',
      detail: 'W-000002 · 3 Rice · Kitchen',
      page: 'waste',
      category: 'Approval',
    });
  });

  describe('Low Stock', () => {
    const item = {
      stockItemId: 's1',
      name: 'Rice',
      unit: 'portion',
      pack: 'bag',
      minimum: 15,
    };

    it('counts the Store in packs, with no reorder level', () => {
      expect(
        lowStockItem({ ...item, location: StockLocation.STORE, qty: 0 }),
      ).toEqual({
        id: 'low:s1:STORE',
        title: 'Low Stock · Store',
        detail: 'Rice · 0 bags left',
        page: 'inventory',
        category: 'Stock',
      });
    });

    it('counts the Kitchen and the Bar in units, with the reorder level', () => {
      expect(
        lowStockItem({ ...item, location: StockLocation.KITCHEN, qty: 3 }),
      ).toMatchObject({
        id: 'low:s1:KITCHEN',
        title: 'Low Stock · Kitchen',
        detail: 'Rice · 3 portions left, reorder level 15',
      });
      expect(
        lowStockItem({
          ...item,
          unit: 'serving',
          location: StockLocation.BAR,
          qty: -2,
        }).detail,
      ).toBe('Rice · -2 servings left, reorder level 15');
    });

    it('drops the plural for exactly one', () => {
      expect(
        lowStockItem({ ...item, location: StockLocation.KITCHEN, qty: 1 })
          .detail,
      ).toBe('Rice · 1 portion left, reorder level 15');
    });
  });

  it('Unsettled From a Previous Day: the number and the label', () => {
    expect(
      unsettledBillItem({ id: 'o1', number: 'CNCR-000012', label: 'Booth 1' }),
    ).toEqual({
      id: 'unsettled:o1',
      title: 'Unsettled From a Previous Day',
      detail: 'CNCR-000012 · Booth 1',
      page: 'pos',
      category: 'Payment',
    });
  });

  it('Stock Request: the number and the location', () => {
    expect(
      stockRequestItem({
        id: 'r1',
        number: 'SR-000003',
        location: StockLocation.BAR,
      }),
    ).toEqual({
      id: 'request:r1',
      title: 'Stock Request',
      detail: 'SR-000003 · Bar',
      page: 'inventory',
      category: 'Stock',
    });
  });

  it('Expected Guest Arrival: the name, the time and the party', () => {
    expect(
      expectedArrivalItem({
        id: 'b1',
        name: 'Ada',
        startMinutes: 19 * 60 + 30,
        party: 1,
      }),
    ).toEqual({
      id: 'arrival:b1',
      title: 'Expected Guest Arrival',
      detail: 'Ada · 19:30 · 1 guests',
      page: 'reception',
      category: 'Reception',
    });
  });
});
