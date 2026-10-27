import { PrinterWidth, TableKind } from '../../generated/cnc-client';

/**
 * The reference data the seed writes: the settings row, CNC's business
 * details, and the two rooms with their tables. Data only; `data-seed.ts`
 * writes it.
 *
 * Every value is the code's today, as plan §18 Q7 lists them for the
 * founder to confirm or correct. Q7 is open, so its stated default applies:
 * these are the values seeded. A value changed later is changed in the
 * staff app (Settings), never by editing this file and re-seeding: the seed
 * only ever inserts what is missing (`data-seed.ts`).
 */

/**
 * The settings row (plan §4.1 "Settings", Q7). Rates are basis points, money
 * is kobo, times are minutes after midnight in Lagos.
 *
 * These equal the column defaults of the C3 core migration, and
 * `reference-data.spec.ts` holds the two together: the defaults are what a
 * row written by any other path would get, and a seed that disagreed with
 * them would leave two answers to "what is VAT".
 */
export const SETTINGS = {
  /** VAT 7.5% (Q7). */
  vatBps: 750,
  /** Service charge 0%, "because no rate was supplied" (Q7). */
  serviceBps: 0,
  /** No booking deposits (D38). */
  depositKobo: 0,
  /** The Free Table Reminder, 180 minutes (Q7, D37). */
  freeTableReminderMinutes: 180,
  /** ₦5,000 within Jos (Q7). */
  deliveryJosKobo: 500000,
  /** ₦10,000 elsewhere in Plateau (Q7). */
  deliveryOutsideKobo: 1000000,
  /** The Owner Approval Limit, ₦50,000 per decision (Q7). */
  approvalLimitKobo: 5000000,
  /** The Daily Approval Limit, on, at ₦150,000 per manager per day (Q7). */
  dailyLimitOn: true,
  dailyLimitKobo: 15000000,
  /** The staff app's default paper, `80mm`. */
  printerWidth: PrinterWidth.MM80,
  /** The staff app's bell switches, all on (`ALERTS` in `domain.ts`). */
  alertLowStock: true,
  alertApprovals: true,
  alertUnsettled: true,
  alertArrivals: true,
  /** Last table booking 23:00 (Q7). */
  lastArrivalMinutes: 1380,
  /** Last order slot 23:30 (Q7). */
  lastOrderSlotMinutes: 1410,
  /** The website's 30-minute arrival and order grid. */
  slotStepMinutes: 30,
  /** Lead times: 60 minutes pickup, 90 within Jos, 120 outside (Q7). */
  leadPickupMinutes: 60,
  leadJosMinutes: 90,
  leadOutsideMinutes: 120,
} as const;

/**
 * CNC's business details (plan §4.1 "Business", Q7, D28), from the website's
 * `lib/site.ts` and the staff app's `BUSINESS`.
 *
 * `phone` is digits only; the site formats it ("0802 218 8797").
 * `addressLine` carries no country; the site appends ", Nigeria", and the
 * receipt omits it, as the staff app's receipt does today. `addressLines`
 * is the website's two-line form, punctuation included. The map pin is the
 * one CNC confirmed. `socialLinks` stays empty until the accounts are
 * supplied.
 */
export const BUSINESS = {
  name: 'Chef Noro Culinary',
  addressLine: '7A Hospital Place, opposite Water Board, Jos, Plateau State',
  addressLines: ['7A Hospital Place,', 'opposite Water Board, Jos'],
  phone: '08022188797',
  email: 'chefnoroculinarycnc@gmail.com',
  registration: 'RC 765598',
  mapLat: 9.897137833050548,
  mapLng: 8.889460545696355,
  socialLinks: {},
} as const;

export interface TableSeed {
  code: string;
  name: string;
  kind: TableKind;
  capacity: number;
}

export interface VenueSeed {
  slug: string;
  customerTitle: string;
  staffName: string;
  bigParty: number;
  sort: number;
  tables: readonly TableSeed[];
}

/**
 * The two rooms and their 23 tables, 58 places (plan §4.1, D25).
 *
 * Codes, names, kinds and capacities are the staff app's floor plans
 * (`staff/lib/floorplans.json`), which match the website's
 * (`lib/booking/floorplans.ts`) table for table, in the floor plans' order.
 * `bigParty` is the website's (`lib/booking/engine.ts`): from 4 guests in
 * Dining and 5 in the Lounge, a booking goes to the team as a group
 * enquiry (Q7, "Large groups"). Coordinates, drawings and descriptive copy
 * stay in the frontends (D61).
 */
export const VENUES: readonly VenueSeed[] = [
  {
    slug: 'dining',
    customerTitle: 'Dining',
    staffName: 'Diner',
    bigParty: 4,
    sort: 1,
    tables: [
      { code: 'B1', name: 'Booth 1', kind: TableKind.BOOTH, capacity: 3 },
      { code: 'B2', name: 'Booth 2', kind: TableKind.BOOTH, capacity: 3 },
      { code: 'B3', name: 'Booth 3', kind: TableKind.BOOTH, capacity: 3 },
      { code: 'B4', name: 'Booth 4', kind: TableKind.BOOTH, capacity: 3 },
      {
        code: 'TS1',
        name: 'Dining table 1',
        kind: TableKind.DINING,
        capacity: 2,
      },
      {
        code: 'TS2',
        name: 'Dining table 2',
        kind: TableKind.DINING,
        capacity: 2,
      },
      {
        code: 'TS3',
        name: 'Dining table 3',
        kind: TableKind.DINING,
        capacity: 2,
      },
      {
        code: 'THS2',
        name: 'Window table 2',
        kind: TableKind.WINDOW,
        capacity: 3,
      },
      {
        code: 'THS1',
        name: 'Window table 1',
        kind: TableKind.WINDOW,
        capacity: 3,
      },
      {
        code: 'S4',
        name: 'Counter seat 4',
        kind: TableKind.COUNTER,
        capacity: 1,
      },
      {
        code: 'S3',
        name: 'Counter seat 3',
        kind: TableKind.COUNTER,
        capacity: 1,
      },
      {
        code: 'S2',
        name: 'Counter seat 2',
        kind: TableKind.COUNTER,
        capacity: 1,
      },
      {
        code: 'S1',
        name: 'Counter seat 1',
        kind: TableKind.COUNTER,
        capacity: 1,
      },
    ],
  },
  {
    slug: 'lounge',
    customerTitle: 'Lounge',
    staffName: 'Lounge',
    bigParty: 5,
    sort: 2,
    tables: [
      {
        code: 'TDS5',
        name: 'Sofa setting 5',
        kind: TableKind.SOFA,
        capacity: 4,
      },
      {
        code: 'TDS4',
        name: 'Sofa setting 4',
        kind: TableKind.SOFA,
        capacity: 4,
      },
      {
        code: 'TDS3',
        name: 'Sofa setting 3',
        kind: TableKind.SOFA,
        capacity: 4,
      },
      {
        code: 'TDS2',
        name: 'Sofa setting 2',
        kind: TableKind.SOFA,
        capacity: 4,
      },
      {
        code: 'TDS1',
        name: 'Sofa setting 1',
        kind: TableKind.SOFA,
        capacity: 4,
      },
      { code: 'TS5', name: 'Lounge table 5', kind: TableKind.TWO, capacity: 2 },
      { code: 'TS4', name: 'Lounge table 4', kind: TableKind.TWO, capacity: 2 },
      { code: 'TS3', name: 'Lounge table 3', kind: TableKind.TWO, capacity: 2 },
      { code: 'TS2', name: 'Lounge table 2', kind: TableKind.TWO, capacity: 2 },
      { code: 'TS1', name: 'Lounge table 1', kind: TableKind.TWO, capacity: 2 },
    ],
  },
];
