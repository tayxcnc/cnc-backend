import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import sharp from 'sharp';
import {
  ContactChannel,
  OtpPurpose,
  OutboundMessageStatus,
  ReservationSource,
  ReservationStatus,
  SubjectType,
  TableKind,
} from '../generated/cnc-client';
import {
  PROFILE_SAVE_LIMIT,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from '../src/auth/auth-throttle';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { CUSTOMER_REFRESH_COOKIE } from '../src/auth/refresh-cookie';
import { addDays } from '../src/common/calendar-date';
import {
  DELIVERY_LANDMARK_MESSAGE,
  DELIVERY_ZONE_MESSAGE,
} from '../src/common/delivery-address';
import { watToday } from '../src/common/wat';
import { CncConfigService } from '../src/config/cnc.config';
import {
  DELETE_WITH_UPCOMING_MESSAGE,
  DELETED_CUSTOMER_NAME,
} from '../src/customers/customer-deletion.service';
import {
  EMAIL_TAKEN_MESSAGE,
  SAME_EMAIL_MESSAGE,
} from '../src/customers/customer-email.service';
import { CustomerService } from '../src/customers/customer.service';
import { CHECK_EMAIL_MESSAGE } from '../src/customers/dto/change-email.request';
import { ASK_FOR_NEW_CODE_MESSAGE } from '../src/customers/otp.service';
import {
  KEEP_A_CONTACT_MESSAGE,
  OFFERS_UNAVAILABLE_MESSAGE,
  PHONE_MESSAGE,
  PHONE_TAKEN_MESSAGE,
  PROFILE_ADDRESS_LINES_MESSAGE,
  SMS_UNAVAILABLE_MESSAGE,
} from '../src/customers/profile-rules';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { MediaStorage } from '../src/storage/media-storage';
import { createTestApp, sentMail } from './create-test-app';
import type { FakeMediaStorage } from './fake-media-storage';
import { clientAddress } from './staff-sessions';
import { testImage } from './test-images';

interface Profile {
  id: string;
  memberNo: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: {
    zone: string;
    street: string;
    area: string;
    town: string;
    landmark: string;
  } | null;
  prefs: {
    orderUpdates: boolean;
    bookingReminders: boolean;
    offers: boolean;
    channel: string;
  };
  photoUrl: string | null;
}

const newEmail = () => `account-${randomUUID()}@cnc.test`;

/** A run-unique Nigerian mobile number, `080` and eight digits. */
const newPhone = () =>
  `080${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

const ADDRESS = {
  zone: 'JOS',
  street: '12 Rayfield Road',
  area: 'Rayfield',
  town: 'Jos',
  landmark: 'Opposite the filling station',
};

/**
 * The customer's own account (card C6-3) through HTTP and against
 * Postgres: `PATCH /me` (phone, address, preferences), the two-step email
 * change, the photo, and deleting the account (Q36: anonymised).
 *
 * Customers are run-unique and made through `CustomerService` with a
 * token minted directly, except where the cookie matters (deletion), so
 * no test meets the sign-in throttles. Mail is read from the harness's
 * recording transport, as a customer reads their inbox.
 */
describe('customer account (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let customers: CustomerService;
  let storage: FakeMediaStorage;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });
    customers = app.get(CustomerService, { strict: false });
    storage = app.get<FakeMediaStorage>(MediaStorage, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  /** A 400 from a request field answers a list; a service refusal, a sentence. */
  const sentence = (response: request.Response) =>
    [messageOf(response)].flat()[0];

  /** A verified customer with a session, made directly. */
  async function customer(email: string | null = newEmail()) {
    let id: string;

    if (email === null) {
      id = (
        await prisma.customer.create({
          data: {
            memberNo: await drawNumber(prisma, 'customer'),
            name: 'Checkout Guest',
            phone: newPhone(),
          },
          select: { id: true },
        })
      ).id;
    } else {
      id = (
        await prisma.$transaction((tx) =>
          customers.findOrCreateVerified(tx, email),
        )
      ).id;
    }

    const pair = await tokens.issueTokenPair(id, SubjectType.CUSTOMER);

    return {
      id,
      email,
      auth: { Authorization: `Bearer ${pair.accessToken}` },
    };
  }

  type Customer = Awaited<ReturnType<typeof customer>>;

  const patchMe = (who: Customer, body: Record<string, unknown>) =>
    request(server()).patch('/api/v1/me').set(who.auth).send(body);

  const askEmailCode = (who: Customer, email: unknown) =>
    request(server())
      .post('/api/v1/me/email/code')
      .set(who.auth)
      .set('X-Forwarded-For', clientAddress())
      .send({ email });

  const verifyEmail = (who: Customer, email: unknown, code: unknown) =>
    request(server())
      .post('/api/v1/me/email/verify')
      .set(who.auth)
      .set('X-Forwarded-For', clientAddress())
      .send({ email, code });

  const codeSentTo = (email: string): string => {
    const code = sentMail(app)
      .lastTo(email)
      ?.text.match(/\b(\d{6})\b/)?.[1];

    if (code === undefined) throw new Error(`No code was mailed to ${email}.`);

    return code;
  };

  describe('GET and PATCH /me', () => {
    it('answers the profile and never lets it be cached', async () => {
      const me = await customer();
      const response = await request(server())
        .get('/api/v1/me')
        .set(me.auth)
        .expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
      expect((response.body as Profile).email).toBe(me.email);
    });

    it('stores a phone as 0 plus ten digits and removes it when blank', async () => {
      const me = await customer();
      const digits = newPhone();
      const spaced = `+234 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;

      const saved = await patchMe(me, { phone: spaced }).expect(200);
      expect((saved.body as Profile).phone).toBe(digits);

      const cleared = await patchMe(me, { phone: '  ' }).expect(200);
      expect((cleared.body as Profile).phone).toBeNull();

      const wrong = await patchMe(me, { phone: '12345' }).expect(400);
      expect(sentence(wrong)).toBe(PHONE_MESSAGE);
    });

    it('refuses a phone another account holds (409)', async () => {
      const first = await customer();
      const second = await customer();
      const phone = newPhone();

      await patchMe(first, { phone }).expect(200);
      const taken = await patchMe(second, { phone }).expect(409);

      expect(messageOf(taken)).toBe(PHONE_TAKEN_MESSAGE);
    });

    it(`counts saves per customer, ${PROFILE_SAVE_LIMIT} in the window, so numbers cannot be tried as a list (429)`, async () => {
      const me = await customer();
      const other = await customer();

      for (let saved = 0; saved < PROFILE_SAVE_LIMIT; saved++) {
        await patchMe(me, { phone: newPhone() }).expect(200);
      }

      const refused = await patchMe(me, { phone: newPhone() }).expect(429);
      expect(messageOf(refused)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
      // Another customer's saves are their own count.
      await patchMe(other, { name: 'Bola' }).expect(200);
    });

    it('keeps a phone on an account with no email', async () => {
      const guest = await customer(null);
      const refused = await patchMe(guest, { phone: null }).expect(400);

      expect(messageOf(refused)).toBe(KEEP_A_CONTACT_MESSAGE);
    });

    it('saves the whole address with its zone and landmark (D53), and removes it', async () => {
      const me = await customer();

      const saved = await patchMe(me, {
        address: { ...ADDRESS, street: '  12 Rayfield Road ' },
      }).expect(200);
      expect((saved.body as Profile).address).toEqual(ADDRESS);

      const noLandmark = await patchMe(me, {
        address: { ...ADDRESS, landmark: '' },
      }).expect(400);
      expect(sentence(noLandmark)).toBe(DELIVERY_LANDMARK_MESSAGE);

      const noZone = await patchMe(me, {
        address: { ...ADDRESS, zone: 'ABUJA' },
      }).expect(400);
      expect(sentence(noZone)).toBe(DELIVERY_ZONE_MESSAGE);

      const noArea = await patchMe(me, {
        address: { ...ADDRESS, area: '' },
      }).expect(400);
      expect(sentence(noArea)).toBe(PROFILE_ADDRESS_LINES_MESSAGE);

      const removed = await patchMe(me, { address: null }).expect(200);
      expect((removed.body as Profile).address).toBeNull();
    });

    it('changes only the switches sent, and refuses offers and SMS', async () => {
      const me = await customer();
      const before = (
        await request(server()).get('/api/v1/me').set(me.auth).expect(200)
      ).body as Profile;

      const saved = await patchMe(me, {
        prefs: { bookingReminders: !before.prefs.bookingReminders },
      }).expect(200);
      expect((saved.body as Profile).prefs).toEqual({
        ...before.prefs,
        bookingReminders: !before.prefs.bookingReminders,
      });

      const offers = await patchMe(me, { prefs: { offers: true } }).expect(400);
      expect(messageOf(offers)).toBe(OFFERS_UNAVAILABLE_MESSAGE);

      const sms = await patchMe(me, { prefs: { channel: 'SMS' } }).expect(400);
      expect(messageOf(sms)).toBe(SMS_UNAVAILABLE_MESSAGE);
    });

    it('takes neither the email nor the photo', async () => {
      const me = await customer();

      await patchMe(me, { email: newEmail() }).expect(400);
      await patchMe(me, { photo: 'gs://elsewhere/x.jpg' }).expect(400);
    });
  });

  describe('the email change', () => {
    it('sends a code to the new address and changes the email only once it is verified', async () => {
      const me = await customer();
      const next = newEmail();

      const asked = await askEmailCode(me, next.toUpperCase()).expect(200);
      expect(asked.body).toEqual({ sentTo: 'a•••@cnc.test', resendInSec: 30 });

      const code = codeSentTo(next);
      expect(asked.text).not.toContain(code);
      expect(sentMail(app).lastTo(next)?.subject).toBe(
        `${code} is your code to change your CNC email`,
      );

      // Not yet changed.
      const still = await request(server())
        .get('/api/v1/me')
        .set(me.auth)
        .expect(200);
      expect((still.body as Profile).email).toBe(me.email);

      const verified = await verifyEmail(me, next, code).expect(200);
      expect((verified.body as Profile).email).toBe(next);

      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: me.id },
      });
      expect(row.email).toBe(next);
      expect(row.emailVerifiedAt).not.toBeNull();

      // The old address is told, with the new one masked.
      const notice = sentMail(app).lastTo(me.email!);
      expect(notice?.subject).toBe('Your CNC sign-in email has changed');
      expect(notice?.text).toContain('a•••@cnc.test');
      expect(notice?.text).not.toContain(next);
      // Replies go to CNC's inbox.
      expect(notice?.replyTo).toBe(app.get(CncConfigService).contactEmail);

      // The code is spent.
      const again = await verifyEmail(me, next, code).expect(400);
      expect(messageOf(again)).toBe(ASK_FOR_NEW_CODE_MESSAGE);
    });

    it('refuses the address the account already has, and a malformed one', async () => {
      const me = await customer();

      const same = await askEmailCode(me, me.email).expect(400);
      expect(messageOf(same)).toBe(SAME_EMAIL_MESSAGE);

      const bad = await askEmailCode(me, 'not-an-email').expect(400);
      expect(sentence(bad)).toBe(CHECK_EMAIL_MESSAGE);
    });

    it('lets only the account that asked use the code', async () => {
      const asker = await customer();
      const other = await customer();
      const next = newEmail();

      await askEmailCode(asker, next).expect(200);
      const code = codeSentTo(next);

      const refused = await verifyEmail(other, next, code).expect(400);
      expect(messageOf(refused)).toBe(ASK_FOR_NEW_CODE_MESSAGE);

      await verifyEmail(asker, next, code).expect(200);
    });

    it('says another account holds the address only after the code proves the inbox', async () => {
      const holder = await customer();
      const me = await customer();

      // Asking says nothing either way.
      await askEmailCode(me, holder.email).expect(200);
      const code = codeSentTo(holder.email!);

      const taken = await verifyEmail(me, holder.email, code).expect(409);
      expect(messageOf(taken)).toBe(EMAIL_TAKEN_MESSAGE);

      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: me.id },
      });
      expect(row.email).toBe(me.email);

      const codeRow = await prisma.otpCode.findFirstOrThrow({
        where: { contact: holder.email!, purpose: OtpPurpose.CHANGE_EMAIL },
      });
      expect(codeRow.customerId).toBe(me.id);
    });
  });

  describe('the photo', () => {
    const upload = (who: Customer, file: Buffer, name = 'face.jpg') =>
      request(server())
        .post('/api/v1/me/photo')
        .set(who.auth)
        .attach('photo', file, name);

    it('stores a square of at most 256 pixels, replaces the old one and deletes it', async () => {
      const me = await customer();

      const first = await upload(me, await testImage(900, 600)).expect(200);
      expect((first.body as Profile).photoUrl).toMatch(
        /^https:\/\/storage\.test\/.+\/customer\//,
      );

      const firstUri = (
        await prisma.customer.findUniqueOrThrow({ where: { id: me.id } })
      ).photo!;
      const stored = storage.objectAt(firstUri)!;
      const meta = await sharp(stored.body).metadata();
      expect(meta.width).toBe(256);
      expect(meta.height).toBe(256);

      await upload(me, await testImage(400, 400, 'png'), 'face.png').expect(
        200,
      );
      const secondUri = (
        await prisma.customer.findUniqueOrThrow({ where: { id: me.id } })
      ).photo!;
      expect(secondUri).not.toBe(firstUri);
      expect(storage.objectAt(firstUri)).toBeUndefined();

      const removed = await request(server())
        .delete('/api/v1/me/photo')
        .set(me.auth)
        .expect(200);
      expect((removed.body as Profile).photoUrl).toBeNull();
      expect(storage.objectAt(secondUri)).toBeUndefined();
    });

    it('refuses a file that is not an image by its bytes', async () => {
      const me = await customer();

      await upload(
        me,
        Buffer.from('%PDF-1.7 not a photo at all'),
        'face.jpg',
      ).expect(415);
    });
  });

  describe('DELETE /me (Q36)', () => {
    let tableId: string;

    beforeAll(async () => {
      const venue = await prisma.venue.create({
        data: {
          slug: `account-test-${randomUUID()}`,
          customerTitle: 'Account Test',
          staffName: 'Account Test',
          bigParty: 4,
          sort: 900,
        },
      });

      tableId = (
        await prisma.diningTable.create({
          data: {
            venueId: venue.id,
            code: 'AT1',
            name: 'Account table',
            kind: TableKind.DINING,
            capacity: 4,
          },
        })
      ).id;
    });

    const booking = async (
      customerId: string,
      days: number,
      status: ReservationStatus = ReservationStatus.CONFIRMED,
      source: ReservationSource = ReservationSource.APP,
    ) =>
      prisma.reservation.create({
        data: {
          number: await drawNumber(prisma, 'reservation'),
          tableId,
          customerId,
          name: 'Ada Obi',
          phone: '08031234567',
          email: 'ada@example.com',
          businessDate: addDays(watToday(new Date()), days),
          startMinutes: 1140,
          party: 2,
          status,
          source,
          note: 'Window please',
          guestNote: 'Window please',
        },
      });

    /** Sign in through the routes, for the cookie. */
    async function signIn(email: string) {
      await request(server())
        .post('/api/v1/auth/code')
        .set('X-Forwarded-For', clientAddress())
        .send({ email })
        .expect(200);
      const verified = await request(server())
        .post('/api/v1/auth/verify')
        .set('X-Forwarded-For', clientAddress())
        .send({ email, code: codeSentTo(email) })
        .expect(200);
      const cookie = (verified.headers['set-cookie'] as unknown as string[])
        .find((line) => line.startsWith(`${CUSTOMER_REFRESH_COOKIE}=`))!
        .split(';')[0];
      const body = verified.body as { accessToken: string; customer: Profile };

      return {
        id: body.customer.id,
        memberNo: body.customer.memberNo,
        cookie,
        auth: { Authorization: `Bearer ${body.accessToken}` },
      };
    }

    it('is refused while a booking is still to come', async () => {
      const me = await customer();
      await booking(me.id, 1);

      const refused = await request(server())
        .delete('/api/v1/me')
        .set(me.auth)
        .expect(409);
      expect(messageOf(refused)).toBe(DELETE_WITH_UPCOMING_MESSAGE);
    });

    it('is not blocked by an upcoming website or Reception booking linked by email: it is unlinked and kept', async () => {
      const me = await customer();
      // Anyone can book under someone's email; Q35 links it to them.
      const web = await booking(
        me.id,
        0,
        ReservationStatus.CONFIRMED,
        ReservationSource.WEB,
      );
      const desk = await booking(
        me.id,
        2,
        ReservationStatus.CONFIRMED,
        ReservationSource.RECEPTION,
      );

      await request(server()).delete('/api/v1/me').set(me.auth).expect(204);

      for (const made of [web, desk]) {
        expect(
          await prisma.reservation.findUniqueOrThrow({
            where: { id: made.id },
          }),
        ).toMatchObject({
          customerId: null,
          name: 'Ada Obi',
          status: ReservationStatus.CONFIRMED,
          version: made.version,
        });
      }
    });

    it('anonymises the account and its bookings, ends every session, and a new sign-in starts afresh', async () => {
      const email = newEmail();
      const me = await signIn(email);

      await patchMe(
        { id: me.id, email, auth: me.auth },
        { name: 'Ada Obi', phone: newPhone(), address: ADDRESS },
      ).expect(200);
      await request(server())
        .post('/api/v1/me/photo')
        .set(me.auth)
        .attach('photo', await testImage(300, 300), 'face.jpg')
        .expect(200);
      const photo = (
        await prisma.customer.findUniqueOrThrow({ where: { id: me.id } })
      ).photo!;
      const past = await booking(me.id, -3, ReservationStatus.COMPLETED);
      // Its confirmation went to the address the account had before an
      // email change; the sign-in code's email went to this one.
      const earlier = newEmail();
      const confirmation = await prisma.outboundMessage.create({
        data: {
          channel: ContactChannel.EMAIL,
          to: earlier,
          template: 'reservation.confirmed',
          dedupeKey: `reservation:${past.id}:confirmed`,
          status: OutboundMessageStatus.SENT,
        },
      });
      expect(
        await prisma.outboundMessage.count({ where: { to: email } }),
      ).toBeGreaterThan(0);

      const deleted = await request(server())
        .delete('/api/v1/me')
        .set(me.auth)
        .expect(204);
      const cleared = (
        deleted.headers['set-cookie'] as unknown as string[]
      ).find((line) => line.startsWith(`${CUSTOMER_REFRESH_COOKIE}=`));
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);

      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: me.id },
      });
      expect(row).toMatchObject({
        name: '',
        email: null,
        phone: null,
        photo: null,
        addressZone: null,
        addressStreet: null,
        addressLandmark: null,
        prefOffers: false,
      });
      expect(row.deletedAt).not.toBeNull();
      expect(storage.objectAt(photo)).toBeUndefined();

      const kept = await prisma.reservation.findUniqueOrThrow({
        where: { id: past.id },
      });
      expect(kept).toMatchObject({
        customerId: me.id,
        name: DELETED_CUSTOMER_NAME,
        phone: '',
        email: '',
        note: '',
        guestNote: '',
        version: past.version + 1,
      });

      expect(await prisma.otpCode.count({ where: { contact: email } })).toBe(0);
      // No message row ties an anonymised booking, or anything, back to the
      // person's address: neither the current one nor an earlier one.
      expect(await prisma.outboundMessage.count({ where: { to: email } })).toBe(
        0,
      );
      expect(
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { id: confirmation.id },
        }),
      ).toMatchObject({ to: '', payload: null });
      expect(
        await prisma.outboundMessage.count({ where: { to: earlier } }),
      ).toBe(0);

      // The access token is refused at once, and the session cannot renew.
      await request(server()).get('/api/v1/me').set(me.auth).expect(401);
      await request(server())
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', clientAddress())
        .set('Cookie', me.cookie)
        .set('Content-Type', 'application/json')
        .send({})
        .expect(401);

      // The same email signs in to a new, empty account.
      const again = await signIn(email);
      expect(again.id).not.toBe(me.id);
      expect(again.memberNo).not.toBe(me.memberNo);
    });

    it('a deleted account cannot be given a contact back (the CHECK)', async () => {
      const me = await customer();

      await request(server()).delete('/api/v1/me').set(me.auth).expect(204);

      await expect(
        prisma.customer.update({
          where: { id: me.id },
          data: { email: newEmail() },
        }),
      ).rejects.toThrow();
    });

    it('lets a past, finished booking stand in the way of nothing', async () => {
      const me = await customer();
      await booking(me.id, -1, ReservationStatus.COMPLETED);
      // A booking dated in the past that nobody closed does not hold the
      // account either: it is not still to come.
      await booking(me.id, -2);

      await request(server()).delete('/api/v1/me').set(me.auth).expect(204);
    });
  });
});
