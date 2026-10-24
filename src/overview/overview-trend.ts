import {
  addDays,
  daysBetween,
  formatIsoDate,
  parseIsoDate,
} from '../common/calendar-date';
import { watToday } from '../common/wat';

/**
 * The Sales Trend's buckets: the demo's `overviewSales` interval and
 * bucket loop (`staff/lib/overview.ts`), on the server. Pure, so the unit
 * spec pins the switch at 1, 62 and 63 days without a database.
 */

/** The chart's step, travelling `UPPER_SNAKE` (A5). */
export const OverviewInterval = {
  HOUR: 'HOUR',
  DAY: 'DAY',
  MONTH: 'MONTH',
} as const;

export type OverviewInterval =
  (typeof OverviewInterval)[keyof typeof OverviewInterval];

/** One point of the chart. */
export interface TrendBucket {
  /** `00`…`23` (Lagos hour), `YYYY-MM-DD` or `YYYY-MM`. */
  key: string;
  /** The demo's axis label: `00:00`, `1 Oct`, `Oct 26`. */
  name: string;
  amountKobo: number;
}

/** Days in an inclusive range of business dates (`YYYY-MM-DD`). */
export function rangeDays(from: string, to: string): number {
  return daysBetween(parseIsoDate(from)!, parseIsoDate(to)!) + 1;
}

/** The demo's rule: hourly for one day, daily up to 62 days, then monthly. */
export function trendInterval(days: number): OverviewInterval {
  if (days === 1) return OverviewInterval.HOUR;

  return days > 62 ? OverviewInterval.MONTH : OverviewInterval.DAY;
}

/**
 * The empty buckets of a range, in order: 24 hours for one day; every
 * date of a daily range; every month from the first one's 1st whose 1st
 * is not after `to` for a monthly range. Labels are the demo's own
 * `toLocaleDateString('en-GB', { timeZone: 'UTC', … })` calls.
 */
export function trendBuckets(
  from: string,
  to: string,
  interval: OverviewInterval,
): TrendBucket[] {
  const buckets: TrendBucket[] = [];

  if (interval === OverviewInterval.HOUR) {
    for (let hour = 0; hour < 24; hour++) {
      const key = String(hour).padStart(2, '0');

      buckets.push({ key, name: `${key}:00`, amountKobo: 0 });
    }

    return buckets;
  }

  const monthly = interval === OverviewInterval.MONTH;
  let day = parseIsoDate(monthly ? `${from.slice(0, 7)}-01` : from)!;

  while (formatIsoDate(day) <= to) {
    const noon = new Date(day.getTime() + 12 * 60 * 60 * 1000);

    buckets.push({
      key: formatIsoDate(day).slice(0, monthly ? 7 : 10),
      name: noon.toLocaleDateString('en-GB', {
        timeZone: 'UTC',
        ...(monthly
          ? { month: 'short', year: '2-digit' }
          : { day: 'numeric', month: 'short' }),
      }),
      amountKobo: 0,
    });

    day = monthly
      ? new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1))
      : addDays(day, 1);
  }

  return buckets;
}

const LAGOS_HOUR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  hour: '2-digit',
  hourCycle: 'h23',
});

/**
 * The bucket a bill settled at `settledAt` falls in: its Lagos hour, its
 * Lagos settlement date, or that date's month.
 */
export function trendKey(settledAt: Date, interval: OverviewInterval): string {
  if (interval === OverviewInterval.HOUR) return LAGOS_HOUR.format(settledAt);

  return formatIsoDate(watToday(settledAt)).slice(
    0,
    interval === OverviewInterval.MONTH ? 7 : 10,
  );
}
