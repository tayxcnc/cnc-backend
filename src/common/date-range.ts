import { BadRequestException } from '@nestjs/common';
import {
  addDays,
  daysBetween,
  formatIsoDate,
  parseIsoDate,
} from './calendar-date';
import { watToday } from './wat';

/** What a route decides about its own range. */
export interface DateRangeRules {
  /** How many days a range covers, ending on `to`, when `from` is left out. */
  defaultDays: number;

  /** The most days one request may cover. */
  maxDays: number;

  /** What the range is of, opening the over-long message: `Sales`. */
  subject: string;
}

/**
 * `from` and `to` as WAT calendar dates, inclusive, or a 400 saying which is
 * wrong.
 *
 * `to` defaults to today in Nigeria and `from` to the `defaultDays` ending on
 * `to`. An impossible date, a `to` before its `from`, and a range over
 * `maxDays` are each refused.
 *
 * Shared by every list read by business date, so the messages are one set of
 * words with the route's name passed in as `subject`.
 */
export function resolveDateRange(
  query: { from?: string; to?: string },
  now: Date,
  rules: DateRangeRules,
): { from: Date; to: Date } {
  const to = query.to === undefined ? watToday(now) : parseIsoDate(query.to);

  if (to === null) {
    throw new BadRequestException('to must be a real calendar date.');
  }

  const from =
    query.from === undefined
      ? addDays(to, -(rules.defaultDays - 1))
      : parseIsoDate(query.from);

  if (from === null) {
    throw new BadRequestException('from must be a real calendar date.');
  }

  if (from.getTime() > to.getTime()) {
    throw new BadRequestException('to must not be before from.');
  }

  const days = daysBetween(from, to) + 1;

  if (days > rules.maxDays) {
    throw new BadRequestException(
      `${rules.subject} covers at most ${rules.maxDays} days at a time; ` +
        `${formatIsoDate(from)} to ${formatIsoDate(to)} is ${days}.`,
    );
  }

  return { from, to };
}
