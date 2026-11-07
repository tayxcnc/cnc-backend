import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole } from '../generated/cnc-client';
import {
  ATTENDANCE_EXPORT_COLUMNS,
  ATTENDANCE_EXPORT_TITLE,
  ATTENDANCE_FUTURE_MESSAGE,
  ATTENDANCE_NOT_FOUND_MESSAGE,
  ATTENDANCE_OVERLAP_MESSAGE,
  ATTENDANCE_TIMES_MESSAGE,
  CHECKOUT_AFTER_CHECKIN_MESSAGE,
  MONTH_MESSAGE,
  PERIOD_ORDER_MESSAGE,
  SCAN_INVALID_MESSAGE,
  SHIFT_FILTER_MESSAGE,
} from '../src/attendance/attendance-messages';
import { ADMIN_REASON_MESSAGE } from '../src/common/admin-reason';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { staffQrPayload } from '../src/staff/staff-qr';
import { createTestApp } from './create-test-app';
import { fakeDateOnly } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Attendance (card C5-7) through HTTP and against Postgres: the QR scan,
 * the correction, the reads and the Attendance review export, with the
 * C5 gate's step 7 ("The QR scan checks a person in, then out."). The
 * demo's attendance cases (`attendance.test.cjs`, `revision.test.cjs`)
 * are ported by name.
 *
 * **The clock is controlled** (`fakeDateOnly`): a repeat scan is one
 * within an hour of the arrival or a minute of the departure, and the
 * overnight and reporting cases need set times.
 * It starts on 30 September 2026, the demo's own dates, and only moves
 * forward, each case on its own day and its own person; tokens are minted
 * afresh after every move. The suite runs on a database of its own, as
 * every suite with a faked clock does.
 */
describe('Attendance (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  const originalUrl = process.env.CNC_DB_URL;

  type Actor =
    | 'owner'
    | 'manager'
    | 'reception'
    | 'waiter'
    | 'a'
    | 'b'
    | 'c'
    | 'd'
    | 'e'
    | 'f'
    | 'retired';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    reception: StaffRole.RECEPTION,
    waiter: StaffRole.WAITER,
    a: StaffRole.KITCHEN,
    b: StaffRole.CASHIER,
    c: StaffRole.KITCHEN,
    d: StaffRole.BARTENDER,
    e: StaffRole.STOREKEEPER,
    f: StaffRole.WAITER,
    retired: StaffRole.KITCHEN,
  };

  const staffId: Partial<Record<Actor, string>> = {};
  const staffNo: Partial<Record<Actor, string>> = {};
  const token: Partial<Record<Actor, string>> = {};

  interface Scan {
    action: 'CHECKED_IN' | 'CHECKED_OUT' | 'REPEAT_IGNORED';
    duplicate: boolean;
    present: boolean;
    staffId: string;
    staffNo: string;
    name: string;
    at: string;
  }

  interface Shift {
    id: string;
    staffId: string;
    businessDate: string;
    timeIn: string;
    timeOut: string | null;
    state: 'PRESENT' | 'COMPLETED';
    hours: number | null;
    corrections: {
      staffId: string;
      reason: string;
      beforeIn: string;
      beforeOut: string | null;
    }[];
    version: number;
  }

  interface Page {
    staff: { id: string; staffNo: string };
    from: string;
    to: string;
    summary: {
      days: number;
      shifts: number;
      completed: number;
      open: number;
      hours: number;
      corrections: number;
    };
    data: Shift[];
    total: number;
  }

  async function mintTokens(): Promise<void> {
    for (const actor of Object.keys(ROLE) as Actor[]) {
      token[actor] = await accessTokenFor(tokens, staffId[actor]!);
    }
  }

  async function moveClockTo(iso: string): Promise<void> {
    const at = Date.parse(iso);

    if (at <= Date.now()) throw new Error('The clock only moves forward.');

    jest.setSystemTime(at);
    await mintTokens();
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    for (const actor of Object.keys(ROLE) as Actor[]) {
      const account = await createStaffAccount(prisma, ROLE[actor], {
        emailPrefix: 'attendance',
        name: `Attendance ${actor}`,
        isActive: actor !== 'retired',
      });
      staffId[actor] = account.id;
      staffNo[actor] = account.staffNo;
    }

    fakeDateOnly(Date.parse('2026-09-30T20:00:00Z'));
    await mintTokens();
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const as = (actor: Actor) => ({ Authorization: `Bearer ${token[actor]}` });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  /** The person's staff ID, decoded, as the scanner reads it. */
  async function codeOf(actor: Actor): Promise<string> {
    const row = await prisma.staff.findUniqueOrThrow({
      where: { id: staffId[actor] },
      select: { staffNo: true, qrToken: true },
    });

    return staffQrPayload(row.staffNo, row.qrToken);
  }

  const scan = (code: string, by: Actor = 'reception') =>
    request(server())
      .post('/api/v1/staff/attendance/scan')
      .set(as(by))
      .send({ code });

  async function scanAt(iso: string, actor: Actor): Promise<Scan> {
    await moveClockTo(iso);

    return (await scan(await codeOf(actor)).expect(200)).body as Scan;
  }

  const readFor = (actor: Actor, query: Record<string, string>) =>
    request(server())
      .get(`/api/v1/staff/attendance/${staffId[actor]}`)
      .query(query)
      .set(as('manager'));

  const correct = (
    id: string,
    body: Record<string, unknown>,
    by: Actor = 'manager',
  ) =>
    request(server())
      .patch(`/api/v1/staff/attendance/${id}`)
      .set(as(by))
      .send(body);

  const shiftsOf = (actor: Actor) =>
    prisma.attendanceRecord.findMany({
      where: { staffId: staffId[actor] },
      orderBy: { timeIn: 'asc' },
    });

  it('individual reports isolate the staff identity and use inclusive arrival dates for overnight shifts (attendance.test.cjs)', async () => {
    await scanAt('2026-09-30T22:30:00Z', 'a');
    await scanAt('2026-10-01T02:00:00Z', 'a');
    await scanAt('2026-10-02T07:00:00Z', 'a');
    await scanAt('2026-10-02T08:00:00Z', 'b');
    await scanAt('2026-10-02T11:00:00Z', 'a');

    const september = (
      await readFor('a', { from: '2026-09-01', to: '2026-09-30' }).expect(200)
    ).body as Page;
    expect(september.data).toHaveLength(1);
    expect(september.summary.hours).toBe(3.5);
    expect(september.data[0]).toMatchObject({
      businessDate: '2026-09-30',
      state: 'COMPLETED',
      hours: 3.5,
    });

    const october = (await readFor('a', { month: '2026-10' }).expect(200))
      .body as Page;
    expect(october.data).toHaveLength(1);
    expect(october.data[0].staffId).toBe(staffId.a);
    expect(october.summary.hours).toBe(4);
    expect(october).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });

    const day = { from: '2026-10-02', to: '2026-10-02' };
    const open = (await readFor('b', { ...day, filter: 'OPEN' }).expect(200))
      .body as Page;

    expect(open.data).toHaveLength(1);
    expect(
      (
        (await readFor('b', { ...day, filter: 'COMPLETED' }).expect(200))
          .body as Page
      ).data,
    ).toHaveLength(0);
  });

  it('QR scans reject invalid and unauthorised scans and ignore duplicates (revision.test.cjs)', async () => {
    await moveClockTo('2026-10-03T12:00:00Z');
    const code = await codeOf('c');

    const invalid = await scan('CNC-ID:bad').expect(400);
    expect(messageOf(invalid)).toBe(SCAN_INVALID_MESSAGE);

    const waiter = await scan(code, 'waiter').expect(403);
    expect(messageOf(waiter)).toBe(ROLE_REFUSED_MESSAGE);

    const arrived = (await scan(code).expect(200)).body as Scan;
    expect(arrived).toMatchObject({
      action: 'CHECKED_IN',
      duplicate: false,
      staffNo: staffNo.c,
    });

    const audited = () =>
      prisma.auditLog.count({
        where: { action: 'attendance.scan', ref: staffNo.c },
      });
    const count = await audited();

    // Within the hour after the arrival, a scan is "already checked in".
    for (const time of ['2026-10-03T12:00:30Z', '2026-10-03T12:59:00Z']) {
      await moveClockTo(time);
      const repeat = (await scan(code).expect(200)).body as Scan;
      expect(repeat).toMatchObject({
        action: 'REPEAT_IGNORED',
        duplicate: true,
        present: true,
        at: arrived.at,
      });
    }
    expect(await audited()).toBe(count);
    expect((await shiftsOf('c'))[0].timeOut).toBeNull();

    await moveClockTo('2026-10-03T13:00:30Z');
    const left = (await scan(code).expect(200)).body as Scan;
    expect(left).toMatchObject({ action: 'CHECKED_OUT', present: false });

    // Within a minute of the departure, a scan is "already checked out".
    await moveClockTo('2026-10-03T13:01:00Z');
    const after = (await scan(code).expect(200)).body as Scan;
    expect(after).toMatchObject({
      action: 'REPEAT_IGNORED',
      present: false,
      at: left.at,
    });
    expect(await shiftsOf('c')).toHaveLength(1);
  });

  it('answers a wrong token, an unknown number and a deactivated account with the one sentence', async () => {
    await moveClockTo('2026-10-03T15:00:00Z');
    const good = await codeOf('c');

    for (const code of [
      `CNC-ID:${staffNo.c}:not-the-token`,
      `CNC-ID:CNC-S999999:${good.split(':')[2]}`,
      await codeOf('retired'),
      '',
    ]) {
      const response = await scan(code).expect(400);
      expect(messageOf(response)).toBe(SCAN_INVALID_MESSAGE);
    }

    const missing = await request(server())
      .post('/api/v1/staff/attendance/scan')
      .set(as('reception'))
      .send({})
      .expect(400);
    expect(messageOf(missing)).toEqual([SCAN_INVALID_MESSAGE]);
  });

  it('never returns or records the token it compared', async () => {
    await moveClockTo('2026-10-03T16:00:00Z');
    const code = await codeOf('c');
    const qrToken = code.split(':')[2];

    const response = await scan(`${code}\n`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain(qrToken);

    const rows = await prisma.auditLog.findMany({
      where: { ref: staffNo.c },
      select: { before: true, after: true, reason: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(qrToken);
  });

  it('overnight QR departure closes the original shift and the next arrival creates another (revision.test.cjs)', async () => {
    await scanAt('2026-10-04T21:30:00Z', 'd');
    const departed = await scanAt('2026-10-04T23:30:00Z', 'd');
    expect(departed.action).toBe('CHECKED_OUT');

    const [first] = await shiftsOf('d');
    // 22:30 on the 4th in Jos to 00:30 on the 5th: the arrival's day.
    expect(first.businessDate.toISOString().slice(0, 10)).toBe('2026-10-04');
    expect(first.timeOut?.toISOString()).toMatch(/^2026-10-04T23:30:/);

    await scanAt('2026-10-05T09:00:00Z', 'd');
    expect(await shiftsOf('d')).toHaveLength(2);
  });

  it('C5 gate step 7: the QR scan checks a person in, then out', async () => {
    // The faked clock still runs, so instants are compared to the minute.
    const arrived = await scanAt('2026-10-06T07:00:00Z', 'e');
    expect(arrived).toMatchObject({
      action: 'CHECKED_IN',
      staffId: staffId.e,
      name: 'Attendance e',
    });
    expect(arrived.at).toMatch(/^2026-10-06T07:00:/);

    const left = await scanAt('2026-10-06T15:30:00Z', 'e');
    expect(left.action).toBe('CHECKED_OUT');
    expect(left.at).toMatch(/^2026-10-06T15:30:/);

    const day = (
      await readFor('e', { from: '2026-10-06', to: '2026-10-06' }).expect(200)
    ).body as Page & { data: (Shift & { source: string })[] };
    expect(day.data).toHaveLength(1);
    expect(day.data[0]).toMatchObject({
      businessDate: '2026-10-06',
      state: 'COMPLETED',
      hours: 8.5,
      source: 'RECEPTION_QR',
    });
    expect(day.data[0].timeIn).toMatch(/^2026-10-06T07:00:/);
    expect(day.data[0].timeOut).toMatch(/^2026-10-06T15:30:/);
  });

  it('serialises scans of one card arriving together: one records, the others are repeats', async () => {
    const code = await codeOf('a');
    const before = (await shiftsOf('a')).length;
    const ROUNDS = 6;

    for (let round = 0; round < ROUNDS; round += 1) {
      // Each round 61 minutes on, so it is never a repeat of the last.
      const at = Date.parse('2026-10-06T18:00:00Z') + round * 61 * 60_000;

      await moveClockTo(new Date(at).toISOString());

      const results = await Promise.all([scan(code), scan(code), scan(code)]);
      const actions = results.map((response) =>
        response.status === 200
          ? (response.body as Scan).action
          : response.status,
      );

      expect(actions.sort()).toEqual([
        round % 2 === 0 ? 'CHECKED_IN' : 'CHECKED_OUT',
        'REPEAT_IGNORED',
        'REPEAT_IGNORED',
      ]);
    }

    expect(await shiftsOf('a')).toHaveLength(before + ROUNDS / 2);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'attendance.scan',
          ref: staffNo.a,
          at: { gte: new Date('2026-10-06T17:59:00Z') },
        },
      }),
    ).toBe(ROUNDS);
  });

  describe('attendance.correct', () => {
    let first: Shift;

    it('attendance corrections retain original times and reject overlapping shifts (revision.test.cjs)', async () => {
      for (const time of [
        '2026-10-07T07:00:00Z',
        '2026-10-07T08:00:00Z',
        '2026-10-07T09:00:00Z',
        '2026-10-07T10:00:00Z',
      ]) {
        await scanAt(time, 'f');
      }

      await moveClockTo('2026-10-07T12:00:00Z');
      first = (
        (await readFor('f', { month: '2026-10' }).expect(200)).body as Page
      ).data[0];

      // Out at 09:30 UTC (10:30 in Jos) would run into the 09:00 shift.
      const overlap = await correct(first.id, {
        timeIn: '2026-10-07T08:00',
        timeOut: '2026-10-07T10:30',
        reason: 'Wrong time',
        version: first.version,
      }).expect(409);
      expect(messageOf(overlap)).toBe(ATTENDANCE_OVERLAP_MESSAGE);

      const corrected = (
        await correct(first.id, {
          timeIn: '2026-10-07T07:30',
          timeOut: '2026-10-07T09:00',
          reason: 'Missed arrival',
          version: first.version,
        }).expect(200)
      ).body as Shift;

      expect(corrected).toMatchObject({
        timeIn: '2026-10-07T06:30:00.000Z',
        timeOut: '2026-10-07T08:00:00.000Z',
        hours: 1.5,
        corrections: [
          {
            staffId: staffId.manager,
            reason: 'Missed arrival',
            beforeIn: first.timeIn,
            beforeOut: first.timeOut,
          },
        ],
        version: first.version + 1,
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'attendance.correct', ref: staffNo.f },
        orderBy: { at: 'desc' },
      });
      expect(audit.reason).toBe('Missed arrival');

      first = corrected;
    });

    it('refuses bad, future and reversed times, in the demo’s order', async () => {
      const refused = async (
        body: Record<string, unknown>,
        message: string,
      ) => {
        const response = await correct(first.id, {
          reason: 'Fix',
          version: first.version,
          ...body,
        }).expect(400);
        expect(messageOf(response)).toBe(message);
      };

      await refused({ timeIn: '2026-10-07 07:30' }, ATTENDANCE_TIMES_MESSAGE);
      await refused(
        { timeIn: '2026-10-07T07:30', timeOut: '2026-02-30T09:00' },
        ATTENDANCE_TIMES_MESSAGE,
      );
      await refused(
        { timeIn: '2026-10-07T07:30', timeOut: '2026-10-08T09:00' },
        ATTENDANCE_FUTURE_MESSAGE,
      );
      await refused(
        { timeIn: '2026-10-07T09:00', timeOut: '2026-10-07T08:00' },
        CHECKOUT_AFTER_CHECKIN_MESSAGE,
      );

      const noReason = await correct(first.id, {
        timeIn: '2026-10-07T07:30',
        version: first.version,
      }).expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);
    });

    it('refuses reopening a shift that would run into a later one, a stale version, an unknown shift and a non-manager', async () => {
      const reopen = await correct(first.id, {
        timeIn: '2026-10-07T07:30',
        timeOut: '',
        reason: 'Never left',
        version: first.version,
      }).expect(409);
      expect(messageOf(reopen)).toBe(ATTENDANCE_OVERLAP_MESSAGE);

      const stale = await correct(first.id, {
        timeIn: '2026-10-07T07:30',
        timeOut: '2026-10-07T09:00',
        reason: 'Again',
        version: first.version - 1,
      }).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const unknown = await correct('no-such-shift', {
        timeIn: '2026-10-07T07:30',
        reason: 'Fix',
        version: 0,
      }).expect(404);
      expect(messageOf(unknown)).toBe(ATTENDANCE_NOT_FOUND_MESSAGE);

      const reception = await correct(
        first.id,
        {
          timeIn: '2026-10-07T07:30',
          reason: 'Fix',
          version: first.version,
        },
        'reception',
      ).expect(403);
      expect(messageOf(reception)).toBe(ROLE_REFUSED_MESSAGE);
    });

    it('refuses a correction holding the version from before the departure scan', async () => {
      // The departure moved the version, so a correction opened on the
      // shift before it is refused rather than undoing it unseen.
      const [, second] = (
        (await readFor('f', { month: '2026-10' }).expect(200)).body as Page
      ).data;

      expect(second.version).toBe(1);

      const stale = await correct(second.id, {
        timeIn: '2026-10-07T10:00',
        timeOut: '2026-10-07T11:00',
        reason: 'Check',
        version: 0,
      }).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);
    });
  });

  describe('the reads', () => {
    it('shows everyone their own month in My Attendance', async () => {
      const own = (
        await request(server())
          .get('/api/v1/staff/me/attendance')
          .set(as('f'))
          .expect(200)
      ).body as Page;

      expect(own.staff.id).toBe(staffId.f);
      expect(own).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
      expect(own.summary).toEqual({
        days: 1,
        shifts: 2,
        completed: 2,
        open: 0,
        hours: 2.5,
        corrections: 1,
      });

      const filter = await request(server())
        .get('/api/v1/staff/me/attendance?filter=Completed')
        .set(as('f'))
        .expect(400);
      expect(messageOf(filter)).toEqual([SHIFT_FILTER_MESSAGE]);

      const month = await request(server())
        .get('/api/v1/staff/me/attendance?month=2026-13')
        .set(as('f'))
        .expect(400);
      expect(messageOf(month)).toBe(MONTH_MESSAGE);
    });

    it('gives managers the directory and anyone’s month, and nobody else', async () => {
      const directory = (
        await request(server())
          .get('/api/v1/staff/attendance/people?q=attendance')
          .set(as('manager'))
          .expect(200)
      ).body as { data: { id: string }[] };

      const ids = directory.data.map((row) => row.id);
      expect(ids).toContain(staffId.f);
      expect(ids).not.toContain(staffId.retired);

      await request(server())
        .get('/api/v1/staff/attendance/people')
        .set(as('reception'))
        .expect(403);
      await request(server())
        .get(`/api/v1/staff/attendance/${staffId.f}`)
        .set(as('f'))
        .expect(403);
      await request(server())
        .get('/api/v1/staff/attendance/no-such-person')
        .set(as('manager'))
        .expect(404);
    });

    it('attendance management is restricted to the manager and owner, and every staff role retains personal ID access (attendance.test.cjs)', async () => {
      const people = (Object.keys(ROLE) as Actor[]).filter(
        (actor) => actor !== 'retired',
      );

      for (const actor of people) {
        const manager =
          ROLE[actor] === StaffRole.MANAGER || ROLE[actor] === StaffRole.OWNER;
        const me = (
          await request(server())
            .get('/api/v1/staff/me')
            .set(as(actor))
            .expect(200)
        ).body as { pages: string[] };

        expect(me.pages.includes('attendance')).toBe(manager);
        expect(me.pages).toContain('myid');

        // The server holds the same line the shell shows.
        await request(server())
          .get('/api/v1/staff/attendance/people')
          .set(as(actor))
          .expect(manager ? 200 : 403);
        await request(server())
          .get('/api/v1/staff/me/card')
          .set(as(actor))
          .expect(200);
        await request(server())
          .get('/api/v1/staff/me/attendance')
          .set(as(actor))
          .expect(200);
      }

      const reception = (
        await request(server())
          .get('/api/v1/staff/me')
          .set(as('reception'))
          .expect(200)
      ).body as { pages: string[] };
      expect(reception.pages).toContain('reception');
    });

    it('exports the month as the Attendance review', async () => {
      const review = (
        await request(server())
          .get(`/api/v1/staff/attendance/${staffId.f}/export`)
          .query({ from: '2026-10-01', to: '2026-10-31' })
          .set(as('owner'))
          .expect(200)
      ).body as {
        title: string;
        subtitle: string;
        fileName: string;
        columns: string[];
        rows: string[][];
      };

      expect(review.title).toBe(ATTENDANCE_EXPORT_TITLE);
      expect(review.title).toBe('Attendance review');
      expect(review.subtitle).toBe(
        `Attendance f | ${staffNo.f} | 2026-10-01 to 2026-10-31`,
      );
      expect(review.fileName).toBe(
        `CNC-Attendance-review-${staffNo.f}-2026-10-01-to-2026-10-31`,
      );
      expect(review.columns).toEqual([...ATTENDANCE_EXPORT_COLUMNS]);
      expect(review.rows).toEqual([
        [
          '2026-10-07',
          staffNo.f,
          'Attendance f',
          '07 Oct, 07:30',
          '07 Oct, 09:00',
          '1.50',
          'Completed',
          '1',
        ],
        [
          '2026-10-07',
          staffNo.f,
          'Attendance f',
          '07 Oct, 10:00',
          '07 Oct, 11:00',
          '1.00',
          'Completed',
          '0',
        ],
      ]);

      const order = await request(server())
        .get(`/api/v1/staff/attendance/${staffId.f}/export`)
        .query({ from: '2026-10-31', to: '2026-10-01' })
        .set(as('manager'))
        .expect(400);
      expect(messageOf(order)).toBe(PERIOD_ORDER_MESSAGE);

      await request(server())
        .get(`/api/v1/staff/attendance/${staffId.f}/export`)
        .query({ from: '2026-10-01', to: '2026-10-31' })
        .set(as('reception'))
        .expect(403);
    });

    it('lists an open shift as Present with no hours in the export', async () => {
      const review = (
        await request(server())
          .get(`/api/v1/staff/attendance/${staffId.b}/export`)
          .query({ from: '2026-10-02', to: '2026-10-02' })
          .set(as('manager'))
          .expect(200)
      ).body as { rows: string[][]; summary: Page['summary'] };

      expect(review.rows).toEqual([
        [
          '2026-10-02',
          staffNo.b,
          'Attendance b',
          '02 Oct, 09:00',
          '',
          '',
          'Present',
          '0',
        ],
      ]);
      expect(review.summary).toMatchObject({ open: 1, hours: 0 });
    });
  });
});
