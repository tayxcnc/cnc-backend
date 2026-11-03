import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { spelledOldNumber } from './old-business-phone';

/**
 * The contact details migration (batch 2 section 2, decision P43), run
 * twice over each kind of Business row it may meet on a database migrated
 * before it.
 *
 * Its own database, because the suite deletes and rewrites the one Business
 * row, which every other suite reads. The migration has already run there
 * once with no row (as on a fresh database), so each fixture below is
 * inserted afterwards and the migration's SQL is run on it again, twice.
 */
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

const NEW_PHONE = '09113500003';
const INSTAGRAM = 'https://www.instagram.com/chefnoroculinary';

/** A moment before the migration ran, so a stamped `updatedAt` shows. */
const BEFORE = new Date('2026-10-01T09:00:00.000Z');

interface BusinessRow {
  phone: string;
  socialLinks: unknown;
  version: number;
  updatedAt: Date;
}

function migrationSql(): string {
  const directories = readdirSync(MIGRATIONS).filter((name) =>
    name.endsWith('_contact_details_batch2'),
  );

  if (directories.length !== 1) {
    throw new Error(
      `Expected one contact details migration, found ${directories.length}.`,
    );
  }

  return readFileSync(
    join(MIGRATIONS, directories[0], 'migration.sql'),
    'utf8',
  );
}

describe('the contact details migration', () => {
  let database: IsolatedDatabase;
  let client: Client;
  const sql = migrationSql();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    client = new Client({ connectionString: database.url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await database?.drop();
  });

  /** The one Business row, replaced by this one. */
  async function startFrom(phone: string, socialLinks: unknown): Promise<void> {
    await client.query('DELETE FROM "Business"');
    await client.query(
      `INSERT INTO "Business"
         ("id", "updatedAt", "singleton", "name", "addressLine",
          "addressLines", "phone", "email", "registration", "socialLinks",
          "version")
       VALUES ('business', $1, true, 'Chef Noro Culinary',
          '7A Hospital Place, opposite Water Board, Jos, Plateau State',
          ARRAY['7A Hospital Place,', 'opposite Water Board, Jos'],
          $2, 'chefnoroculinarycnc@gmail.com', 'RC 765598', $3::jsonb, 4)`,
      [BEFORE, phone, JSON.stringify(socialLinks)],
    );
  }

  async function row(): Promise<BusinessRow> {
    const { rows } = await client.query<BusinessRow>(
      'SELECT "phone", "socialLinks", "version", "updatedAt" FROM "Business"',
    );

    expect(rows).toHaveLength(1);

    return rows[0];
  }

  /** The migration's SQL, as `migrate deploy` would run it. */
  async function migrate(): Promise<BusinessRow> {
    await client.query(sql);

    return row();
  }

  it.each([
    ['as the service stores it', spelledOldNumber('0', '')],
    ['as someone might have typed it', spelledOldNumber('+234 ', ' ')],
  ])(
    'moves a row still holding the old number (%s) to the new number and Instagram, keeping the other links, once',
    async (_label, oldPhone) => {
      await startFrom(oldPhone, {
        facebook: 'https://www.facebook.com/example',
        instagram: 'https://www.instagram.com/example',
      });

      const first = await migrate();

      expect(first).toMatchObject({
        phone: NEW_PHONE,
        socialLinks: {
          facebook: 'https://www.facebook.com/example',
          instagram: INSTAGRAM,
        },
        // Moved, so a Settings page opened before gets the 409.
        version: 5,
      });
      expect(first.updatedAt.getTime()).toBeGreaterThan(BEFORE.getTime());

      // A second run changes nothing: no version moves, nothing is stamped.
      expect(await migrate()).toEqual(first);
    },
  );

  it('leaves a row whose phone staff have typed since as it is, social links and version included', async () => {
    await startFrom('08031234567', {});

    const before = await row();

    expect(await migrate()).toEqual(before);
    expect(await migrate()).toEqual(before);
    expect(before).toMatchObject({
      phone: '08031234567',
      socialLinks: {},
      version: 4,
    });
  });

  it('changes only the phone where the social links are not an object, once', async () => {
    await startFrom(spelledOldNumber('0', ''), []);

    const first = await migrate();

    expect(first).toMatchObject({
      phone: NEW_PHONE,
      socialLinks: [],
      version: 5,
    });

    expect(await migrate()).toEqual(first);
  });
});
