import { plainToInstance } from 'class-transformer';
import { IsOptional, validateSync } from 'class-validator';
import { Checked, requiredText, textUpTo } from './checked';
import {
  hasLongDash,
  NO_LONG_DASHES_MESSAGE,
  noLongDashes,
} from './no-long-dashes';
import { OptionalText } from './optional-text';

class Probe {
  @Checked(noLongDashes(requiredText('Name it.', 20, 'Too long.')))
  name!: string;

  @IsOptional()
  @Checked(noLongDashes(textUpTo('alt must be text.', 20, 'Long alt.')))
  alt?: string | null;

  @OptionalText('service', 20, { noLongDashes: true })
  service?: string;

  @OptionalText('notes', 20)
  notes?: string;
}

/** Every message a body would answer, as the ValidationPipe lists them. */
function messages(body: object): string[] {
  return validateSync(plainToInstance(Probe, body)).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
}

describe('noLongDashes (G2, P18)', () => {
  it('refuses an em dash and an en dash with the brief’s sentence', () => {
    expect(messages({ name: 'Zobo — cold' })).toEqual([
      'Please rewrite this without long dashes.',
    ]);
    expect(messages({ name: 'Mon–Fri' })).toEqual([NO_LONG_DASHES_MESSAGE]);
  });

  it('lets a hyphen, a middle dot and plain text through', () => {
    expect(messages({ name: 'Walk-in' })).toEqual([]);
    expect(messages({ name: 'Rice · Egg' })).toEqual([]);
    expect(messages({ name: '6am to 9am' })).toEqual([]);
  });

  it('answers the field’s own sentence first, and only that one', () => {
    expect(messages({ name: '' })).toEqual(['Name it.']);
    expect(messages({ name: 4 })).toEqual(['Name it.']);
    expect(messages({ name: '—'.repeat(21) })).toEqual(['Too long.']);
    expect(messages({ name: 'Ok', alt: 5 })).toEqual(['alt must be text.']);
  });

  it('checks an optional field only when it is sent', () => {
    expect(messages({ name: 'Ok' })).toEqual([]);
    expect(messages({ name: 'Ok', alt: null })).toEqual([]);
    expect(messages({ name: 'Ok', alt: 'A – plate' })).toEqual([
      NO_LONG_DASHES_MESSAGE,
    ]);
  });

  it('is on OptionalText only when asked for, so notes keep taking a dash', () => {
    expect(messages({ name: 'Ok', service: 'Food – dry' })).toEqual([
      NO_LONG_DASHES_MESSAGE,
    ]);
    expect(messages({ name: 'Ok', notes: 'Call — late' })).toEqual([]);
    expect(messages({ name: 'Ok', notes: 'x'.repeat(21) })).toEqual([
      'notes must be 20 characters or fewer.',
    ]);
    expect(messages({ name: 'Ok', service: 3 })).toEqual([
      'service must be text.',
    ]);
  });

  it('leaves a value that is not text alone', () => {
    expect(hasLongDash(42)).toBe(false);
    expect(hasLongDash(null)).toBe(false);
    expect(hasLongDash(['—'])).toBe(false);
  });

  it('carries no long dash in its own sentence', () => {
    expect(hasLongDash(NO_LONG_DASHES_MESSAGE)).toBe(false);
  });
});
