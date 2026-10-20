import { isSent } from './is-sent';

describe('isSent', () => {
  it('is false only for a field that was not sent', () => {
    expect(isSent({}, undefined)).toBe(false);
  });

  it('counts null and an empty value as sent, so they are validated', () => {
    expect(isSent({}, null)).toBe(true);
    expect(isSent({}, '')).toBe(true);
    expect(isSent({}, [])).toBe(true);
    expect(isSent({}, 0)).toBe(true);
    expect(isSent({}, false)).toBe(true);
  });
});
