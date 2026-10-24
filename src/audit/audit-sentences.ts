import { $Enums } from '../../generated/cnc-client';
import { formatKoboShort } from '../common/money';
import { formatWatShortStamp } from '../common/wat-format';

/**
 * Plain names for audit actions, the module each belongs to, and plain
 * sentences for what a change did: the staff app's `lib/audit.ts`
 * (`auditModule`, `actionLabel`, `describeChange`) on the server (A13).
 *
 * The API returns these sentences and **never** the raw `before` and
 * `after` (D47): staff read what changed, not data. The demo's
 * developer-only raw view (`?dev=1`) is not ported.
 *
 * Ported with the server's field names in mind. The demo's state used bare
 * names (`price`, `vat`); the schema spells money `*Kobo` and rates `*Bps`
 * (A5), so those suffixes decide how a value is shown and are dropped from
 * the label. Everything else is the demo's rule.
 */

/** The module each command family belongs to (the demo's `MODULES`). */
const MODULES: Readonly<Record<string, string>> = {
  order: 'Point of Sale',
  cash: 'Point of Sale',
  table: 'Reception',
  reservation: 'Reception',
  kitchen: 'Kitchen',
  mapping: 'Kitchen',
  online: 'Online Orders',
  request: 'Stock & Requests',
  stock: 'Stock & Requests',
  stockitem: 'Stock & Requests',
  purchase: 'Purchasing',
  waste: 'Waste',
  asset: 'Assets & Maintenance',
  maintenance: 'Assets & Maintenance',
  vendor: 'Vendors',
  staff: 'Staff & Access',
  attendance: 'Attendance',
  menu: 'Menu & Prices',
  settings: 'Settings',
  task: 'Tasks',
};

/**
 * Every module name a row can carry: the values of {@link MODULES}, plus
 * `Other` (an unknown family) and `System` (an action with no dot). The
 * demo's `Demo Clock` is gone with `clock.tick` (A11).
 */
export const AUDIT_MODULES: readonly string[] = [
  ...new Set([...Object.values(MODULES), 'Other', 'System']),
];

/**
 * Display labels for the commands (the demo's `LABELS`), plus the commands
 * the server adds, which the demo did not have: the two password commands
 * (C3-3), the staff ID reissue, the menu photo and the opening hours (C3-6,
 * C3-7). `stock.issue` is the demo's own command, which its labels missed;
 * "Stock Sent" follows its movement label "Sent to Kitchen" (C4-2).
 * `reservation.change` is Reception's "Change booking", new with C4-7
 * (plan §16), labelled as its cancel sibling is. `online.paid` is a web
 * order written by its confirmed payment (C7-3), labelled with the demo's
 * own reason for its seeded web orders, "Paid online". `online.refund` is
 * what Paystack answered to a card refund `online.balance` recorded
 * (C7-4, Q26): sent, refused or unconfirmed. `online.resolveRefund` is a
 * manager's record of what Paystack's dashboard shows for an unconfirmed
 * one, and `online.resolveCheckout` a manager closing a checkout held for
 * attention (C7 review).
 */
const LABELS: Readonly<Record<string, string>> = {
  'order.create': 'Order Opened',
  'order.details': 'Order Details Changed',
  'order.quantity': 'Item Quantity Changed',
  'order.discount': 'Discount Applied',
  'order.confirm': 'Order Sent',
  'order.payment': 'Payment Received',
  'order.settle': 'Order Settled',
  'order.cancel': 'Order Cancelled',
  'order.reopen': 'Order Reopened',
  'order.reverse': 'Settlement Reversed',
  'cash.count': 'Cash Counted',
  'table.allocate': 'Guests Seated',
  'table.release': 'Position Released',
  'reservation.create': 'Reservation Made',
  'reservation.cancel': 'Reservation Cancelled',
  'reservation.checkin': 'Guest Checked In',
  'reservation.noshow': 'Marked No Show',
  'reservation.change': 'Reservation Changed',
  'kitchen.save': 'Kitchen Record Saved',
  'kitchen.close': 'Kitchen Record Closed',
  'mapping.save': 'Portion Map Saved',
  'online.paid': 'Paid Online',
  'online.status': 'Status Changed',
  'online.correctStatus': 'Status Corrected',
  'online.edit': 'Order Edited',
  'online.cancel': 'Order Cancelled',
  'online.zone': 'Delivery Zone Changed',
  'online.balance': 'Balance Recorded',
  'online.refund': 'Card Refund',
  'online.resolveRefund': 'Card Refund Resolved',
  'online.resolveCheckout': 'Held Payment Resolved',
  'request.create': 'Stock Requested',
  'request.issue': 'Stock Issued',
  'request.reject': 'Request Declined',
  'stock.adjust': 'Balance Corrected',
  'stock.count': 'Stock Counted',
  'stock.issue': 'Stock Sent',
  'stockitem.create': 'Stock Item Added',
  'stockitem.save': 'Stock Item Changed',
  'purchase.create': 'Purchase Raised',
  'purchase.edit': 'Purchase Edited',
  'purchase.approve': 'Purchase Approved',
  'purchase.reject': 'Purchase Rejected',
  'purchase.status': 'Purchase Status Changed',
  'purchase.receive': 'Goods Received',
  'purchase.archive': 'Purchase Archived',
  'waste.create': 'Waste Logged',
  'waste.edit': 'Waste Edited',
  'waste.approve': 'Waste Approved',
  'waste.reject': 'Waste Rejected',
  'waste.status': 'Waste Status Changed',
  'asset.save': 'Asset Saved',
  'maintenance.save': 'Repair Record Saved',
  'vendor.save': 'Vendor Saved',
  'staff.save': 'Staff Record Saved',
  'staff.photo': 'Photo Changed',
  'staff.changePassword': 'Password Changed',
  'staff.resetPassword': 'Password Reset',
  'staff.regenerateQr': 'Staff ID Reissued',
  'attendance.scan': 'Attendance Scanned',
  'attendance.correct': 'Attendance Corrected',
  'menu.save': 'Menu Item Saved',
  'menu.photo': 'Photo Changed',
  'settings.save': 'Settings Saved',
  'settings.openingHours': 'Opening Hours Saved',
  'task.save': 'Task Saved',
};

/** The demo's `auditModule`: the module an action is filed under. */
export function auditModule(action: string): string {
  if (!action.includes('.')) return 'System';

  return MODULES[action.split('.')[0]] ?? 'Other';
}

/**
 * The demo's `actionLabel`: the label, or an action with no dot as it
 * stands, or the last part of the name in words (`order.partPay` →
 * `Part Pay`).
 */
export function actionLabel(action: string): string {
  const known = LABELS[action];
  if (known !== undefined) return known;
  if (!action.includes('.')) return action;

  return words(action.split('.').pop() ?? action);
}

/** `partPay` → `Part Pay`. */
function words(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (first) => first.toUpperCase());
}

/**
 * Fields never described: identities, bookkeeping, credentials, and the
 * nested lists that get a sentence of their own. The demo's list, plus the
 * server's own (`updatedAt`, `version`, `singleton`, the credential
 * columns). A credential should never reach an audit row at all
 * (`AuditService` refuses one); this keeps one that slipped through out of
 * every sentence. `sessionId` is the seating a `table.release` row ended
 * (C8 review), kept for the audit read's join, not for staff to read.
 */
const HIDE =
  /^(id|history|at|createdAt|updatedAt|version|sessionVersion|sessionId|singleton|qrToken|passwordHash|tokenHash|codeHash|photo|hasPhoto|confirmed|revision|vat|lines|items|seq)$/;

/** Money is every `*Kobo` field (A5). */
const MONEY = /Kobo$/;

/** Rates are every `*Bps` field: 750 is 7.5%. */
const RATE = /Bps$/;

/** A business date's key: `businessDate`, `joinedOn`. */
const BUSINESS_DATE = /(Date|On)$/;

/** Labels the word rule would get wrong. */
const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  vatBps: 'VAT',
  serviceBps: 'Service Charge',
};

/**
 * The demo's `label`: a field name in words, without the suffixes that only
 * say how the value is stored (`staffCategoryId` → `Staff Category`,
 * `priceKobo` → `Price`).
 */
function label(key: string): string {
  return (
    LABEL_OVERRIDES[key] ?? words(key.replace(/(Id|Kobo|Bps)$/, '').trim())
  );
}

/**
 * Enum values as staff read them. Values that title-case badly are listed;
 * every other enum value becomes its words (`IN_PROGRESS` → `In Progress`).
 */
const ENUM_LABELS: Readonly<Record<string, string>> = {
  MM80: '80mm',
  MM58: '58mm',
  A4: 'A4',
};

/**
 * Every value of every schema enum, read from the generated client, so a
 * stored `MANAGER` reads `Manager` while a note that happens to be in
 * capitals is left alone.
 */
const ENUM_VALUES: ReadonlySet<string> = new Set(
  // `$Enums`, not `Prisma.dmmf.datamodel.enums`, which Prisma 7 leaves empty.
  Object.values($Enums).flatMap((values: Record<string, string>) =>
    Object.values(values),
  ),
);

function enumLabel(value: string): string {
  return (
    ENUM_LABELS[value] ??
    value
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;
const UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?Z$/;

/** The demo's `show`: one value as a sentence shows it. */
function show(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'blank';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';

  if (typeof value === 'number') {
    if (MONEY.test(key) && Number.isInteger(value)) {
      return formatKoboShort(value);
    }

    if (RATE.test(key)) {
      return `${(value / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;
    }

    return value.toLocaleString('en-GB');
  }

  if (Array.isArray(value)) {
    return `${value.length}${value.length === 1 ? ' entry' : ' entries'}`;
  }

  // Anything else that is not text (only an object, from JSON) is 'updated'.
  if (typeof value !== 'string') return 'updated';

  const text = value;

  // A `@db.Date` serialised into JSON arrives as UTC midnight; it names a
  // day, not an instant, and would otherwise print as 01:00 in Jos.
  const businessDate = BUSINESS_DATE.test(key) && UTC_MIDNIGHT.exec(text);
  if (businessDate) return businessDate[1];

  if (ISO_INSTANT.test(text)) {
    const instant = new Date(text);
    if (!Number.isNaN(instant.getTime())) return formatWatShortStamp(instant);
  }

  if (ENUM_VALUES.has(text)) return enumLabel(text);

  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The fields of a row that name or reach a guest: the booking's and the web
 * order's name, phone, email, notes and address, a bill's guest and a
 * transfer's sender (card C8-5). Their values are withheld from the
 * sentences of a row about a record whose customer deleted their account
 * (Q36): the audit log is append-only and keeps what it recorded (A13), so
 * the read is the only place the person can be taken out of it.
 */
export const CONTACT_FIELDS =
  /^(name|phone|email|note|guestNote|guest|notes|sender|contactName|contactPhone|contactEmail|addressText|addressStreet|addressArea|addressTown|addressLandmark)$/;

/** The sentence a withheld field gets, in place of its value. New (C8-5). */
export function withheldSentence(key: string, changed: boolean): string {
  return changed
    ? `${label(key)} changed, not shown: the customer deleted their account.`
    : `${label(key)} not shown: the customer deleted their account.`;
}

/**
 * The demo's `describeChange`: plain sentences for what a change did, so
 * staff never read raw data.
 *
 * - Two non-objects: "Set to …", "Removed.", "Changed from … to …", or the
 *   two "no details" sentences.
 * - A record created (no `before` object): "<Field>: <value>." per field.
 * - A record changed: "<Field> changed from <old> to <new>." per field that
 *   differs, hidden fields skipped.
 * - A changed `items` or `lines` list gets one sentence with its count.
 * - Nothing visible: "Saved with no visible change." or "Record created."
 *
 * The fields are taken in the stored object's key order. `before` and
 * `after` are `jsonb`, which keeps keys shortest first rather than in the
 * order the command wrote them, so the sentences come out in that order.
 *
 * `withholdContacts` (C8-5): the row is about a deleted customer's record,
 * so each {@link CONTACT_FIELDS} field that would be described gets
 * {@link withheldSentence} instead of its values.
 */
export function describeChange(
  before: unknown,
  after: unknown,
  options: { withholdContacts?: boolean } = {},
): string[] {
  if (!isObject(before) && !isObject(after)) {
    if (before == null && after == null) {
      return ['No further details were recorded for this change.'];
    }
    if (before === after) return ['Saved with no visible change.'];
    if (before == null) return [`Set to ${show('', after)}.`];
    if (after == null) return ['Removed.'];

    return [`Changed from ${show('', before)} to ${show('', after)}.`];
  }

  const b = isObject(before) ? before : {};
  const a = isObject(after) ? after : {};
  const out: string[] = [];

  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (HIDE.test(key)) continue;

    const x = b[key];
    const y = a[key];

    if (JSON.stringify(x) === JSON.stringify(y)) continue;

    if (options.withholdContacts === true && CONTACT_FIELDS.test(key)) {
      out.push(withheldSentence(key, isObject(before)));
      continue;
    }

    out.push(
      isObject(before)
        ? `${label(key)} changed from ${show(key, x)} to ${show(key, y)}.`
        : `${label(key)}: ${show(key, y)}.`,
    );
  }

  if (
    Array.isArray(a.items) &&
    JSON.stringify(b.items) !== JSON.stringify(a.items)
  ) {
    out.push(`Order items updated (${a.items.length} lines).`);
  }

  if (
    Array.isArray(a.lines) &&
    JSON.stringify(b.lines) !== JSON.stringify(a.lines)
  ) {
    out.push(`Lines updated (${a.lines.length}).`);
  }

  if (out.length > 0) return out;

  return [
    isObject(before) ? 'Saved with no visible change.' : 'Record created.',
  ];
}
