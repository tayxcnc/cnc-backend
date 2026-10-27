import { StaffRole } from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { docketRefReader, orderRefReader } from './order-audit-readers';

const viewer = (role: StaffRole): StaffPrincipal => ({
  id: 'staff-1',
  staffNo: 'CNC-S001',
  name: 'Test',
  role,
});

describe('order and docket audit readers (plan §4.8)', () => {
  const orderExists = jest.fn(() => Promise.resolve({ id: 'order-1' }));
  const docketExists = jest.fn(() => Promise.resolve({ id: 'docket-1' }));
  const orders = orderRefReader({
    order: { findUnique: orderExists },
  } as never);
  const dockets = docketRefReader({
    docket: { findFirst: docketExists },
  } as never);

  it('owns bill numbers and docket refs, and no customer or staff number', () => {
    expect(orders.owns('CNCR-000001')).toBe(true);
    expect(orders.owns('CNCB-000001')).toBe(true);
    expect(orders.owns('CNC-000001')).toBe(false);
    expect(orders.owns('CNC-S001')).toBe(false);
    expect(orders.owns('KOT-CNCR-000001')).toBe(false);
    expect(dockets.owns('KOT-CNCR-000001')).toBe(true);
    expect(dockets.owns('CNCR-000001')).toBe(false);
  });

  it('lets the Point of Sale roles read bills, a Bartender Bar bills only', async () => {
    for (const role of [StaffRole.CASHIER, StaffRole.WAITER]) {
      await expect(orders.mayRead(viewer(role), 'CNCR-000001')).resolves.toBe(
        true,
      );
    }

    await expect(
      orders.mayRead(viewer(StaffRole.BARTENDER), 'CNCB-000001'),
    ).resolves.toBe(true);
    await expect(
      orders.mayRead(viewer(StaffRole.BARTENDER), 'CNCR-000001'),
    ).resolves.toBe(false);

    for (const role of [
      StaffRole.KITCHEN,
      StaffRole.RECEPTION,
      StaffRole.STOREKEEPER,
    ]) {
      await expect(orders.mayRead(viewer(role), 'CNCR-000001')).resolves.toBe(
        false,
      );
    }
  });

  it('lets the Kitchen, Cashier and Waiter read dockets', async () => {
    for (const role of [
      StaffRole.KITCHEN,
      StaffRole.CASHIER,
      StaffRole.WAITER,
    ]) {
      await expect(
        dockets.mayRead(viewer(role), 'KOT-CNCR-000001'),
      ).resolves.toBe(true);
    }

    for (const role of [StaffRole.BARTENDER, StaffRole.RECEPTION]) {
      await expect(
        dockets.mayRead(viewer(role), 'KOT-CNCR-000001'),
      ).resolves.toBe(false);
    }
  });

  it('refuses a ref nobody issued', async () => {
    orderExists.mockResolvedValueOnce(null as never);
    docketExists.mockResolvedValueOnce(null as never);

    await expect(
      orders.mayRead(viewer(StaffRole.CASHIER), 'CNCR-999999'),
    ).resolves.toBe(false);
    await expect(
      dockets.mayRead(viewer(StaffRole.KITCHEN), 'KOT-CNCR-999999'),
    ).resolves.toBe(false);
  });
});
