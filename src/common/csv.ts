import type { Response } from 'express';
import { formatIsoDate } from './calendar-date';
import { watToday } from './wat';
import { formatWatClock } from './wat-format';

/**
 * CSV, written by hand: a cell, a document, and the response that sends one.
 *
 * Shared so that every download goes through the formula guard below. Two
 * copies of it would be two places for one of them to be forgotten.
 */

/** A whole or decimal number, signed or not: `12`, `-2`, `-4000.00`. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One CSV cell, RFC 4180: quoted when it holds a comma, a quote or a line
 * break, with quotes doubled.
 *
 * A cell that begins `=`, `+`, `-`, `@`, a tab or a carriage return is also
 * prefixed with an apostrophe, because a spreadsheet opens those as formulas.
 * A name or a reason is typed by a person, and the guard costs nothing.
 *
 * **A plain number is left alone**, negative ones included. A stock count
 * that is two short is the cell `-2`, and prefixed it would open as the text
 * `'-2`: a column of gaps nobody can add up. Nothing but digits, one leading
 * minus and one decimal point passes, so `-cmd` and `+234` are still guarded.
 */
export function csvCell(value: string): string {
  const safe =
    /^[=+\-@\t\r]/.test(value) && !PLAIN_NUMBER.test(value)
      ? `'${value}`
      : value;

  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A CSV document: rows of cells, CRLF line ends, the header always first. */
export function csvDocument(header: string[], rows: string[][]): string {
  return [header, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
    .concat('\r\n');
}

/**
 * `2026-10-14 00:30` — a WAT date and wall clock, for an instant whose date
 * no other column of its line carries: a cancellation may come days later.
 * An empty cell for no instant.
 */
export function watDateAndClock(instant: Date | null): string {
  return instant === null
    ? ''
    : `${formatIsoDate(watToday(instant))} ${formatWatClock(instant)}`;
}

/** A CSV document and the name it downloads under. */
export interface CsvFile {
  filename: string;
  body: string;
}

/**
 * Answer a request with a CSV file: the two headers that make a browser save
 * it under its name, and the document as the body.
 *
 * For a handler that takes `@Res({ passthrough: true })` and returns what
 * this returns. The content type and the quoting of the filename are one
 * rule, not one per controller.
 */
export function sendCsvFile(response: Response, file: CsvFile): string {
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename}"`,
  );

  return file.body;
}
