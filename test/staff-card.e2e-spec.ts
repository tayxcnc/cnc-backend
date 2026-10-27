import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole } from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { STAFF_NOT_FOUND_MESSAGE } from '../src/auth/staff-auth.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { renderQrSvg } from '../src/common/qr-svg';
import { OWNER_ONLY_MANAGER_CARD_MESSAGE } from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { staffQrPayload } from '../src/staff/staff-qr';
import { createTestApp } from './create-test-app';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Staff ID cards (plan §5.3 My Staff ID, §5.4 Staff & Access): the card's
 * fields, the QR code as an SVG that encodes `CNC-ID:<staff number>:<token>`,
 * and the token never sent as text.
 */
describe('staff ID cards (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;

  interface Person {
    id: string;
    staffNo: string;
    token: string;
  }

  let manager: Person;
  let waiter: Person;

  async function person(role: StaffRole): Promise<Person> {
    const account = await createStaffAccount(prisma, role, {
      emailPrefix: 'card',
      name: `Card ${role.toLowerCase()}`,
    });

    return {
      id: account.id,
      staffNo: account.staffNo,
      token: await accessTokenFor(tokens, account.id),
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    manager = await person(StaffRole.MANAGER);
    waiter = await person(StaffRole.WAITER);
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, who?: Person) => {
    const call = request(app.getHttpServer()).get(`/api/v1${path}`);

    return who ? call.set('Authorization', `Bearer ${who.token}`) : call;
  };

  const qrTokenOf = async (id: string) =>
    (
      await prisma.staff.findUniqueOrThrow({
        where: { id },
        select: { qrToken: true },
      })
    ).qrToken;

  interface Card {
    id: string;
    staffNo: string;
    qrSvg: string;
    isActive: boolean;
  }

  it('answers My Staff ID to anyone, with the code as a picture and never as text', async () => {
    const response = await get('/staff/me/card', waiter).expect(200);
    const body = response.body as Card;

    expect(Object.keys(body).sort()).toEqual([
      'email',
      'id',
      'isActive',
      'joinedOn',
      'name',
      'photoUrl',
      'qrSvg',
      'role',
      'staffNo',
    ]);
    expect(body).toMatchObject({
      id: waiter.id,
      staffNo: waiter.staffNo,
      role: StaffRole.WAITER,
      isActive: true,
      photoUrl: null,
    });

    const token = await qrTokenOf(waiter.id);

    expect(body.qrSvg).toContain('<svg');
    expect(response.text).not.toContain(token);
    // The picture is the staff app's payload, CNC-ID:<number>:<token>.
    expect(body.qrSvg).toBe(
      await renderQrSvg(staffQrPayload(waiter.staffNo, token)),
    );
  });

  it('lets a manager read a staff member’s card, and the code changes when the ID is reissued', async () => {
    const cardOf = async (id: string) =>
      (await get(`/staff/people/${id}/card`, manager).expect(200)).body as Card;

    const before = await cardOf(waiter.id);

    expect(before.staffNo).toBe(waiter.staffNo);

    const { version } = await prisma.staff.findUniqueOrThrow({
      where: { id: waiter.id },
      select: { version: true },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/staff/people/${waiter.id}/qr/regenerate`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ version })
      .expect(200);

    const after = await cardOf(waiter.id);

    expect(after.staffNo).toBe(waiter.staffNo);
    expect(after.qrSvg).not.toBe(before.qrSvg);
  });

  it('keeps other people’s cards for managers, answers 404 for no account and 401 with no token', async () => {
    const refused = await get(
      `/staff/people/${manager.id}/card`,
      waiter,
    ).expect(403);
    expect((refused.body as { message: unknown }).message).toBe(
      ROLE_REFUSED_MESSAGE,
    );

    const missing = await get(
      '/staff/people/no-such-account/card',
      manager,
    ).expect(404);
    expect((missing.body as { message: unknown }).message).toBe(
      STAFF_NOT_FOUND_MESSAGE,
    );

    await get('/staff/me/card').expect(401);
    await get(`/staff/people/${waiter.id}/card`).expect(401);
  });

  it('keeps Manager and Owner cards to the Owner and their holders, and is never cached', async () => {
    const otherManager = await person(StaffRole.MANAGER);
    const owner = await person(StaffRole.OWNER);

    // The QR code is an attendance credential (C5-7) any reader decodes
    // from the SVG; a Manager or Owner account is the Owner's (plan §5.4).
    for (const target of [otherManager, owner]) {
      const refused = await get(
        `/staff/people/${target.id}/card`,
        manager,
      ).expect(403);
      expect((refused.body as { message: unknown }).message).toBe(
        OWNER_ONLY_MANAGER_CARD_MESSAGE,
      );
    }

    // Their holder, and the Owner, still open them.
    await get(`/staff/people/${manager.id}/card`, manager).expect(200);
    await get(`/staff/people/${otherManager.id}/card`, owner).expect(200);
    await get(`/staff/people/${owner.id}/card`, owner).expect(200);

    for (const response of [
      await get(`/staff/people/${waiter.id}/card`, manager).expect(200),
      await get('/staff/me/card', waiter).expect(200),
    ]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });
});
