import {
  OnlineOrderMode,
  StaffRole,
  StockLocation,
} from '../../generated/cnc-client';
import {
  orderLink,
  RESERVATIONS_LINK,
} from '../customer-notifications/customer-notification-texts';
import { pagesFor } from '../shell/staff-pages';
import {
  BODY_MAX,
  CUSTOMER_PUSH_EVENTS,
  MAX_PUSH_TTL_S,
  PUSH_CATALOGUE,
  PUSH_INPUTS_HAVE_NO_FREE_TEXT,
  type PushEvent,
  type PushInputs,
  pushExpiresAt,
  renderPush,
  STAFF_PUSH_EVENTS,
  staffEntry,
  staffLink,
  type StaffPushEvent,
  staffPushEventsFor,
  TITLE_MAX,
  type WithoutFreeText,
} from './push-catalogue';
import {
  asDocketRef,
  asId,
  asOrderNumber,
  asPurchaseRef,
  asRoomName,
  asStockItemName,
  asTableName,
  watClockLabel,
  watDateLabel,
  watDay,
  watTimeLabel,
} from './push-input-types';

/**
 * C10, spec §1 and §1.4: every push's words fit, carry nothing private,
 * link where the in-app list and the bell do, and reach only the roles
 * that may act on them.
 */

const NOW = new Date('2026-10-30T18:00:00.000Z');
const START = new Date('2026-10-31T18:30:00.000Z');
const BOOKING = {
  reservationId: asId('clresv0000000000000000001'),
  version: 2,
  date: watDateLabel(new Date('2026-10-31T00:00:00.000Z')),
  time: watTimeLabel(19 * 60 + 30),
  startsAt: START,
};
const STAGE = {
  onlineOrderId: asId('clonline00000000000000001'),
  orderNumber: asOrderNumber('WEB-000124'),
  version: 3,
};
/** A name from a staff-managed list, as long as anyone would type. */
const LONG = 'Sofa setting by the window in the Lounge, upstairs, near the bar';

/** At least one input per event; the samples cover each branch. */
const SAMPLES: { [E in PushEvent]: PushInputs[E][] } = {
  'order.preparing': [STAGE],
  'order.on_the_way': [STAGE],
  'order.ready': [STAGE],
  'order.cancelled': [{ ...STAGE, orderNumber: asOrderNumber('CNCR-0001234') }],
  'order.refunded': [
    {
      onlineOrderId: STAGE.onlineOrderId,
      orderNumber: STAGE.orderNumber,
      paymentId: asId('clpay0000000000000000001'),
    },
  ],
  'reservation.booked_for_you': [BOOKING],
  'reservation.changed_by_staff': [BOOKING],
  'reservation.cancelled_by_staff': [BOOKING],
  'reservation.reminder': [BOOKING],
  'online_order.received': Object.values(OnlineOrderMode).map((mode) => ({
    onlineOrderId: STAGE.onlineOrderId,
    orderNumber: STAGE.orderNumber,
    mode,
  })),
  'docket.web': [1, 2].map((revision) => ({
    docketRef: asDocketRef('KOT-WEB-000124'),
    revision,
    orderNumber: STAGE.orderNumber,
    itemCount: 3,
  })),
  'checkout.needs_attention': [
    { checkoutId: asId('clcheckout000000000000001') },
  ],
  'purchase.awaiting_approval': [
    {
      purchaseId: asId('clpurchase000000000000001'),
      purchaseRef: asPurchaseRef('PR-000012'),
      version: 1,
    },
  ],
  'waste.awaiting_approval': [
    { wasteId: asId('clwaste000000000000000001'), version: 0 },
  ],
  'stock_request.new': [StockLocation.KITCHEN, StockLocation.BAR].map(
    (location) => ({
      requestId: asId('clrequest0000000000000001'),
      location,
      itemCount: 1,
    }),
  ),
  'stock.low': Object.values(StockLocation).map((location) => ({
    stockItemId: asId('clitem0000000000000000001'),
    item: asStockItemName(LONG),
    location,
    day: watDay(NOW),
  })),
  'task.assigned': [
    { taskId: asId('cltask0000000000000000001'), version: 0 },
    { taskId: asId('cltask0000000000000000002'), version: 4 },
  ],
  'reservation.today': [
    {
      reservationId: BOOKING.reservationId,
      version: 0,
      party: 4,
      time: BOOKING.time,
      room: asRoomName(LONG),
      startsAt: START,
    },
  ],
  'arrivals.digest': [
    { day: watDay(NOW), count: 7, firstTime: watClockLabel(START) },
  ],
  'table.still_occupied': [
    {
      tableId: asId('cltable000000000000000001'),
      table: asTableName(LONG),
      since: new Date('2026-10-30T14:00:00.000Z'),
      seatedMinutes: 245,
    },
  ],
  'orders.unsettled': [{ day: watDay(NOW), count: 2 }],
};

const EVENTS = Object.keys(PUSH_CATALOGUE) as PushEvent[];

/** Every rendered sample, with its event. */
const RENDERED = EVENTS.flatMap((event) =>
  (SAMPLES[event] as PushInputs[typeof event][]).map((input) => ({
    event,
    input,
    push: renderPush(event, input),
  })),
);

describe('the push catalogue (C10)', () => {
  it('has the spec’s nine customer and twelve staff events, and no PS4', () => {
    expect(CUSTOMER_PUSH_EVENTS.map((e) => PUSH_CATALOGUE[e].code)).toEqual([
      'PC1',
      'PC2',
      'PC3',
      'PC4',
      'PC5',
      'PC6',
      'PC7',
      'PC8',
      'PC9',
    ]);
    expect(STAFF_PUSH_EVENTS.map((e) => PUSH_CATALOGUE[e].code)).toEqual([
      'PS1',
      'PS2',
      'PS3',
      'PS5',
      'PS6',
      'PS7',
      'PS8',
      'PS9',
      'PS10',
      'PS11',
      'PS12',
      'PS13',
    ]);
  });

  it('keeps every title to 60 characters and every body to 160, clipping with an ellipsis', () => {
    for (const { push } of RENDERED) {
      expect(push.title.length).toBeLessThanOrEqual(TITLE_MAX);
      expect(push.body.length).toBeLessThanOrEqual(BODY_MAX);
    }

    const low = renderPush('stock.low', SAMPLES['stock.low'][0]);

    expect(low.title).toHaveLength(TITLE_MAX);
    expect(low.title.endsWith('…')).toBe(true);
  });

  it('never carries an email, a phone number or a money figure', () => {
    for (const { event, push } of RENDERED) {
      // The event leads the text, so a failure names it.
      expect(`${event}: ${push.title} ${push.body}`).not.toMatch(
        /@|\+234|\b0[789][01]\d{8}\b|₦|NGN|kobo/,
      );
    }
  });

  it('says the same thing for every task, whose titles are free text', () => {
    const [first, second] = SAMPLES['task.assigned'].map((input) =>
      renderPush('task.assigned', input),
    );

    expect([first.title, first.body]).toEqual([second.title, second.body]);
    expect(first).toMatchObject({
      title: 'New task assigned to you',
      body: 'Open Tasks to see it.',
    });
  });

  it('links a customer to the order tracker or the reservations list, as the in-app list does', () => {
    for (const { event, input, push } of RENDERED) {
      if (PUSH_CATALOGUE[event].realm !== 'CUSTOMER') continue;

      expect(push.link).toMatch(
        /^\/account(#(order\/[A-Z]+-\d{6,}|reservations|notifications|profile))?$/,
      );
      expect(push.link).toBe(
        event.startsWith('order.')
          ? orderLink((input as { orderNumber: string }).orderNumber)
          : RESERVATIONS_LINK,
      );
      expect(push.ref).toBeNull();
    }
  });

  it('links staff to the event’s own page', () => {
    for (const { event, push } of RENDERED) {
      if (PUSH_CATALOGUE[event].realm !== 'STAFF') continue;

      expect(push.link).toMatch(/^\/#[a-z]+$/);
      expect(push.link).toBe(
        staffLink(staffEntry(event as StaffPushEvent).page),
      );
    }
  });

  it('keys a stage change and a refund by their mail keys, and a booking by its versioned key', () => {
    expect(renderPush('order.ready', STAGE).about).toBe(
      `online:${STAGE.onlineOrderId}:status:3`,
    );
    expect(renderPush('reservation.changed_by_staff', BOOKING).about).toBe(
      `reservation:${BOOKING.reservationId}:changed:2`,
    );
    expect(renderPush('reservation.booked_for_you', BOOKING).about).toBe(
      `reservation:${BOOKING.reservationId}:confirmed`,
    );
  });

  it('marks only the paid web order, the web docket and the held payment urgent', () => {
    const urgent = STAFF_PUSH_EVENTS.filter((e) => PUSH_CATALOGUE[e].urgent);

    expect(urgent).toEqual([
      'online_order.received',
      'docket.web',
      'checkout.needs_attention',
    ]);
  });

  it('keeps every expiry between a minute and 28 days', () => {
    const past = { ...BOOKING, startsAt: new Date(NOW.getTime() - 1000) };

    expect(
      pushExpiresAt('reservation.reminder', past, NOW).getTime() -
        NOW.getTime(),
    ).toBe(60_000);
    expect(
      pushExpiresAt(
        'reservation.reminder',
        { ...BOOKING, startsAt: new Date('2027-06-01T00:00:00.000Z') },
        NOW,
      ).getTime() - NOW.getTime(),
    ).toBe(MAX_PUSH_TTL_S * 1000);
    expect(
      pushExpiresAt('reservation.booked_for_you', BOOKING, NOW).getTime(),
    ).toBe(NOW.getTime() + 24 * 60 * 60 * 1000);
  });
});

describe('who receives a staff push (D8)', () => {
  it('gives a role an event exactly when it is in the audience and opens the page', () => {
    for (const role of Object.values(StaffRole)) {
      for (const event of STAFF_PUSH_EVENTS) {
        const entry = staffEntry(event);

        expect({
          role,
          event,
          receives: staffPushEventsFor(role).includes(event),
        }).toEqual({
          role,
          event,
          receives:
            entry.audience.includes(role) &&
            pagesFor(role).includes(entry.page),
        });
      }
    }
  });

  it('gives each role the spec’s events', () => {
    const codes = (role: StaffRole) =>
      staffPushEventsFor(role).map((event) => PUSH_CATALOGUE[event].code);

    for (const role of [StaffRole.OWNER, StaffRole.MANAGER]) {
      expect(codes(role)).toEqual([
        'PS1',
        'PS2',
        'PS3',
        'PS5',
        'PS6',
        'PS7',
        'PS8',
        'PS9',
        'PS10',
        'PS11',
        'PS12',
        'PS13',
      ]);
    }
    expect(codes(StaffRole.CASHIER)).toEqual(['PS1', 'PS9', 'PS13']);
    expect(codes(StaffRole.KITCHEN)).toEqual(['PS2', 'PS9']);
    expect(codes(StaffRole.STOREKEEPER)).toEqual(['PS7', 'PS8', 'PS9']);
    expect(codes(StaffRole.RECEPTION)).toEqual(['PS9', 'PS10', 'PS11', 'PS12']);
    expect(codes(StaffRole.WAITER)).toEqual([]);
    expect(codes(StaffRole.BARTENDER)).toEqual([]);
  });
});

describe('the free-text rule (D2, §1.4)', () => {
  it('holds for the catalogue’s inputs', () => {
    expect(PUSH_INPUTS_HAVE_NO_FREE_TEXT).toBe(true);
  });

  it('refuses, at compile time, a plain string field or a field named like free text', () => {
    // Each line below would compile if the rule were missing. ts-jest only
    // transpiles (`isolatedModules`), so these are checked by CI's
    // "Type-check sources and specs" step (`tsc --noEmit`), which fails on
    // an unused expect-error directive.
    // @ts-expect-error a plain string `name`
    const name: WithoutFreeText<{ e: { name: string } }> = {
      e: { name: 'Ada' },
    };
    // @ts-expect-error a plain string `title`
    const title: WithoutFreeText<{ e: { title: string } }> = {
      e: { title: 'Fix the AC' },
    };
    // @ts-expect-error a plain string `phone`
    const phone: WithoutFreeText<{ e: { phone: string } }> = {
      e: { phone: '08012345678' },
    };
    // @ts-expect-error a plain string `email`
    const email: WithoutFreeText<{ e: { email: string } }> = {
      e: { email: 'a@b.c' },
    };
    // @ts-expect-error a plain string `address`
    const address: WithoutFreeText<{ e: { address: string } }> = {
      e: { address: '1 Rd' },
    };
    // @ts-expect-error any plain string, whatever its name
    const plain: WithoutFreeText<{ e: { table: string } }> = {
      e: { table: 'B1' },
    };
    // @ts-expect-error a field named `note`, even when branded
    const note: WithoutFreeText<{
      e: { note: ReturnType<typeof asTableName> };
    }> = { e: { note: asTableName('B1') } };

    const branded: WithoutFreeText<{
      e: { table: ReturnType<typeof asTableName>; count: number };
    }> = { e: { table: asTableName('B1'), count: 2 } };

    expect([name, title, phone, email, address, plain, note]).toHaveLength(7);
    expect(branded.e.count).toBe(2);
  });
});
