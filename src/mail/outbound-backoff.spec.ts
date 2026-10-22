import {
  MESSAGE_MAX_ATTEMPTS,
  MESSAGE_RETRY_BACKOFF_MS,
  retryAfterFor,
} from './outbound-messages.service';

const MINUTE = 60 * 1000;
const NOW = new Date('2026-10-22T12:00:00.000Z');

describe('retryAfterFor', () => {
  it('waits 5 minutes after the first failed send and 30 after the second', () => {
    expect(retryAfterFor(1, NOW).getTime() - NOW.getTime()).toBe(5 * MINUTE);
    expect(retryAfterFor(2, NOW).getTime() - NOW.getTime()).toBe(30 * MINUTE);
  });

  it('has a wait for every attempt that can be followed by another', () => {
    expect(MESSAGE_RETRY_BACKOFF_MS.length).toBe(MESSAGE_MAX_ATTEMPTS - 1);
  });

  it('repeats the last wait past the list and never answers the past', () => {
    expect(retryAfterFor(9, NOW).getTime() - NOW.getTime()).toBe(30 * MINUTE);
    expect(retryAfterFor(0, NOW).getTime()).toBeGreaterThan(NOW.getTime());
  });
});
