import {
  AuditActorKind,
  Department,
  MenuCategoryKind,
  type PrismaClient,
} from '../generated/cnc-client';
import { createSeedClient } from '../prisma/seed-client';
import {
  applyFindings,
  findLongDashes,
  TARGETS,
} from '../scripts/report-long-dashes';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';

/**
 * The optional long-dash report (`scripts/report-long-dashes.ts`, P19)
 * against Postgres: what it finds, what `--apply` writes, that a second run
 * finds and writes nothing, that a value changed since the read is
 * skipped, and that the business details, the activity history and a
 * vendor's notes are never touched.
 *
 * Its own database, because the report scans whole tables and `--apply`
 * writes every row it finds: on the shared test database it would meet
 * other suites' rows.
 */
describe('The long-dash report (e2e)', () => {
  const originalUrl = process.env.CNC_DB_URL;

  let database: IsolatedDatabase;
  let prisma: PrismaClient;

  let dishId: string;
  let vendorId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;
    prisma = createSeedClient();

    const menuCategory = await prisma.menuCategory.create({
      data: {
        slug: 'drinks',
        title: 'Drinks',
        kind: MenuCategoryKind.DRINKS,
        sort: 1,
      },
    });
    const staffCategory = await prisma.staffCategory.create({
      data: {
        name: 'Cocktails',
        department: Department.BAR,
        menuCategoryId: menuCategory.id,
      },
    });

    dishId = (
      await prisma.menuItem.create({
        data: {
          slug: 'zobo-spritz',
          department: Department.BAR,
          staffCategoryId: staffCategory.id,
          menuCategoryId: menuCategory.id,
          name: 'Zobo — Spritz',
          description: 'Serves 2–4',
          photoAlt: '— a tall glass',
          priceKobo: 350000,
        },
      })
    ).id;
    // A clean item and a hyphen: nothing to find.
    await prisma.menuItem.create({
      data: {
        slug: 'chapman',
        department: Department.BAR,
        staffCategoryId: staffCategory.id,
        menuCategoryId: menuCategory.id,
        name: 'Chapman',
        description: 'Walk-in favourite',
        priceKobo: 250000,
      },
    });

    vendorId = (
      await prisma.vendor.create({
        data: {
          name: 'Plateau – Fresh',
          phone: '08000000010',
          notes: 'Call first — mornings only',
        },
      })
    ).id;

    await prisma.business.create({
      data: {
        name: 'CNC',
        addressLine: 'Rayfield — Jos',
        addressLines: ['Rayfield — Jos'],
        phone: '09113500003',
        email: 'hello@example.com',
        registration: '',
      },
    });
    await prisma.auditLog.create({
      data: {
        actorKind: AuditActorKind.SYSTEM,
        actorName: 'CNC',
        action: 'menu.save',
        module: 'Menu & Prices',
        reason: 'Renamed — guest feedback',
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  it('reads only menu items and vendors, never the business, the history or a note', () => {
    expect(new Set(TARGETS.map((target) => target.table))).toEqual(
      new Set(['MenuItem', 'Vendor']),
    );
    expect(TARGETS.map((target) => target.column)).not.toContain('notes');
  });

  it('finds each dash in the scanned fields, and writes nothing while reporting', async () => {
    const findings = await findLongDashes(prisma);

    expect(findings).toEqual(
      expect.arrayContaining([
        {
          table: 'MenuItem',
          column: 'name',
          id: dishId,
          before: 'Zobo — Spritz',
          after: 'Zobo, Spritz',
        },
        {
          table: 'MenuItem',
          column: 'description',
          id: dishId,
          before: 'Serves 2–4',
          after: 'Serves 2 to 4',
        },
        {
          table: 'MenuItem',
          column: 'photoAlt',
          id: dishId,
          before: '— a tall glass',
          after: 'a tall glass',
        },
        {
          table: 'Vendor',
          column: 'name',
          id: vendorId,
          before: 'Plateau – Fresh',
          after: 'Plateau, Fresh',
        },
      ]),
    );
    expect(findings).toHaveLength(4);

    const dish = await prisma.menuItem.findUniqueOrThrow({
      where: { id: dishId },
      select: { name: true, version: true },
    });
    expect(dish).toEqual({ name: 'Zobo — Spritz', version: 0 });
  });

  it('skips a value changed since it was read', async () => {
    const findings = await findLongDashes(prisma);

    await prisma.vendor.update({
      where: { id: vendorId },
      data: { name: 'Plateau — Fresh Foods', version: { increment: 1 } },
    });

    const vendorFinding = findings.filter((f) => f.table === 'Vendor');
    expect(await applyFindings(prisma, vendorFinding)).toEqual({
      written: 0,
      skipped: 1,
    });
    expect(
      (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).name,
    ).toBe('Plateau — Fresh Foods');
  });

  it('cleans every finding with --apply, moves each version, and a second run does nothing', async () => {
    const findings = await findLongDashes(prisma);
    expect(findings).toHaveLength(4);

    expect(await applyFindings(prisma, findings)).toEqual({
      written: 4,
      skipped: 0,
    });

    expect(
      await prisma.menuItem.findUniqueOrThrow({
        where: { id: dishId },
        select: {
          name: true,
          description: true,
          photoAlt: true,
          version: true,
        },
      }),
    ).toEqual({
      name: 'Zobo, Spritz',
      description: 'Serves 2 to 4',
      photoAlt: 'a tall glass',
      version: 3,
    });
    expect(
      await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
        select: { name: true, notes: true, version: true },
      }),
    ).toEqual({
      name: 'Plateau, Fresh Foods',
      notes: 'Call first — mornings only',
      version: 2,
    });

    expect(await findLongDashes(prisma)).toEqual([]);
    expect(await applyFindings(prisma, [])).toEqual({ written: 0, skipped: 0 });

    // Never touched: the business details and the activity history.
    expect(
      await prisma.business.findFirstOrThrow({
        select: { addressLine: true, addressLines: true, version: true },
      }),
    ).toEqual({
      addressLine: 'Rayfield — Jos',
      addressLines: ['Rayfield — Jos'],
      version: 0,
    });
    expect(
      (await prisma.auditLog.findFirstOrThrow({ select: { reason: true } }))
        .reason,
    ).toBe('Renamed — guest feedback');
  });
});
