import {
  OverviewInterval,
  rangeDays,
  trendBuckets,
  trendInterval,
  trendKey,
} from './overview-trend';

describe('overview trend', () => {
  it('counts a range inclusively', () => {
    expect(rangeDays('2026-10-01', '2026-10-01')).toBe(1);
    expect(rangeDays('2026-09-01', '2026-11-01')).toBe(62);
    expect(rangeDays('2026-09-01', '2026-11-02')).toBe(63);
  });

  it('is hourly for one day, daily up to 62 days and monthly beyond', () => {
    expect(trendInterval(1)).toBe(OverviewInterval.HOUR);
    expect(trendInterval(2)).toBe(OverviewInterval.DAY);
    expect(trendInterval(62)).toBe(OverviewInterval.DAY);
    expect(trendInterval(63)).toBe(OverviewInterval.MONTH);
  });

  it('gives a day 24 hourly buckets', () => {
    const buckets = trendBuckets('2026-10-01', '2026-10-01', 'HOUR');

    expect(buckets).toHaveLength(24);
    expect(buckets[0]).toEqual({ key: '00', name: '00:00', amountKobo: 0 });
    expect(buckets[23]).toEqual({ key: '23', name: '23:00', amountKobo: 0 });
  });

  it('gives a daily range one bucket per date, labelled as the demo does', () => {
    const buckets = trendBuckets('2026-10-30', '2026-11-02', 'DAY');

    expect(buckets.map((b) => [b.key, b.name])).toEqual([
      ['2026-10-30', '30 Oct'],
      ['2026-10-31', '31 Oct'],
      ['2026-11-01', '1 Nov'],
      ['2026-11-02', '2 Nov'],
    ]);
  });

  it('starts a monthly range on the first month and stops at the last', () => {
    const buckets = trendBuckets('2026-10-15', '2027-01-03', 'MONTH');

    expect(buckets.map((b) => [b.key, b.name])).toEqual([
      ['2026-10', 'Oct 26'],
      ['2026-11', 'Nov 26'],
      ['2026-12', 'Dec 26'],
      ['2027-01', 'Jan 27'],
    ]);
  });

  it('files a sale by its Lagos hour, date or month', () => {
    // 23:30Z on 31 October is 00:30 on 1 November in Jos.
    const late = new Date('2026-10-31T23:30:00.000Z');

    expect(trendKey(late, 'HOUR')).toBe('00');
    expect(trendKey(late, 'DAY')).toBe('2026-11-01');
    expect(trendKey(late, 'MONTH')).toBe('2026-11');
    expect(trendKey(new Date('2026-10-31T22:59:00.000Z'), 'HOUR')).toBe('23');
  });
});
