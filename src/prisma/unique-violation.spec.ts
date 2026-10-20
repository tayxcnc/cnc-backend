import { Prisma } from '../../generated/cnc-client';
import { uniqueViolationTargets } from './unique-violation';

/**
 * Both shapes a P2002 has arrived in, pinned. The Prisma 7 case is recorded
 * from a real duplicate insert under 7.10.0 with @prisma/adapter-pg; the
 * Prisma 6 case from the same insert under 6.19.3. No database: the errors
 * are built from the generated client's own class.
 */
describe('uniqueViolationTargets', () => {
  const p2002 = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta,
    });

  it('reads Prisma 6 meta.target as an array', () => {
    expect(
      uniqueViolationTargets(
        p2002({ modelName: 'Customer', target: ['email'] }),
      ),
    ).toEqual(['email']);
  });

  it('reads Prisma 6 meta.target as a string', () => {
    expect(uniqueViolationTargets(p2002({ target: 'slug' }))).toEqual(['slug']);
  });

  it('reads the Prisma 7 driver-adapter constraint name', () => {
    const error = p2002({
      modelName: 'Customer',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage:
            'duplicate key value violates unique constraint "Customer_email_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'Customer_email_key' },
          table: 'Customer',
        },
      },
    });

    expect(uniqueViolationTargets(error)).toEqual(['email']);
  });

  it('recovers every field of a composite unique index', () => {
    const error = p2002({
      modelName: 'Reservation',
      driverAdapterError: {
        cause: {
          constraint: { index: 'Reservation_tableId_bookingDate_key' },
        },
      },
    });

    expect(uniqueViolationTargets(error)).toEqual(['tableId', 'bookingDate']);
  });

  it('prefers explicit constraint.fields when a driver supplies them', () => {
    const error = p2002({
      modelName: 'Customer',
      driverAdapterError: {
        cause: { constraint: { fields: ['memberNo'] } },
      },
    });

    expect(uniqueViolationTargets(error)).toEqual(['memberNo']);
  });

  it('returns nothing for a constraint name it cannot read', () => {
    const error = p2002({
      modelName: 'Customer',
      driverAdapterError: {
        cause: { constraint: { index: 'something_pkey' } },
      },
    });

    expect(uniqueViolationTargets(error)).toEqual([]);
  });

  it('returns nothing for any other Prisma error code', () => {
    const notFound = new Prisma.PrismaClientKnownRequestError('missing', {
      code: 'P2025',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });

    expect(uniqueViolationTargets(notFound)).toEqual([]);
  });

  it('returns nothing for a non-Prisma error', () => {
    expect(uniqueViolationTargets(new Error('boom'))).toEqual([]);
    expect(uniqueViolationTargets(undefined)).toEqual([]);
  });
});
