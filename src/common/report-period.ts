import { formatIsoDate } from './calendar-date';
import { resolveDateRange } from './date-range';
import { watDayBounds } from './wat';

/** The longest range one report read covers: a year. */
export const REPORT_MAX_DAYS = 366;

/** A report's range, as dates and as the instants that bound it in Jos. */
export interface ReportPeriod {
  /** The first business date, `@db.Date`-shaped (UTC midnight). */
  from: Date;
  /** The last business date, `@db.Date`-shaped. */
  to: Date;
  /** `from` as `YYYY-MM-DD`. */
  fromIso: string;
  /** `to` as `YYYY-MM-DD`. */
  toIso: string;
  /** 00:00 in Jos on `from`, as an instant. */
  start: Date;
  /** 00:00 in Jos on the day after `to`: the range is `start <= at < end`. */
  end: Date;
}

/**
 * The period every report under `staff/reports` reads (plan §10): `from`
 * and `to` as Lagos business dates, inclusive, today when absent, at most
 * {@link REPORT_MAX_DAYS} days, through `resolveDateRange`, so every report
 * answers a bad range in the same words (the demo's `validatePeriod`
 * checks the same two things on the screen before it asks: real dates, and
 * an end that does not come before the start).
 *
 * A record dated by a business date column is matched on `from`…`to`; one
 * dated by an instant (a settlement, a movement, a waste entry) on
 * `start`…`end`, the Jos midnights, so a sale at 00:30 in Jos belongs to
 * that day and not, as its UTC date says, to the one before.
 */
export function reportPeriod(
  query: { from?: string; to?: string },
  subject: string,
  now: Date = new Date(),
): ReportPeriod {
  const range = resolveDateRange(query, now, {
    defaultDays: 1,
    maxDays: REPORT_MAX_DAYS,
    subject,
  });

  return {
    from: range.from,
    to: range.to,
    fromIso: formatIsoDate(range.from),
    toIso: formatIsoDate(range.to),
    start: watDayBounds(range.from).start,
    end: watDayBounds(range.to).end,
  };
}
