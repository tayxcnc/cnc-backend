import { nextSequenceCode } from './sequence-code';

/**
 * The formatting and the guard, with no database: the client is a fake that
 * answers `nextval` with a fixed value. Whether `nextval` itself hands
 * concurrent callers different numbers is Postgres's promise, and the e2e
 * suite checks it against a real sequence once one exists.
 */
function fakePrisma(rows: { next: bigint }[]) {
  const $queryRawUnsafe = jest.fn((query: string) => {
    void query;
    return Promise.resolve(rows);
  });

  // The function only calls `$queryRawUnsafe`; the cast is to its generic
  // signature, which a jest mock cannot carry.
  return {
    prisma: { $queryRawUnsafe } as unknown as Parameters<
      typeof nextSequenceCode
    >[0],
    $queryRawUnsafe,
  };
}

describe('nextSequenceCode', () => {
  it('pads the drawn value to the minimum digits behind the prefix', async () => {
    const { prisma } = fakePrisma([{ next: 7n }]);

    await expect(
      nextSequenceCode(prisma, 'customer_member_no_seq', 'CNC-', 6),
    ).resolves.toBe('CNC-000007');
  });

  it('treats minDigits as a floor, not a width', async () => {
    const { prisma } = fakePrisma([{ next: 1_000_000n }]);

    await expect(
      nextSequenceCode(prisma, 'customer_member_no_seq', 'CNC-', 6),
    ).resolves.toBe('CNC-1000000');
  });

  it('keeps a value beyond 2^53 exact', async () => {
    const { prisma } = fakePrisma([{ next: 9_007_199_254_740_993n }]);

    await expect(
      nextSequenceCode(prisma, 'order_r_seq', 'CNCR-', 6),
    ).resolves.toBe('CNCR-9007199254740993');
  });

  it('asks Postgres for nextval of the named sequence', async () => {
    const { prisma, $queryRawUnsafe } = fakePrisma([{ next: 1n }]);

    await nextSequenceCode(prisma, 'staff_no_seq', 'CNC-S', 3);

    expect($queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT nextval('staff_no_seq') AS next",
    );
  });

  it.each([
    'x\'); DROP TABLE "Order"; --',
    'Order_seq',
    'public.order_seq',
    '1seq',
    '',
  ])(
    'refuses %p, which is not a bare sequence name, before any query',
    async (sequence) => {
      const { prisma, $queryRawUnsafe } = fakePrisma([{ next: 1n }]);

      await expect(
        nextSequenceCode(prisma, sequence, 'CNC-', 6),
      ).rejects.toThrow(/not a plain sequence name/);
      expect($queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it('names a sequence that returned no row', async () => {
    const { prisma } = fakePrisma([]);

    await expect(
      nextSequenceCode(prisma, 'missing_seq', 'CNC-', 6),
    ).rejects.toThrow(/missing_seq returned no value/);
  });
});
