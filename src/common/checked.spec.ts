import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminReason, ADMIN_REASON_MESSAGE } from './admin-reason';
import {
  calendarDate,
  Checked,
  requiredText,
  textUpTo,
  wholeNumber,
} from './checked';

class Probe {
  @Checked(wholeNumber(1, 'Enter a whole number above zero.'))
  qty!: number;

  @AdminReason('Why.')
  reason!: string;
}

/** Every message a body would answer, as the ValidationPipe lists them. */
function messages(body: object): string[] {
  return validateSync(plainToInstance(Probe, body)).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
}

describe('Checked', () => {
  it('answers a missing reason with the demo sentence, once', () => {
    expect(messages({ qty: 1 })).toEqual([ADMIN_REASON_MESSAGE]);
    expect(messages({ qty: 1, reason: '   ' })).toEqual([ADMIN_REASON_MESSAGE]);
    expect(messages({ qty: 1, reason: 4 })).toEqual([ADMIN_REASON_MESSAGE]);
  });

  it('answers a long reason with the length sentence only', () => {
    expect(messages({ qty: 1, reason: 'x'.repeat(501) })).toEqual([
      'reason must be 500 characters or fewer.',
    ]);
  });

  it('answers a bad number once, whatever is wrong with it', () => {
    for (const qty of [0.5, 0, -1, '1', 2_147_483_648, undefined]) {
      expect(messages({ qty, reason: 'ok' })).toEqual([
        'Enter a whole number above zero.',
      ]);
    }
  });

  it('passes good values', () => {
    expect(messages({ qty: 3, reason: 'Miscount' })).toEqual([]);
  });

  it('requiredText trims and caps', () => {
    const check = requiredText('Name it.', 3, 'Too long.');

    expect(check('abc')).toBeNull();
    expect(check('')).toBe('Name it.');
    expect(check(null)).toBe('Name it.');
    expect(check('abcd')).toBe('Too long.');
  });

  it('textUpTo takes any text, empty included, up to its length', () => {
    const check = textUpTo('Must be text.', 3, 'Too long.');

    expect(check('')).toBeNull();
    expect(check('abc')).toBeNull();
    expect(check('abcd')).toBe('Too long.');
    expect(check(3)).toBe('Must be text.');
    expect(check(null)).toBe('Must be text.');
  });

  it('calendarDate takes a real YYYY-MM-DD day only', () => {
    const check = calendarDate('Enter a valid kitchen date.');

    expect(check('2026-10-21')).toBeNull();
    expect(check('2028-02-29')).toBeNull();

    for (const value of [
      '2026-02-30',
      '2026-10-21T00:00:00Z',
      '21/10/2026',
      '',
      20261021,
      null,
      undefined,
    ]) {
      expect(check(value)).toBe('Enter a valid kitchen date.');
    }
  });
});
