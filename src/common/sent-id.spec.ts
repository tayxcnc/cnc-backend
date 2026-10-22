import { sentId } from './sent-id';

describe('sentId', () => {
  it('keeps a non-blank string as sent', () => {
    expect(sentId('abc')).toBe('abc');
    expect(sentId(' abc ')).toBe(' abc ');
  });

  it('reads anything else as not sent', () => {
    for (const value of [undefined, null, '', '   ', 7, {}, ['a']]) {
      expect(sentId(value)).toBeUndefined();
    }
  });
});
