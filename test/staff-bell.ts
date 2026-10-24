import request from 'supertest';
import type { App } from 'supertest/types';
import { MAX_PAGE_SIZE } from '../src/common/dto/pagination.query';

/** One staff bell item as `GET /staff/notifications` returns it. */
export interface BellItem {
  id: string;
  title: string;
  detail: string;
  page: string;
  category: string;
  ref?: string;
}

/**
 * Every item on a reader's bell, every page of it, in order (C8-2).
 *
 * A suite looking for one item reads them all: from C8-2 a manager's or
 * the Storekeeper's bell starts with a Low Stock item for every seeded Bar
 * item (none has a balance), which alone fills more than one page.
 */
export async function readBell(
  server: App,
  headers: Record<string, string>,
): Promise<{ data: BellItem[]; total: number }> {
  const data: BellItem[] = [];

  for (let page = 1; ; page += 1) {
    const body = (
      await request(server)
        .get('/api/v1/staff/notifications')
        .query({ page, pageSize: MAX_PAGE_SIZE })
        .set(headers)
        .expect(200)
    ).body as { data: BellItem[]; total: number };

    data.push(...body.data);

    if (body.data.length < MAX_PAGE_SIZE) return { data, total: body.total };
  }
}
