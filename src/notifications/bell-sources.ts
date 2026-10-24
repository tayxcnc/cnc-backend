import type { StaffBellItem } from '../reception/free-table-reminder';
import type { StaffPage } from '../shell/staff-pages';

/**
 * One kind of bell item, read in two steps so a poll stays bounded: how
 * many there are (`count`, an indexed `COUNT`), and only the rows the
 * requested page shows (`rows`, `OFFSET`/`LIMIT` in the kind's own order).
 * `page` is the screen every item of the kind opens, which the bell checks
 * the reader can open.
 */
export interface BellSource {
  page: StaffPage;
  count(): Promise<number>;
  rows(skip: number, take: number): Promise<StaffBellItem[]>;
}

/**
 * A kind whose items are worked out whole, because there can only be a
 * handful (the Free Table Reminder: at most one per table). Loaded once,
 * however many times the pager asks.
 */
export function listedSource(
  page: StaffPage,
  load: () => Promise<StaffBellItem[]>,
): BellSource {
  let loaded: Promise<StaffBellItem[]> | undefined;
  const items = () => (loaded ??= load());

  return {
    page,
    count: async () => (await items()).length,
    rows: async (skip, take) => (await items()).slice(skip, skip + take),
  };
}

/**
 * The bell's page over its kinds, in order: every kind is counted, so
 * `total` is exact, and rows are read only from the kinds the page
 * overlaps, so one poll reads at most `pageSize` rows whatever is
 * pending. The kinds are read one after another, never in parallel, so a
 * poll never holds more than one of the pool's connections.
 */
export async function pageOfSources(
  sources: readonly BellSource[],
  page: number,
  pageSize: number,
): Promise<{ data: StaffBellItem[]; total: number }> {
  let skip = (page - 1) * pageSize;
  let room = pageSize;
  let total = 0;
  const data: StaffBellItem[] = [];

  for (const source of sources) {
    const count = await source.count();

    total += count;

    if (room === 0) continue;

    if (skip >= count) {
      skip -= count;
      continue;
    }

    const take = Math.min(room, count - skip);
    const rows = await source.rows(skip, take);

    data.push(...rows);
    room -= take;
    skip = 0;
  }

  return { data, total };
}
