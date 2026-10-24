/*
 * CNC's inbox, set before the app is built so the suite does not depend on
 * the developer's `.env` (`ConfigModule` never overwrites a value already
 * present; Jest gives each file its own copy of process.env).
 */
const INBOX = 'cnc-inbox@cnc.test';

process.env.CNC_CONTACT_EMAIL = INBOX;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  EnquiryKind,
  EnquiryStatus,
  OutboundMessageStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { TOO_MANY_ATTEMPTS_MESSAGE } from '../src/auth/auth-throttle';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { hashClientAddress } from '../src/common/client-address';
import { watToday } from '../src/common/wat';
import {
  CONTACT_EMAIL_MESSAGE,
  CONTACT_MESSAGE_LENGTH_MESSAGE,
  CONTACT_REQUIRED_MESSAGE,
  CONTACT_SUBJECT_MESSAGE,
  GROUP_EMAIL_MESSAGE,
  GROUP_GUESTS_MESSAGE,
  GROUP_NAME_MESSAGE,
  GROUP_PHONE_MESSAGE,
  GROUP_VENUE_MESSAGE,
} from '../src/enquiries/enquiry-messages';
import {
  ENQUIRY_ADDRESS_LIMIT,
  ENQUIRY_REQUEST_LIMIT,
} from '../src/enquiries/enquiry-rules';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { PAST_DATE_MESSAGE } from '../src/reception/reception-messages';
import { createTestApp, sentMail } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { clientAddress } from './staff-sessions';

/**
 * The website's enquiry forms (card C6-7) through HTTP and against
 * Postgres: `POST /enquiries` (the Contact page) and `POST
 * /group-enquiries` (the large-party callback). Each is stored, then
 * emailed to CNC's inbox through the outbound queue with Reply-To set to
 * the sender (Q20: no staff list); the honeypot keeps nothing; the stored
 * cap and the route's throttle answer 429.
 *
 * On a database of its own (`createIsolatedDatabase`), seeded with the
 * real rooms, so the per-address counts and the rows are this suite's.
 * Every test sends from a fresh address unless it is testing the address.
 */
describe('enquiries (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    await seedData(prisma);
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  afterEach(() => {
    sentMail(app).configured = true;
    sentMail(app).failWith = undefined;
  });

  const server = () => app.getHttpServer();
  const sentence = (response: request.Response) =>
    [(response.body as { message: unknown }).message].flat();
  /** The caller's own address, as `clientAddressOf` reads the header. */
  const callerOf = (address: string) => address.split(',')[0].trim();
  const inDays = (days: number) =>
    formatIsoDate(addDays(watToday(new Date()), days));

  const contactBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Ada Okafor',
    email: `ada-${randomUUID()}@example.com`,
    subject: 'Dining enquiry',
    message: 'Do you have a table by the window on Friday?',
    ...overrides,
  });

  const groupBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Bola Ade',
    phone: '0803 123 4567',
    email: `bola-${randomUUID()}@example.com`,
    venue: 'lounge',
    date: inDays(3),
    guests: '8 guests',
    message: 'A birthday dinner.',
    ...overrides,
  });

  const contact = (body: Record<string, unknown>, address = clientAddress()) =>
    request(server())
      .post('/api/v1/enquiries')
      .set('X-Forwarded-For', address)
      .send(body);

  const group = (body: Record<string, unknown>, address = clientAddress()) =>
    request(server())
      .post('/api/v1/group-enquiries')
      .set('X-Forwarded-For', address)
      .send(body);

  /** The inbox's mail whose text carries `marker`. */
  const inboxMail = (marker: string) =>
    sentMail(app)
      .allTo(INBOX)
      .filter((mail) => mail.text.includes(marker));

  describe('POST /enquiries', () => {
    it('stores the message and emails it to CNC with Reply-To the sender', async () => {
      const address = clientAddress();
      const body = contactBody({
        name: '  Ada <b>Okafor</b> ',
        email: `  Ada-${randomUUID()}@Example.com `,
        message: 'Line one\nLine two',
      });
      const email = String(body.email).trim().toLowerCase();

      const response = await contact(body, address).expect(204);
      expect(response.text).toBe('');
      expect(response.headers['cache-control']).toBe('no-store');

      const row = await prisma.enquiry.findFirstOrThrow({ where: { email } });
      expect(row).toMatchObject({
        kind: EnquiryKind.CONTACT,
        name: 'Ada <b>Okafor</b>',
        subject: 'Dining enquiry',
        message: 'Line one\nLine two',
        status: EnquiryStatus.NEW,
        phone: null,
        venueId: null,
        ipHash: hashClientAddress(callerOf(address)),
      });

      const [mail] = inboxMail(email);
      expect(mail).toBeDefined();
      expect(mail.subject).toBe('CNC enquiry: Dining enquiry');
      expect(mail.replyTo).toBe(email);
      expect(mail.text).toContain('Line one\nLine two');
      expect(mail.html).toContain('Ada &lt;b&gt;Okafor&lt;/b&gt;');
      expect(mail.html).not.toContain('<b>Okafor</b>');

      const message = await prisma.outboundMessage.findUniqueOrThrow({
        where: { dedupeKey: `enquiry:${row.id}` },
      });
      expect(message).toMatchObject({
        to: INBOX,
        template: 'enquiry.contact',
        status: OutboundMessageStatus.SENT,
        payload: null,
      });
      // A week to reach the inbox, not the default day.
      // (createdAt is the database's clock, expiresAt the service's.)
      expect(
        Math.abs(
          message.expiresAt!.getTime() -
            message.createdAt.getTime() -
            7 * 24 * 60 * 60 * 1000,
        ),
      ).toBeLessThan(60 * 1000);
    });

    it('says the site’s one sentence once for whatever is missing, and new sentences for the rest', async () => {
      for (const [body, expected] of [
        [contactBody({ name: '' }), [CONTACT_REQUIRED_MESSAGE]],
        [
          contactBody({ name: '', email: '', message: '' }),
          [CONTACT_REQUIRED_MESSAGE],
        ],
        [contactBody({ email: '  ' }), [CONTACT_REQUIRED_MESSAGE]],
        [contactBody({ message: '   ' }), [CONTACT_REQUIRED_MESSAGE]],
        [contactBody({ email: 'not-an-email' }), [CONTACT_EMAIL_MESSAGE]],
        [contactBody({ subject: '' }), [CONTACT_SUBJECT_MESSAGE]],
        [
          contactBody({ message: 'x'.repeat(3001) }),
          [CONTACT_MESSAGE_LENGTH_MESSAGE],
        ],
        [{ ...contactBody(), extra: 1 }, ['property extra should not exist']],
      ] as [Record<string, unknown>, string[]][]) {
        const response = await contact(body).expect(400);
        expect(sentence(response)).toEqual(expected);
      }

      expect(await prisma.enquiry.count({ where: { name: '' } })).toBe(0);
    });

    it('answers a filled honeypot exactly as a received enquiry, and keeps and sends nothing', async () => {
      for (const company of ['Acme Ltd', 7, ['x'], { a: 1 }]) {
        const body = contactBody({ company });
        const response = await contact(body).expect(204);

        expect(response.text).toBe('');
        expect(
          await prisma.enquiry.count({ where: { email: String(body.email) } }),
        ).toBe(0);
        expect(inboxMail(String(body.email))).toHaveLength(0);
      }

      // An empty honeypot is a person.
      const person = contactBody({ company: '' });
      await contact(person).expect(204);
      expect(
        await prisma.enquiry.count({ where: { email: String(person.email) } }),
      ).toBe(1);
    });

    it('stores the enquiry and keeps its email queued while mail is not configured', async () => {
      sentMail(app).configured = false;
      const body = contactBody();

      await contact(body).expect(204);

      const row = await prisma.enquiry.findFirstOrThrow({
        where: { email: String(body.email) },
      });
      expect(
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { dedupeKey: `enquiry:${row.id}` },
        }),
      ).toMatchObject({
        status: OutboundMessageStatus.PENDING,
        attempts: 0,
        lastError: 'Mail is not configured.',
      });
      expect(inboxMail(String(body.email))).toHaveLength(0);
    });

    it('still answers 204 when the provider refuses the send, and records the failure for the sweep', async () => {
      sentMail(app).failWith = new Error('Rejected by Resend: test refusal');
      const body = contactBody();

      await contact(body).expect(204);

      const row = await prisma.enquiry.findFirstOrThrow({
        where: { email: String(body.email) },
      });
      const message = await prisma.outboundMessage.findUniqueOrThrow({
        where: { dedupeKey: `enquiry:${row.id}` },
      });
      expect(message).toMatchObject({
        status: OutboundMessageStatus.FAILED,
        attempts: 1,
        lastError: 'Rejected by Resend: test refusal',
      });
      expect(message.retryAfter).not.toBeNull();
    });
  });

  describe('POST /group-enquiries', () => {
    it('stores the callback request and emails it to CNC', async () => {
      const body = groupBody({ phone: '+234 803 123 4567' });

      await group(body).expect(204);

      const lounge = await prisma.venue.findUniqueOrThrow({
        where: { slug: 'lounge' },
      });
      const row = await prisma.enquiry.findFirstOrThrow({
        where: { email: String(body.email) },
      });
      expect(row).toMatchObject({
        kind: EnquiryKind.GROUP,
        name: 'Bola Ade',
        phone: '08031234567',
        venueId: lounge.id,
        guests: '8 guests',
        message: 'A birthday dinner.',
        subject: null,
      });
      expect(formatIsoDate(row.requestedDate!)).toBe(body.date);

      const [mail] = inboxMail(String(body.email));
      expect(mail.subject).toMatch(
        /^CNC large group: 8 guests in the Lounge on \w{3} \d{1,2} \w{3} \d{4}$/,
      );
      expect(mail.replyTo).toBe(body.email);
      expect(mail.text).toContain('Phone: 08031234567');
      expect(mail.text).toContain('A birthday dinner.');
    });

    it('needs no email or note: the reply goes to CNC’s own inbox', async () => {
      const marker = `Caller ${randomUUID().slice(0, 8)}`;

      await group(
        groupBody({ name: marker, email: '', message: undefined }),
      ).expect(204);

      const row = await prisma.enquiry.findFirstOrThrow({
        where: { name: marker },
      });
      expect(row).toMatchObject({ email: null, message: '' });

      const [mail] = inboxMail(marker);
      expect(mail.text).not.toContain('Email:');
      // The default Reply-To: CNC's own inbox.
      expect(mail.replyTo).toBe(INBOX);
    });

    it('answers with the site’s sentences and the new ones', async () => {
      for (const [body, expected] of [
        [groupBody({ name: ' ' }), [GROUP_NAME_MESSAGE]],
        [groupBody({ phone: '12345' }), [GROUP_PHONE_MESSAGE]],
        [groupBody({ phone: '+44 20 7946 0000' }), [GROUP_PHONE_MESSAGE]],
        [groupBody({ email: 'nope' }), [GROUP_EMAIL_MESSAGE]],
        [groupBody({ guests: '' }), [GROUP_GUESTS_MESSAGE]],
        [groupBody({ venue: '' }), [GROUP_VENUE_MESSAGE]],
        [groupBody({ venue: 'rooftop' }), [GROUP_VENUE_MESSAGE]],
        [
          groupBody({ date: '2026-02-30' }),
          ['Enter a valid reservation date.'],
        ],
        [groupBody({ date: inDays(-1) }), [PAST_DATE_MESSAGE]],
      ] as [Record<string, unknown>, string[]][]) {
        const response = await group(body).expect(400);
        expect(sentence(response)).toEqual(expected);
      }
    });

    it('keeps nothing for a filled honeypot, even with a room that does not exist', async () => {
      const body = groupBody({ company: 'bot', venue: 'rooftop' });

      await group(body).expect(204);
      expect(
        await prisma.enquiry.count({ where: { email: String(body.email) } }),
      ).toBe(0);
    });
  });

  describe('the limits', () => {
    it(`stores ${ENQUIRY_ADDRESS_LIMIT} enquiries per address an hour across both forms, then answers 429; another address is not affected`, async () => {
      const address = clientAddress();
      const ipHash = hashClientAddress(callerOf(address));

      for (let index = 0; index < ENQUIRY_ADDRESS_LIMIT; index++) {
        const send = index % 2 === 0 ? contact : group;
        const body = index % 2 === 0 ? contactBody() : groupBody();

        await send(body, address).expect(204);
      }

      const refused = await contact(contactBody(), address).expect(429);
      expect(sentence(refused)).toEqual([TOO_MANY_ATTEMPTS_MESSAGE]);
      await group(groupBody(), address).expect(429);
      expect(await prisma.enquiry.count({ where: { ipHash } })).toBe(
        ENQUIRY_ADDRESS_LIMIT,
      );

      await contact(contactBody()).expect(204);
    });

    it('lets no burst from one address past the stored cap (three rounds)', async () => {
      for (let round = 0; round < 3; round++) {
        const address = clientAddress();
        const responses = await Promise.all(
          Array.from({ length: ENQUIRY_ADDRESS_LIMIT + 3 }, () =>
            contact(contactBody(), address),
          ),
        );
        const statuses = responses.map((response) => response.status).sort();

        expect(statuses.filter((status) => status === 204)).toHaveLength(
          ENQUIRY_ADDRESS_LIMIT,
        );
        expect(statuses.filter((status) => status === 429)).toHaveLength(3);
        expect(
          await prisma.enquiry.count({
            where: { ipHash: hashClientAddress(callerOf(address)) },
          }),
        ).toBe(ENQUIRY_ADDRESS_LIMIT);
      }
    });

    it(`counts every request to a form, honeypot hits and refused bodies too: the ${ENQUIRY_REQUEST_LIMIT + 1}st is 429`, async () => {
      const address = clientAddress();

      for (let index = 0; index < ENQUIRY_REQUEST_LIMIT; index++) {
        const response = await contact(
          index % 2 === 0
            ? contactBody({ company: 'bot' })
            : contactBody({ name: '' }),
          address,
        );

        expect([204, 400]).toContain(response.status);
      }

      const refused = await contact(contactBody(), address).expect(429);
      expect(sentence(refused)).toEqual([TOO_MANY_ATTEMPTS_MESSAGE]);
      // The throttler counts each route apart; the stored cap spans both.
      await group(groupBody(), address).expect(204);
      expect(
        await prisma.enquiry.count({
          where: { ipHash: hashClientAddress(callerOf(address)) },
        }),
      ).toBe(1);
    });
  });
});
