import { canonicalNigerianPhone, NIGERIAN_PHONE } from './nigerian-phone';

describe('canonicalNigerianPhone', () => {
  it('writes the local form as +234', () => {
    expect(canonicalNigerianPhone('08031234567')).toBe('+2348031234567');
    expect(canonicalNigerianPhone('07012345678')).toBe('+2347012345678');
    expect(canonicalNigerianPhone('09112345678')).toBe('+2349112345678');
  });

  it('leaves the +234 form as it is', () => {
    expect(canonicalNigerianPhone('+2348031234567')).toBe('+2348031234567');
  });

  it('gives one value for the two spellings of one number', () => {
    expect(canonicalNigerianPhone('08031234567')).toBe(
      canonicalNigerianPhone('+2348031234567'),
    );
  });

  it('answers a value the validation rule still accepts', () => {
    expect(NIGERIAN_PHONE.test(canonicalNigerianPhone('08031234567'))).toBe(
      true,
    );
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
