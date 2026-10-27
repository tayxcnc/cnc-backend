import {
  OnlineOrderMode,
  StaffRole,
  type StockLocation,
} from '../../generated/cnc-client';
import { MANAGER_ROLES } from '../auth/staff-roles';
import {
  orderLink,
  RESERVATIONS_LINK,
} from '../customer-notifications/customer-notification-texts';
import { pagesFor, type StaffPage } from '../shell/staff-pages';
import { STOCK_LOCATION_LABELS } from '../stock/stock-locations';
import type {
  DocketRef,
  Id,
  OrderNumber,
  PurchaseRef,
  RoomName,
  StockItemName,
  TableName,
  WatDateLabel,
  WatDay,
  WatTimeLabel,
} from './push-input-types';

/**
 * Every web push CNC sends (C10, spec §1): its words, who may receive it,
 * how urgent it is and how long it is worth delivering. The single place
 * that says so.
 *
 * ## Rules
 *
 * - **No free text, ever** (§1.4, D2). Push text is shown on a lock screen
 *   to whoever holds the device, so it never carries a phone, an email, a
 *   person's name, anything somebody typed, a payment reference, a money
 *   figure or an address. Every input field is a brand from
 *   `push-input-types.ts`, a count or an enum; a plain `string` field, or a
 *   field named like free text, fails `npm run build` (the assertion at the
 *   end of this file).
 * - **Rendered once, when queued**, and stored on the row: a retried or held
 *   push needs no event data. Title at most `TITLE_MAX`, body `BODY_MAX`,
 *   clipped with `…` by `renderPush`; the columns are those widths.
 * - **`about` is the topic**: the existing mail or list key where one
 *   exists, versioned so a legitimate repeat (a second staff change, a
 *   purchase back to pending) pushes again, while a retried command does
 *   not. `dedupeKey = <event>:<about>:<c|s>:<ownerId>`.
 * - **Customer links** are `orderLink` or `RESERVATIONS_LINK`, the in-app
 *   list's own, a site path without `/cnc`. **Staff links** are `/#<page>`,
 *   with the bell's `ref` beside it for the hand-off, never shown.
 * - **A staff event names its `audience`** (D8), and a role receives it only
 *   when it is in the audience **and** `pagesFor(role)` opens the page:
 *   page access alone would give Waiters the unsettled bills and the
 *   Kitchen low stock (`staffPushEventsFor`).
 */

/** The longest title a push carries: the column's width. */
export const TITLE_MAX = 60;

/** The longest body a push carries: the column's width. */
export const BODY_MAX = 160;

/** The longest tag, link and ref the columns hold. A longer one is a defect. */
export const TAG_MAX = 120;
export const LINK_MAX = 200;
export const REF_MAX = 64;

/** The longest a push service keeps a message: 28 days, in seconds. */
export const MAX_PUSH_TTL_S = 2_419_200;

/** The shortest TTL worth asking for, in seconds. */
export const MIN_PUSH_TTL_S = 60;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// ------------------------------------------------------------------ inputs

/** An online order's stage change (PC1 to PC4): the mail key's parts. */
export interface OrderStageInput {
  onlineOrderId: Id;
  orderNumber: OrderNumber;
  /** `OnlineOrder.version` after the change, as the mail key carries it. */
  version: number;
}

/** A booking, as a customer's push names it. */
export interface BookingInput {
  reservationId: Id;
  /** `Reservation.version` after the write, for the versioned keys. */
  version: number;
  date: WatDateLabel;
  time: WatTimeLabel;
  /** When the booking starts: how long a push about it is worth sending. */
  startsAt: Date;
}

/** The customer's events, by key. */
export interface CustomerPushInputs {
  'order.preparing': OrderStageInput;
  'order.on_the_way': OrderStageInput;
  'order.ready': OrderStageInput;
  'order.cancelled': OrderStageInput;
  'order.refunded': {
    onlineOrderId: Id;
    orderNumber: OrderNumber;
    paymentId: Id;
  };
  'reservation.booked_for_you': BookingInput;
  'reservation.changed_by_staff': BookingInput;
  'reservation.cancelled_by_staff': BookingInput;
  'reservation.reminder': BookingInput;
}

/** The staff events, by key. */
export interface StaffPushInputs {
  'online_order.received': {
    onlineOrderId: Id;
    orderNumber: OrderNumber;
    mode: OnlineOrderMode;
  };
  'docket.web': {
    docketRef: DocketRef;
    revision: number;
    orderNumber: OrderNumber;
    itemCount: number;
  };
  'checkout.needs_attention': { checkoutId: Id };
  'purchase.awaiting_approval': {
    purchaseId: Id;
    purchaseRef: PurchaseRef;
    version: number;
  };
  'waste.awaiting_approval': { wasteId: Id; version: number };
  'stock_request.new': {
    requestId: Id;
    location: StockLocation;
    itemCount: number;
  };
  'stock.low': {
    stockItemId: Id;
    item: StockItemName;
    location: StockLocation;
    day: WatDay;
  };
  'task.assigned': { taskId: Id; version: number };
  'reservation.today': {
    reservationId: Id;
    version: number;
    party: number;
    time: WatTimeLabel;
    room: RoomName;
    startsAt: Date;
  };
  'arrivals.digest': { day: WatDay; count: number; firstTime: WatTimeLabel };
  'table.still_occupied': {
    tableId: Id;
    table: TableName;
    since: Date;
    seatedMinutes: number;
  };
  'orders.unsettled': { day: WatDay; count: number };
}

/** Every event's input, by key. */
export type PushInputs = CustomerPushInputs & StaffPushInputs;

export type CustomerPushEvent = keyof CustomerPushInputs;
export type StaffPushEvent = keyof StaffPushInputs;
export type PushEvent = keyof PushInputs;

// ----------------------------------------------------------------- entries

/** What `build` writes. `ref` is the staff app's hand-off, never shown. */
export interface PushText {
  title: string;
  body: string;
  link: string;
  ref?: string;
}

interface EntryBase<I> {
  /** The spec's number, for reading the two side by side. */
  code: string;
  /** Sent with high urgency, and never held off-hours (D6). */
  urgent: boolean;
  /** Alert again when it replaces a shown push with the same tag. */
  renotify: boolean;
  /** When it stops being worth delivering, from `now` (clamped). */
  ttl: (input: I, now: Date) => Date;
  /** The topic and the dedupe key's middle (see the file note). */
  about: (input: I) => string;
  /** The device's grouping: a later push with the tag replaces the earlier. */
  tag: (input: I) => string;
  build: (input: I) => PushText;
}

/** A customer's push (realm CUSTOMER). */
export interface CustomerPushEntry<I> extends EntryBase<I> {
  realm: 'CUSTOMER';
  /** The customer's switch that silences it, as it silences the email. */
  gate?: 'prefOrderUpdates' | 'prefBookingReminders';
}

/** A staff push (realm STAFF). */
export interface StaffPushEntry<I> extends EntryBase<I> {
  realm: 'STAFF';
  /** The page it opens, which every recipient's role must open. */
  page: StaffPage;
  /** The roles that may receive it (D8). */
  audience: readonly StaffRole[];
  /** The bell's alert switch that silences it, read when it is queued. */
  alert?:
    'alertApprovals' | 'alertLowStock' | 'alertUnsettled' | 'alertArrivals';
}

type Catalogue = {
  readonly [E in CustomerPushEvent]: CustomerPushEntry<CustomerPushInputs[E]>;
} & {
  readonly [E in StaffPushEvent]: StaffPushEntry<StaffPushInputs[E]>;
};

/** `now` plus `ms`. */
const after =
  (ms: number) =>
  (_input: unknown, now: Date): Date =>
    new Date(now.getTime() + ms);

/** Until a booking starts, but never past 24 hours from now. */
const untilStartWithin24h = (input: { startsAt: Date }, now: Date): Date =>
  new Date(Math.min(input.startsAt.getTime(), now.getTime() + 24 * HOUR_MS));

/** A staff page as the staff app's link: `/#kitchen`. */
export const staffLink = (page: StaffPage): string => `/#${page}`;

/** How a web order reaches its customer, as staff say it. */
const MODE_LABELS: Readonly<Record<OnlineOrderMode, string>> = {
  [OnlineOrderMode.PICKUP]: 'Pickup',
  [OnlineOrderMode.WITHIN_JOS]: 'Delivery within Jos',
  [OnlineOrderMode.OUTSIDE_JOS]: 'Delivery outside Jos',
};

/** The mail key a stage change carries (`OnlineOrderMail.statusChanged`). */
const stageKey = (input: OrderStageInput): string =>
  `online:${input.onlineOrderId}:status:${input.version}`;

const orderStage = (
  code: string,
  urgent: boolean,
  hours: number,
  gate: CustomerPushEntry<OrderStageInput>['gate'],
  words: (input: OrderStageInput) => { title: string; body: string },
): CustomerPushEntry<OrderStageInput> => ({
  code,
  realm: 'CUSTOMER',
  gate,
  urgent,
  renotify: true,
  ttl: after(hours * HOUR_MS),
  about: stageKey,
  tag: (input) => `order:${input.onlineOrderId}`,
  build: (input) => ({ ...words(input), link: orderLink(input.orderNumber) }),
});

export const PUSH_CATALOGUE: Catalogue = {
  // -------------------------------------------------------------- customer
  'order.preparing': orderStage(
    'PC1',
    false,
    2,
    'prefOrderUpdates',
    (input) => ({
      title: `Order ${input.orderNumber} is being prepared`,
      body: 'The kitchen has started on your order.',
    }),
  ),
  'order.on_the_way': orderStage(
    'PC2',
    true,
    2,
    'prefOrderUpdates',
    (input) => ({
      title: `Order ${input.orderNumber} is on its way`,
      body: 'Your order has left CNC.',
    }),
  ),
  'order.ready': orderStage('PC3', true, 4, 'prefOrderUpdates', (input) => ({
    title: `Order ${input.orderNumber} is ready for pickup`,
    body: 'Come to the counter to collect it.',
  })),
  // Always, like its email: a cancellation is news the customer must have.
  'order.cancelled': orderStage('PC4', false, 24, undefined, (input) => ({
    title: `Order ${input.orderNumber} was cancelled`,
    body: 'Open your account for the details and any refund.',
  })),
  'order.refunded': {
    code: 'PC5',
    realm: 'CUSTOMER',
    urgent: false,
    renotify: false,
    ttl: after(72 * HOUR_MS),
    about: (input) => `online:${input.onlineOrderId}:refund:${input.paymentId}`,
    tag: (input) => `refund:${input.paymentId}`,
    // No amount and no method: a money figure never reaches a lock screen.
    build: (input) => ({
      title: `Refund for order ${input.orderNumber}`,
      body: 'A refund has been issued. Open your account for the details.',
      link: orderLink(input.orderNumber),
    }),
  },
  'reservation.booked_for_you': {
    code: 'PC6',
    realm: 'CUSTOMER',
    urgent: false,
    renotify: false,
    ttl: untilStartWithin24h,
    about: (input) => `reservation:${input.reservationId}:confirmed`,
    tag: (input) => `reservation:${input.reservationId}`,
    build: (input) => ({
      title: 'Table reserved',
      body: `Your table at CNC is booked for ${input.date} at ${input.time}.`,
      link: RESERVATIONS_LINK,
    }),
  },
  'reservation.changed_by_staff': {
    code: 'PC7',
    realm: 'CUSTOMER',
    urgent: false,
    renotify: false,
    ttl: untilStartWithin24h,
    about: (input) =>
      `reservation:${input.reservationId}:changed:${input.version}`,
    tag: (input) => `reservation:${input.reservationId}`,
    build: (input) => ({
      title: 'Reservation changed',
      body: `Your table is now booked for ${input.date} at ${input.time}.`,
      link: RESERVATIONS_LINK,
    }),
  },
  'reservation.cancelled_by_staff': {
    code: 'PC8',
    realm: 'CUSTOMER',
    urgent: false,
    renotify: false,
    ttl: after(24 * HOUR_MS),
    about: (input) => `reservation:${input.reservationId}:cancelled`,
    tag: (input) => `reservation:${input.reservationId}`,
    build: (input) => ({
      title: 'Reservation cancelled',
      body:
        `Your booking for ${input.date} at ${input.time} was cancelled. ` +
        'Open your account for details.',
      link: RESERVATIONS_LINK,
    }),
  },
  'reservation.reminder': {
    code: 'PC9',
    realm: 'CUSTOMER',
    gate: 'prefBookingReminders',
    urgent: false,
    renotify: false,
    ttl: (input) => input.startsAt,
    about: (input) =>
      `reservation:${input.reservationId}:reminder:${input.version}`,
    tag: (input) => `reservation:${input.reservationId}`,
    build: (input) => ({
      title: 'See you soon',
      body: `Your table at CNC is booked for ${input.date} at ${input.time}.`,
      link: RESERVATIONS_LINK,
    }),
  },

  // ----------------------------------------------------------------- staff
  'online_order.received': {
    code: 'PS1',
    realm: 'STAFF',
    page: 'online',
    audience: [StaffRole.CASHIER, ...MANAGER_ROLES],
    urgent: true,
    renotify: false,
    ttl: after(30 * MINUTE_MS),
    about: (input) => `online:${input.onlineOrderId}:placed`,
    tag: (input) => `online:${input.onlineOrderId}`,
    build: (input) => ({
      title: `New web order ${input.orderNumber}`,
      body: `${MODE_LABELS[input.mode]}, paid online. Open Online Orders.`,
      link: staffLink('online'),
      // No `ref`: Online Orders reads a held checkout's id as its hand-off
      // (PS3), so an order id here would open the wrong dialog.
    }),
  },
  'docket.web': {
    code: 'PS2',
    realm: 'STAFF',
    page: 'kitchen',
    audience: [StaffRole.KITCHEN, ...MANAGER_ROLES],
    urgent: true,
    renotify: true,
    ttl: after(30 * MINUTE_MS),
    about: (input) => `docket:${input.docketRef}:${input.revision}`,
    tag: (input) => `docket:${input.docketRef}`,
    build: (input) =>
      input.revision <= 1
        ? {
            title: `New web docket ${input.docketRef}`,
            body:
              `${input.itemCount} ${input.itemCount === 1 ? 'item' : 'items'} ` +
              `for order ${input.orderNumber}. Open Kitchen.`,
            link: staffLink('kitchen'),
            ref: input.docketRef,
          }
        : {
            title: `Web docket changed: ${input.docketRef}`,
            body: `Order ${input.orderNumber} was edited. Open Kitchen.`,
            link: staffLink('kitchen'),
            ref: input.docketRef,
          },
  },
  'checkout.needs_attention': {
    code: 'PS3',
    realm: 'STAFF',
    page: 'online',
    audience: MANAGER_ROLES,
    urgent: true,
    renotify: false,
    ttl: after(24 * HOUR_MS),
    about: (input) => `attention:${input.checkoutId}`,
    tag: (input) => `attention:${input.checkoutId}`,
    build: (input) => ({
      title: 'A web payment needs attention',
      body: 'A checkout was held. Open Online Orders to resolve it.',
      link: staffLink('online'),
      ref: input.checkoutId,
    }),
  },
  'purchase.awaiting_approval': {
    code: 'PS5',
    realm: 'STAFF',
    page: 'purchasing',
    audience: MANAGER_ROLES,
    alert: 'alertApprovals',
    urgent: false,
    renotify: false,
    ttl: after(72 * HOUR_MS),
    about: (input) => `purchase:${input.purchaseId}:${input.version}`,
    tag: (input) => `purchase:${input.purchaseId}`,
    build: (input) => ({
      title: 'Purchase awaiting approval',
      body: `${input.purchaseRef} needs your approval. Open Purchasing.`,
      link: staffLink('purchasing'),
    }),
  },
  'waste.awaiting_approval': {
    code: 'PS6',
    realm: 'STAFF',
    page: 'waste',
    audience: MANAGER_ROLES,
    alert: 'alertApprovals',
    urgent: false,
    renotify: false,
    ttl: after(72 * HOUR_MS),
    about: (input) => `waste:${input.wasteId}:${input.version}`,
    tag: (input) => `waste:${input.wasteId}`,
    build: () => ({
      title: 'Waste awaiting approval',
      body: 'A waste entry needs your approval. Open Waste.',
      link: staffLink('waste'),
    }),
  },
  'stock_request.new': {
    code: 'PS7',
    realm: 'STAFF',
    page: 'inventory',
    audience: [StaffRole.STOREKEEPER, ...MANAGER_ROLES],
    urgent: false,
    renotify: false,
    ttl: after(8 * HOUR_MS),
    about: (input) => `request:${input.requestId}`,
    tag: (input) => `request:${input.requestId}`,
    build: (input) => ({
      title: 'New stock request',
      body:
        `${STOCK_LOCATION_LABELS[input.location]} asked for ` +
        `${input.itemCount} ${input.itemCount === 1 ? 'item' : 'items'}. ` +
        'Open Inventory.',
      link: staffLink('inventory'),
    }),
  },
  'stock.low': {
    code: 'PS8',
    realm: 'STAFF',
    page: 'inventory',
    audience: [StaffRole.STOREKEEPER, ...MANAGER_ROLES],
    alert: 'alertLowStock',
    urgent: false,
    renotify: false,
    ttl: after(12 * HOUR_MS),
    about: (input) => `low:${input.stockItemId}:${input.location}:${input.day}`,
    tag: (input) => `low:${input.stockItemId}:${input.location}`,
    build: (input) => ({
      title: `Low stock: ${input.item}`,
      body: `${STOCK_LOCATION_LABELS[input.location]} is below its minimum.`,
      link: staffLink('inventory'),
    }),
  },
  'task.assigned': {
    code: 'PS9',
    realm: 'STAFF',
    page: 'tasks',
    audience: [
      ...MANAGER_ROLES,
      StaffRole.RECEPTION,
      StaffRole.CASHIER,
      StaffRole.KITCHEN,
      StaffRole.STOREKEEPER,
    ],
    urgent: false,
    renotify: false,
    ttl: after(72 * HOUR_MS),
    about: (input) => `task:${input.taskId}:${input.version}`,
    tag: (input) => `task:${input.taskId}`,
    // Constant: a task's title is free text and names vendors and assets.
    build: () => ({
      title: 'New task assigned to you',
      body: 'Open Tasks to see it.',
      link: staffLink('tasks'),
    }),
  },
  'reservation.today': {
    code: 'PS10',
    realm: 'STAFF',
    page: 'reception',
    audience: [StaffRole.RECEPTION, ...MANAGER_ROLES],
    alert: 'alertArrivals',
    urgent: false,
    renotify: false,
    ttl: (input) => input.startsAt,
    about: (input) => `arrival:${input.reservationId}:${input.version}`,
    tag: (input) => `arrival:${input.reservationId}`,
    // No guest name: the room, the time and the party size are enough.
    build: (input) => ({
      title: 'New booking for today',
      body:
        `${input.party} ${input.party === 1 ? 'guest' : 'guests'} at ` +
        `${input.time}, ${input.room}. Open Reception.`,
      link: staffLink('reception'),
    }),
  },
  'arrivals.digest': {
    code: 'PS11',
    realm: 'STAFF',
    page: 'reception',
    audience: [StaffRole.RECEPTION, ...MANAGER_ROLES],
    alert: 'alertArrivals',
    urgent: false,
    renotify: false,
    ttl: after(12 * HOUR_MS),
    about: (input) => `arrivals:${input.day}`,
    tag: (input) => `arrivals:${input.day}`,
    build: (input) => ({
      title: `${input.count} ${input.count === 1 ? 'booking' : 'bookings'} today`,
      body: `The first is at ${input.firstTime}. Open Reception.`,
      link: staffLink('reception'),
    }),
  },
  'table.still_occupied': {
    code: 'PS12',
    realm: 'STAFF',
    page: 'reception',
    audience: [StaffRole.RECEPTION, ...MANAGER_ROLES],
    urgent: false,
    renotify: false,
    ttl: after(HOUR_MS),
    about: (input) => `free:${input.tableId}:${input.since.toISOString()}`,
    tag: (input) => `free:${input.tableId}`,
    build: (input) => ({
      title: `Table ${input.table} still occupied`,
      body:
        `Seated for ${Math.floor(input.seatedMinutes / 60)} h ` +
        `${input.seatedMinutes % 60} min. Free it if the guests have left.`,
      link: staffLink('reception'),
    }),
  },
  'orders.unsettled': {
    code: 'PS13',
    realm: 'STAFF',
    page: 'pos',
    audience: [StaffRole.CASHIER, ...MANAGER_ROLES],
    alert: 'alertUnsettled',
    urgent: false,
    renotify: false,
    ttl: after(12 * HOUR_MS),
    about: (input) => `unsettled:${input.day}`,
    tag: (input) => `unsettled:${input.day}`,
    build: (input) => ({
      title:
        `${input.count} ${input.count === 1 ? 'bill' : 'bills'} left open ` +
        'from a previous day',
      body: 'Settle or cancel them in POS.',
      link: staffLink('pos'),
    }),
  },
};

// ----------------------------------------------------------------- helpers

/** Every customer event's key, in catalogue order. */
export const CUSTOMER_PUSH_EVENTS = (
  Object.keys(PUSH_CATALOGUE) as PushEvent[]
).filter(
  (event): event is CustomerPushEvent =>
    PUSH_CATALOGUE[event].realm === 'CUSTOMER',
);

/** Every staff event's key, in catalogue order. */
export const STAFF_PUSH_EVENTS = (
  Object.keys(PUSH_CATALOGUE) as PushEvent[]
).filter(
  (event): event is StaffPushEvent => PUSH_CATALOGUE[event].realm === 'STAFF',
);

/** A staff event's entry, typed as the audience reader needs it. */
export function staffEntry(event: StaffPushEvent): StaffPushEntry<unknown> {
  return PUSH_CATALOGUE[event];
}

/**
 * Whether a role may receive a staff event: in its audience, and able to
 * open its page. The queue asks this when it writes a row and again when
 * it sends one (D11).
 */
export function roleReceives(event: StaffPushEvent, role: StaffRole): boolean {
  const entry = staffEntry(event);

  return entry.audience.includes(role) && pagesFor(role).includes(entry.page);
}

/**
 * The staff events a role can receive (D8), for the staff app's control:
 * a role with none (Waiter, Bartender) is told so rather than offered a
 * switch that would never ring.
 */
export function staffPushEventsFor(role: StaffRole): StaffPushEvent[] {
  return STAFF_PUSH_EVENTS.filter((event) => roleReceives(event, role));
}

/** Whether a stored event key is one this catalogue knows. */
export function isPushEvent(event: string): event is PushEvent {
  return Object.hasOwn(PUSH_CATALOGUE, event);
}

/** `text` cut to `max` characters, ending `…` when it was cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A push as the queue stores it. */
export interface RenderedPush {
  title: string;
  body: string;
  link: string;
  ref: string | null;
  tag: string;
  about: string;
  urgent: boolean;
  renotify: boolean;
}

/**
 * An event's push, rendered and clipped to the columns. Throws when a link,
 * tag or ref is longer than its column: that is a defect in an entry, never
 * something to cut, and the queue's pure step turns it into no push.
 */
export function renderPush<E extends PushEvent>(
  event: E,
  input: PushInputs[E],
): RenderedPush {
  const entry = PUSH_CATALOGUE[event] as EntryBase<PushInputs[E]>;
  const text = entry.build(input);
  const tag = entry.tag(input);
  const ref = text.ref ?? null;

  if (
    text.link.length > LINK_MAX ||
    tag.length > TAG_MAX ||
    (ref !== null && ref.length > REF_MAX)
  ) {
    throw new Error(`Push ${event} has a link, tag or ref over its column.`);
  }

  return {
    title: clip(text.title, TITLE_MAX),
    body: clip(text.body, BODY_MAX),
    link: text.link,
    ref,
    tag,
    about: entry.about(input),
    urgent: entry.urgent,
    renotify: entry.renotify,
  };
}

/**
 * When an event's push stops being worth delivering, measured from `from`
 * (the moment it is written, or the end of its off-hours hold), clamped to
 * what a push service accepts: at least a minute, at most 28 days.
 */
export function pushExpiresAt<E extends PushEvent>(
  event: E,
  input: PushInputs[E],
  from: Date,
): Date {
  const entry = PUSH_CATALOGUE[event] as EntryBase<PushInputs[E]>;
  const wanted = entry.ttl(input, from).getTime() - from.getTime();
  const clamped = Math.min(
    Math.max(wanted, MIN_PUSH_TTL_S * 1000),
    MAX_PUSH_TTL_S * 1000,
  );

  return new Date(from.getTime() + clamped);
}

// ------------------------------------------------------ the free-text rule

/** Field names that mean free text, whatever their type. */
type FreeTextName =
  'name' | 'title' | 'phone' | 'email' | 'address' | 'note' | 'reference';

/** The fields of one input that are plain text or named like it. */
type FreeTextFields<T> = {
  [F in keyof T]-?: string extends T[F]
    ? F
    : F extends FreeTextName
      ? F
      : never;
}[keyof T];

/** Every event's free-text fields; `never` when there are none. */
export type FreeTextIn<T> = {
  [K in keyof T]: FreeTextFields<T[K]>;
}[keyof T];

/**
 * `T` itself when no input of it has a plain `string` field or a field named
 * like free text, otherwise `never`, so assigning anything to it fails to
 * compile. The spec proves the rule with `@ts-expect-error`.
 */
export type WithoutFreeText<T> = [FreeTextIn<T>] extends [never] ? T : never;

/**
 * The rule, at compile time: `npm run build` fails here the moment any
 * catalogue input gains a plain `string` field, or a field named like free
 * text. Nothing reads the value.
 */
export const PUSH_INPUTS_HAVE_NO_FREE_TEXT: [FreeTextIn<PushInputs>] extends [
  never,
]
  ? true
  : never = true;
