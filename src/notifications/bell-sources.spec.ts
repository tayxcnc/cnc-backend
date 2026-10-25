import type { StaffBellItem } from '../reception/free-table-reminder';
import { type BellSource, listedSource, pageOfSources } from './bell-sources';

const item = (id: string): StaffBellItem => ({
  id,
  title: id,
  detail: '',
  page: 'tasks',
  category: 'Task',
});

/** A kind of `n` items named `<prefix>0…`, recording every read. */
function counted(prefix: string, n: number) {
  const reads: [number, number][] = [];
  const source: BellSource = {
    page: 'tasks',
    count: () => Promise.resolve(n),
    rows: (skip, take) => {
      reads.push([skip, take]);
      return Promise.resolve(
        Array.from({ length: Math.min(take, n - skip) }, (_, i) =>
          item(`${prefix}${skip + i}`),
        ),
      );
    },
  };

  return { source, reads };
}

describe('pageOfSources', () => {
  it('pages across kinds in order, with the exact total', async () => {
    const a = counted('a', 3);
    const b = counted('b', 0);
    const c = counted('c', 4);
    const sources = [a.source, b.source, c.source];

    const ids = async (page: number) =>
      (await pageOfSources(sources, page, 2)).data.map((one) => one.id);

    expect(await ids(1)).toEqual(['a0', 'a1']);
    expect(await ids(2)).toEqual(['a2', 'c0']);
    expect(await ids(3)).toEqual(['c1', 'c2']);
    expect(await ids(4)).toEqual(['c3']);
    expect(await ids(5)).toEqual([]);
    expect((await pageOfSources(sources, 5, 2)).total).toBe(7);
  });

  it('reads rows only from the kinds the page overlaps, at most a page of them', async () => {
    const a = counted('a', 50);
    const b = counted('b', 50);
    const c = counted('c', 50);

    await pageOfSources([a.source, b.source, c.source], 3, 20);

    // Rows 40 to 59: the last ten of a, the first ten of b, none of c.
    expect(a.reads).toEqual([[40, 10]]);
    expect(b.reads).toEqual([[0, 10]]);
    expect(c.reads).toEqual([]);
  });

  it('loads a listed kind once, however it is paged', async () => {
    const load = jest.fn(() => Promise.resolve([item('x'), item('y')]));
    const listed = listedSource('reception', load);

    const result = await pageOfSources([listed], 1, 1);

    expect(result).toEqual({ data: [item('x')], total: 2 });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
