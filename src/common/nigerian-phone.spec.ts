import {
  canonicalNigerianPhone,
  NIGERIAN_PHONE,
  phoneForDisplay,
} from './nigerian-phone';

describe('phoneForDisplay', () => {
  it('shows a stored number as the website does', () => {
    // cnc-frontend/lib/site.ts: phoneDisplay "0802 218 8797".
    expect(phoneForDisplay('08022188797')).toBe('0802 218 8797');
    expect(phoneForDisplay('08031234567')).toBe('0803 123 4567');
  });

  it('leaves anything not in the stored form as it is', () => {
    expect(phoneForDisplay('+442079460958')).toBe('+442079460958');
    expect(phoneForDisplay('0802 218 8797')).toBe('0802 218 8797');
    expect(phoneForDisplay('')).toBe('');
  });
});

/** The stored form, as the CHECK on `Customer.phone` in the C3 migration. */
const STORED_FORM = /^0[789][01]\d{8}$/;

describe('canonicalNigerianPhone', () => {
  it('writes the +234 form as 0 plus 10 digits', () => {
    expect(canonicalNigerianPhone('+2348031234567')).toBe('08031234567');
    expect(canonicalNigerianPhone('+2347012345678')).toBe('07012345678');
    expect(canonicalNigerianPhone('+2349112345678')).toBe('09112345678');
  });

  it('leaves the local form as it is', () => {
    expect(canonicalNigerianPhone('08031234567')).toBe('08031234567');
    expect(canonicalNigerianPhone('08022188797')).toBe('08022188797');
  });

  it('gives one value for the two spellings of one number', () => {
    expect(canonicalNigerianPhone('+2348031234567')).toBe(
      canonicalNigerianPhone('08031234567'),
    );
  });

  it('answers a value the validation rule and the stored-form CHECK accept', () => {
    for (const value of ['08031234567', '+2348031234567']) {
      const stored = canonicalNigerianPhone(value);

      expect(NIGERIAN_PHONE.test(stored)).toBe(true);
      expect(STORED_FORM.test(stored)).toBe(true);
    }
  });

  it('throws on a value the rule refuses, and guesses nothing', () => {
    for (const value of [
      '',
      '8031234567',
      '2348031234567',
      '0803 123 4567',
      '+44 20 7946 0958',
      '080312345678',
    ]) {
      expect(() => canonicalNigerianPhone(value)).toThrow(
        /NIGERIAN_PHONE refuses/,
      );
    }
  });
});
