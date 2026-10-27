import { AuditActorKind, Prisma, StaffRole } from '../../generated/cnc-client';
import { AuditService, staffActor } from './audit.service';

/**
 * The one writer of `AuditLog`: what it stores for each kind of actor, and
 * what it refuses to store. The row really reaching Postgres in the
 * command's transaction is `test/audit.e2e-spec.ts`.
 */
describe('AuditService', () => {
  const audit = new AuditService();

  function fakeTx() {
    const create = jest.fn<
      Promise<object>,
      [{ data: Record<string, unknown> }]
    >(() => Promise.resolve({}));

    return {
      tx: { auditLog: { create } } as unknown as Prisma.TransactionClient,
      create,
      data: () => create.mock.calls[0][0].data,
    };
  }

  const ada = { id: 'staff-1', name: 'Ada Okafor', role: StaffRole.MANAGER };

  it('snapshots a staff actor’s name and role and derives the module', async () => {
    const { tx, data } = fakeTx();

    await audit.record(
      {
        actor: staffActor(ada),
        action: 'menu.save',
        ref: 'jollof-rice',
        before: { priceKobo: 250_000 },
        after: { priceKobo: 300_000, at: new Date('2026-10-21T10:00:00Z') },
        reason: '  Supplier price rise ',
        ipAddress: '203.0.113.7',
      },
      tx,
    );

    expect(data()).toEqual({
      actorKind: AuditActorKind.STAFF,
      staffId: 'staff-1',
      customerId: null,
      actorName: 'Ada Okafor',
      actorRole: 'MANAGER',
      action: 'menu.save',
      module: 'Menu & Prices',
      ref: 'jollof-rice',
      before: { priceKobo: 250_000 },
      after: { priceKobo: 300_000, at: '2026-10-21T10:00:00.000Z' },
      reason: 'Supplier price rise',
      channel: null,
      ipAddress: '203.0.113.7',
    });
  });

  it('writes a customer or a system actor with no staff id or role', async () => {
    const customer = fakeTx();
    await audit.record(
      {
        actor: { kind: 'CUSTOMER', customerId: 'cust-1', name: 'Bola Ade' },
        action: 'reservation.create',
      },
      customer.tx,
    );
    expect(customer.data()).toMatchObject({
      actorKind: AuditActorKind.CUSTOMER,
      staffId: null,
      customerId: 'cust-1',
      actorName: 'Bola Ade',
      actorRole: null,
      module: 'Reception',
      ref: null,
    });

    const system = fakeTx();
    await audit.record(
      {
        actor: { kind: 'SYSTEM', name: 'Payment webhook' },
        action: 'online.status',
      },
      system.tx,
    );
    expect(system.data()).toMatchObject({
      actorKind: AuditActorKind.SYSTEM,
      staffId: null,
      customerId: null,
      actorName: 'Payment webhook',
    });
  });

  it('stores a missing before or after as SQL NULL and a blank reason as null', async () => {
    const { tx, data } = fakeTx();

    await audit.record(
      { actor: staffActor(ada), action: 'settings.save', reason: '   ' },
      tx,
    );

    expect(data().before).toBe(Prisma.DbNull);
    expect(data().after).toBe(Prisma.DbNull);
    expect(data().reason).toBeNull();
  });

  it.each([
    ['passwordHash', { passwordHash: 'x' }],
    ['qrToken', { staff: { qrToken: 'x' } }],
    ['temporaryPassword', [{ temporaryPassword: 'x' }]],
    ['tokenHash', { tokens: [{ tokenHash: 'x' }] }],
  ])('refuses a row carrying %s, and writes nothing', async (field, after) => {
    const { tx, create } = fakeTx();

    await expect(
      audit.record({ actor: staffActor(ada), action: 'staff.save', after }, tx),
    ).rejects.toThrow(`"${field}"`);
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves an ordinary field that merely sounds like one alone', async () => {
    const { tx, create } = fakeTx();

    await audit.record(
      {
        actor: staffActor(ada),
        action: 'table.allocate',
        after: { code: 'B1' },
      },
      tx,
    );

    expect(create).toHaveBeenCalledTimes(1);
  });
});
