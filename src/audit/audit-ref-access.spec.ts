import { StaffRole } from '../../generated/cnc-client';
import { AuditRefAccess } from './audit-ref-access';

describe('AuditRefAccess', () => {
  const cashier = {
    id: 'staff-1',
    staffNo: 'CNC-S001',
    name: 'Grace James',
    role: StaffRole.CASHIER,
  };

  it('fails closed: a ref no reader owns cannot be read', async () => {
    await expect(
      new AuditRefAccess().mayRead(cashier, 'CNCR-000001'),
    ).resolves.toBe(false);
  });

  it('asks the reader that owns the ref, and only that one', async () => {
    const access = new AuditRefAccess();
    const orders = jest.fn(() => Promise.resolve(true));
    const waste = jest.fn(() => Promise.resolve(false));

    access.register({
      owns: (ref) => ref.startsWith('CNCR-'),
      mayRead: orders,
    });
    access.register({ owns: (ref) => ref.startsWith('W-'), mayRead: waste });

    await expect(access.mayRead(cashier, 'CNCR-000001')).resolves.toBe(true);
    await expect(access.mayRead(cashier, 'W-000001')).resolves.toBe(false);
    expect(orders).toHaveBeenCalledWith(cashier, 'CNCR-000001');
    expect(waste).toHaveBeenCalledTimes(1);
  });
});
