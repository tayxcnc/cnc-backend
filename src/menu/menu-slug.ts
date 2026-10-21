import type { Prisma } from '../../generated/cnc-client';

/** Longest slug made from a name, before any `-2` suffix. */
const MAX_SLUG_BASE = 80;

/**
 * A name in the website's slug form: `Zobo Spritz` → `zobo-spritz`,
 * `Mac & Cheese` → `mac-and-cheese`, accents dropped (`Café` → `cafe`).
 * A name with no letters or digits at all becomes `item`.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_BASE)
    .replace(/-+$/, '');

  return slug === '' ? 'item' : slug;
}

/**
 * The first of `base`, `base-2`, `base-3`… that no item holds.
 *
 * Menu items are never deleted, so every slug ever issued is still in the
 * table, and "unused" here is "never used": a slug is never reused (plan
 * §4.1), because a link or a saved cart that names it must keep meaning the
 * same dish.
 */
export function firstFreeSlug(
  base: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(base)) return base;

  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A slug for a new item, made from its name and unique among every item.
 *
 * Two Owners adding "Zobo Spritz" at the same moment would both find
 * `zobo-spritz` free, so the choice is made under an advisory lock held to
 * the end of the transaction: the second waits, then sees the first's row
 * and takes `zobo-spritz-2`. The unique index stays the last word.
 */
export async function uniqueSlug(
  tx: Prisma.TransactionClient,
  name: string,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cnc:menu-slug'))`;

  const base = slugify(name);
  const rows = await tx.menuItem.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  });

  return firstFreeSlug(base, new Set(rows.map((row) => row.slug)));
}
