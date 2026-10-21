import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminReason, ADMIN_REASON_MESSAGE } from './admin-reason';
import { Checked, requiredText, wholeNumber } from './checked';

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
});
