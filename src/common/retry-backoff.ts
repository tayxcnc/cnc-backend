/**
 * When something whose send has just failed may be tried again, after
 * `attempts` spent, from a list of waits (`waits[0]` after the first
 * failure, `waits[1]` after the second…). Past the last listed wait the
 * last one repeats, and an attempt count below one reads as one, so the
 * answer is always a real instant after `now`.
 *
 * Shared by the outbound mail queue (`retryAfterFor`) and the push queue
 * (`pushRetryAfter`), each with its own waits: one clamp, so the two
 * queues cannot disagree about which wait an attempt count means.
 */
export function retryAfterBackoff(
  waits: readonly number[],
  attempts: number,
  now: Date,
): Date {
  const index = Math.min(Math.max(attempts, 1) - 1, waits.length - 1);

  return new Date(now.getTime() + waits[index]);
}
