import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole } from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import {
  PRINT_DOCUMENT_MESSAGE,
  PRINT_PERIOD_MESSAGE,
  PRINT_REF_MAX_LENGTH,
  PRINT_REF_MESSAGE,
  PRINT_REVISION_MESSAGE,
} from '../src/audit/print-documents';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * `POST /staff/audit/print` (plan §5.3, card C4-12's server half): every
 * Print button records the demo's audit-only `print`, and nothing else
 * changes.
 *
 * It runs on the shared test database: it writes only audit rows, under
 * refs this suite makes up, so no other suite can meet them.
 */
describe('Print record (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const ROLES = [
    StaffRole.OWNER,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.WAITER,
    StaffRole.BARTENDER,
    StaffRole.KITCHEN,
    StaffRole.RECEPTION,
    StaffRole.STOREKEEPER,
  ];

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const tokens = app.get(CncTokenService, { strict: false });

    for (const role of ROLES) {
      const made = await createStaffAccount(prisma, role, {
        emailPrefix: 'print',
        name: `Print suite ${role.toLowerCase()}`,
      });
      token[role] = await accessTokenFor(tokens, made.id);
      staffId[role] = made.id;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A ref no other suite writes. */
  const freshRef = () => `PRINT-TEST-${randomUUID()}`;

  const print = (role: StaffRole, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/staff/audit/print')
      .set('Authorization', `Bearer ${token[role]}`)
      .send(body);

  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  const rowsFor = (ref: string) =>
    prisma.auditLog.findMany({
      where: { ref },
      select: { action: true, staffId: true, after: true, before: true },
    });

  it('every staff role records a print, and only the print is written', async () => {
    for (const role of ROLES) {
      const ref = freshRef();

      await print(role, { document: 'receipt', ref }).expect(204);

      expect(await rowsFor(ref)).toEqual([
        {
          action: 'print',
          staffId: staffId[role],
          after: { document: 'receipt', revision: null },
          before: null,
        },
      ]);
    }
  });

  it('a docket print keeps its revision, an attendance print its period, and a retry is a second print', async () => {
    const docket = freshRef();

    await print(StaffRole.WAITER, {
      document: 'docket',
      ref: `  ${docket}  `,
      revision: 2,
    }).expect(204);
    await print(StaffRole.WAITER, {
      document: 'docket',
      ref: docket,
      revision: 2,
    }).expect(204);

    const docketRows = await rowsFor(docket);

    expect(docketRows).toHaveLength(2);
    expect(docketRows[0].after).toEqual({ document: 'docket', revision: 2 });

    const attendance = freshRef();
    const period = { from: '2026-10-01', to: '2026-10-31' };

    await print(StaffRole.MANAGER, {
      document: 'attendance',
      ref: attendance,
      period,
    }).expect(204);
    expect((await rowsFor(attendance))[0].after).toEqual({
      document: 'attendance',
      revision: null,
      period,
    });

    // A period sent with another document is not recorded.
    const bill = freshRef();

    await print(StaffRole.CASHIER, {
      document: 'bill',
      ref: bill,
      period,
    }).expect(204);
    expect((await rowsFor(bill))[0].after).toEqual({
      document: 'bill',
      revision: null,
    });
  });

  it('refuses what it cannot record, one sentence per field, and writes nothing', async () => {
    const ref = freshRef();
    const cases: [Record<string, unknown>, string][] = [
      [{ ref }, PRINT_DOCUMENT_MESSAGE],
      [{ document: 'menu', ref }, PRINT_DOCUMENT_MESSAGE],
      [{ document: 'receipt' }, PRINT_REF_MESSAGE],
      [{ document: 'receipt', ref: '   ' }, PRINT_REF_MESSAGE],
      [
        { document: 'receipt', ref: 'x'.repeat(PRINT_REF_MAX_LENGTH + 1) },
        `ref must be ${PRINT_REF_MAX_LENGTH} characters or fewer.`,
      ],
      [{ document: 'docket', ref, revision: 0 }, PRINT_REVISION_MESSAGE],
      [{ document: 'docket', ref, revision: 1.5 }, PRINT_REVISION_MESSAGE],
      [
        {
          document: 'attendance',
          ref,
          period: { from: '2026-10-31', to: '2026-10-01' },
        },
        PRINT_PERIOD_MESSAGE,
      ],
      [
        {
          document: 'attendance',
          ref,
          period: { from: '2026-02-30', to: '2026-03-01' },
        },
        PRINT_PERIOD_MESSAGE,
      ],
    ];

    for (const [body, sentence] of cases) {
      const refused = await print(StaffRole.CASHIER, body).expect(400);

      // The validation pipe answers a list: exactly this one sentence.
      expect(messageOf(refused)).toEqual([sentence]);
    }

    expect(await rowsFor(ref)).toEqual([]);
  });

  it('needs a staff session', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/staff/audit/print')
      .send({ document: 'receipt', ref: freshRef() })
      .expect(401);
  });
});
