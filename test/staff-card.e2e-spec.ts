import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole } from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { STAFF_NOT_FOUND_MESSAGE } from '../src/auth/staff-auth.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { renderQrSvg } from '../src/common/qr-svg';
import { PHOTO_CACHE_CONTROL } from '../src/images/photo-response';
import { OWNER_ONLY_MANAGER_CARD_MESSAGE } from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { NO_STAFF_PHOTO_MESSAGE } from '../src/staff/staff-messages';
import { staffQrPayload } from '../src/staff/staff-qr';
import { MediaStorage } from '../src/storage/media-storage';
import { createTestApp } from './create-test-app';
import {
  FAKE_BUCKET,
  type FakeMediaStorage,
  type FakeObject,
} from './fake-media-storage';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { testImage } from './test-images';

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

  /**
   * CS B5: the card's photo as bytes from the API, for the staff app's
   * canvas and PDF, which cannot read the bucket's signed link. The read
   * rule is the card's, exactly; people of their own, so the card tests
   * above keep `photoUrl: null`.
   */
  describe('the photo, streamed (GET /staff/me/photo, GET /staff/people/:id/photo)', () => {
    let storage: FakeMediaStorage;
    let photoWaiter: Person;
    let photoManager: Person;
    let photoOwner: Person;

    /** The person's own upload, through the real route. */
    async function uploadOwnPhoto(who: Person): Promise<FakeObject> {
      const { version } = await prisma.staff.findUniqueOrThrow({
        where: { id: who.id },
        select: { version: true },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/staff/people/${who.id}/photo`)
        .set('Authorization', `Bearer ${who.token}`)
        .field('version', String(version))
        .attach('photo', await testImage(900, 600), 'face.jpg')
        .expect(200);

      const { photo } = await prisma.staff.findUniqueOrThrow({
        where: { id: who.id },
        select: { photo: true },
      });
      const stored = photo === null ? undefined : storage.objectAt(photo);

      if (stored === undefined) throw new Error('The upload stored nothing.');

      return stored;
    }

    const messageOf = (response: request.Response) =>
      (response.body as { message: unknown }).message;

    let waiterPhoto: FakeObject;
    let ownerPhoto: FakeObject;

    beforeAll(async () => {
      storage = app.get<MediaStorage, FakeMediaStorage>(MediaStorage, {
        strict: false,
      });
      photoWaiter = await person(StaffRole.WAITER);
      photoManager = await person(StaffRole.MANAGER);
      photoOwner = await person(StaffRole.OWNER);
      waiterPhoto = await uploadOwnPhoto(photoWaiter);
      ownerPhoto = await uploadOwnPhoto(photoOwner);
    });

    afterEach(() => {
      storage.failReading = false;
    });

    /** A 200 photo answer: the stored bytes, type and caching. */
    async function expectPhoto(
      response: request.Response,
      stored: FakeObject,
    ): Promise<void> {
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(Buffer.isBuffer(response.body)).toBe(true);
      expect(Buffer.compare(response.body as Buffer, stored.body)).toBe(0);
      expect(response.headers['content-length']).toBe(
        String(stored.body.length),
      );
      expect(response.headers['cache-control']).toBe(PHOTO_CACHE_CONTROL);
      // Appended to CORS's own Vary: Origin, never replacing it.
      expect(response.headers['vary']).toMatch(/\bAuthorization\b/);
      expect(response.headers['vary']).toMatch(/\bOrigin\b/);

      // As stored at upload: the 320-pixel staff square, nothing resized.
      const meta = await sharp(response.body as Buffer).metadata();
      expect([meta.width, meta.height]).toEqual([320, 320]);
    }

    it('streams your own photo to any role, as stored, cached by the browser only', async () => {
      await expectPhoto(
        await get('/staff/me/photo', photoWaiter).expect(200),
        waiterPhoto,
      );
      await expectPhoto(
        await get('/staff/me/photo', photoOwner).expect(200),
        ownerPhoto,
      );
      expect(PHOTO_CACHE_CONTROL).toBe('private, max-age=300');
    });

    it('lets a manager read a waiter’s photo', async () => {
      await expectPhoto(
        await get(`/staff/people/${photoWaiter.id}/photo`, photoManager).expect(
          200,
        ),
        waiterPhoto,
      );
    });

    it('refuses a Manager the Owner’s photo with the card’s sentence; the Owner reads it', async () => {
      const refused = await get(
        `/staff/people/${photoOwner.id}/photo`,
        photoManager,
      ).expect(403);

      expect(messageOf(refused)).toBe(OWNER_ONLY_MANAGER_CARD_MESSAGE);
      expect(refused.headers['cache-control']).not.toBe(PHOTO_CACHE_CONTROL);

      await expectPhoto(
        await get(`/staff/people/${photoOwner.id}/photo`, photoOwner).expect(
          200,
        ),
        ownerPhoto,
      );
    });

    it('refuses a waiter another person’s photo, and its own through the managers’ route, as the card does', async () => {
      for (const id of [photoManager.id, photoOwner.id, photoWaiter.id]) {
        const refused = await get(
          `/staff/people/${id}/photo`,
          photoWaiter,
        ).expect(403);

        expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);
      }
    });

    it('answers 404 for no photo, a photo gone from the bucket and no account, and 401 with no token', async () => {
      const none = await get('/staff/me/photo', photoManager).expect(404);
      expect(messageOf(none)).toBe(NO_STAFF_PHOTO_MESSAGE);
      expect(none.headers['cache-control']).not.toBe(PHOTO_CACHE_CONTROL);

      const managerNone = await get(
        `/staff/people/${photoManager.id}/photo`,
        photoOwner,
      ).expect(404);
      expect(messageOf(managerNone)).toBe(NO_STAFF_PHOTO_MESSAGE);

      expect(
        messageOf(
          await get('/staff/people/no-such-account/photo', photoOwner).expect(
            404,
          ),
        ),
      ).toBe(STAFF_NOT_FOUND_MESSAGE);

      // The row names an object the bucket no longer holds.
      const gone = await person(StaffRole.CASHIER);
      await prisma.staff.update({
        where: { id: gone.id },
        data: { photo: `gs://${FAKE_BUCKET}/staff/${gone.id}/photo-gone.jpg` },
      });
      const goneNone = await get('/staff/me/photo', gone).expect(404);
      expect(messageOf(goneNone)).toBe(NO_STAFF_PHOTO_MESSAGE);

      await get('/staff/me/photo').expect(401);
      await get(`/staff/people/${photoWaiter.id}/photo`).expect(401);
    });

    it('fails the request when the bucket cannot be read, rather than claiming there is no photo', async () => {
      storage.failReading = true;

      const failed = await get('/staff/me/photo', photoWaiter).expect(500);
      expect(failed.headers['cache-control']).not.toBe(PHOTO_CACHE_CONTROL);
    });
  });
});
