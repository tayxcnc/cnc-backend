/**
 * A controlled clock for e2e suites (see *Local environment* in
 * `docs/conventions.md`): `Date` is faked and every timer stays real, so the
 * pool, the HTTP server and Postgres I/O keep running. The server reads the
 * time through `new Date()` in the same process and so sees this clock.
 * Call `jest.useRealTimers()` in the suite's `afterAll`.
 */
export function fakeDateOnly(now: number): void {
  jest.useFakeTimers({
    now,
    advanceTimers: true,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

const HOUR = 60 * 60 * 1000;

/**
 * The next 12:00 in Jos after the real time: an instant far from both
 * Lagos midnights, so a suite that runs for minutes never crosses a
 * business day, and an hour-of-day rule (a booking's start) never meets
 * the edge of the day.
 */
export function nextNoonInJos(): number {
  const now = Date.now();
  const at = new Date(now);
  // Jos is UTC+1 all year: 11:00 UTC is 12:00 WAT.
  let noon = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    11,
  );

  while (noon <= now) noon += 24 * HOUR;

  return noon;
}
