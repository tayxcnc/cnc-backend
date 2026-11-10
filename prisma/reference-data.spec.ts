import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUSINESS, SETTINGS, VENUES } from './seed-data/reference';

/**
 * The reference data the seed writes, checked without a database: the rooms
 * and tables the plan counts (§4.1: 23 tables, 58 places), the settings Q7
 * lists, and the settings against the migration's column defaults.
 */
describe('reference data', () => {
  describe('rooms and tables', () => {
    it('has Dining and the Lounge, with their group-booking thresholds', () => {
      expect(
        VENUES.map(({ slug, customerTitle, staffName, bigParty, sort }) => ({
          slug,
          customerTitle,
          staffName,
          bigParty,
          sort,
        })),
      ).toEqual([
        {
          slug: 'dining',
          customerTitle: 'Dining',
          staffName: 'Diner',
          bigParty: 4,
          sort: 1,
        },
        {
          slug: 'lounge',
          customerTitle: 'Lounge',
          staffName: 'Lounge',
          bigParty: 5,
          sort: 2,
        },
      ]);
    });

    it('has 23 tables and 58 places: 13 tables and 28 places in Dining, 10 and 30 in the Lounge', () => {
      const tables = VENUES.flatMap((venue) => venue.tables);
      const places = (list: readonly { capacity: number }[]) =>
        list.reduce((sum, table) => sum + table.capacity, 0);

      expect(tables).toHaveLength(23);
      expect(places(tables)).toBe(58);
      expect(VENUES[0].tables).toHaveLength(13);
      expect(places(VENUES[0].tables)).toBe(28);
      expect(VENUES[1].tables).toHaveLength(10);
      expect(places(VENUES[1].tables)).toBe(30);
    });

    it('keeps codes unique within a room, while TS1 to TS3 exist in both', () => {
      for (const venue of VENUES) {
        const codes = venue.tables.map((table) => table.code);

        expect(new Set(codes).size).toBe(codes.length);
      }

      for (const code of ['TS1', 'TS2', 'TS3']) {
        expect(
          VENUES.every((venue) =>
            venue.tables.some((table) => table.code === code),
          ),
        ).toBe(true);
      }
    });

    it('gives every table a positive capacity, as the CHECK requires', () => {
      expect(
        VENUES.flatMap((venue) => venue.tables).every(
          (table) => Number.isInteger(table.capacity) && table.capacity > 0,
        ),
      ).toBe(true);
    });
  });

  describe('settings', () => {
    it("holds Q7's values", () => {
      expect(SETTINGS).toEqual({
        vatBps: 750,
        serviceBps: 0,
        depositKobo: 0,
        freeTableReminderMinutes: 180,
        deliveryJosKobo: 500000,
        deliveryOutsideKobo: 1000000,
        approvalLimitKobo: 5000000,
        dailyLimitOn: true,
        dailyLimitKobo: 15000000,
        printerWidth: 'MM58',
        alertLowStock: true,
        alertApprovals: true,
        alertUnsettled: true,
        alertArrivals: true,
        lastArrivalMinutes: 1380,
        lastOrderSlotMinutes: 1410,
        slotStepMinutes: 30,
        leadPickupMinutes: 60,
        leadJosMinutes: 90,
        leadOutsideMinutes: 120,
      });
    });

    it('equals the column defaults the C3 core migration gives the Settings table, except the paper', () => {
      const sql = readFileSync(
        join(
          __dirname,
          'migrations',
          '20261020223514_c3_core',
          'migration.sql',
        ),
        'utf8',
      );
      const table = /CREATE TABLE "Settings" \(([\s\S]*?)\n\);/.exec(sql)?.[1];

      expect(table).toBeDefined();

      const defaults: Record<string, unknown> = {};

      for (const [, column, value] of (table ?? '').matchAll(
        /"(\w+)" [^,\n]* DEFAULT ([^,\n]+),/g,
      )) {
        if (
          column === 'createdAt' ||
          column === 'singleton' ||
          column === 'version'
        ) {
          continue;
        }

        defaults[column] =
          value === 'true'
            ? true
            : value === 'false'
              ? false
              : (/^'(.*)'$/.exec(value)?.[1] ?? Number(value));
      }

      // CS B2: the seed starts the receipt paper at 58 mm, while the column
      // default stays 80 mm because the change ships with no migration. It
      // is the one difference, so a suite that needs the seeded row writes
      // it from SETTINGS (test/seeded-settings.ts), never from the defaults.
      expect(defaults).toEqual({ ...SETTINGS, printerWidth: 'MM80' });
      expect(SETTINGS.printerWidth).toBe('MM58');
    });
  });

  describe('business', () => {
    it("holds Q7's details with batch 2's phone and Instagram, digits for the phone and no country in the address", () => {
      expect(BUSINESS).toEqual({
        name: 'Chef Noro Culinary',
        addressLine:
          '7A Hospital Place, opposite Water Board, Jos, Plateau State',
        addressLines: ['7A Hospital Place,', 'opposite Water Board, Jos'],
        phone: '09113500003',
        email: 'chefnoroculinarycnc@gmail.com',
        registration: 'RC 765598',
        mapLat: 9.897137833050548,
        mapLng: 8.889460545696355,
        socialLinks: {
          instagram: 'https://www.instagram.com/chefnoroculinary',
        },
      });
    });
  });
});
