import { normaliseEmail } from './normalise-email';

describe('normaliseEmail', () => {
  it('trims and lower-cases an address', () => {
    expect(normaliseEmail('  Ada.Okafor@CNC.Example ')).toBe(
      'ada.okafor@cnc.example',
    );
  });

  it('passes anything that is not a string through untouched', () => {
    expect(normaliseEmail(42)).toBe(42);
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail(undefined)).toBeUndefined();
  });
});
