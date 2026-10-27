import type { CncConfigService } from '../config/cnc.config';
import { MessageSeal } from './message-seal';

const configWith = (jwtSecret: string) =>
  ({ jwtSecret }) as unknown as CncConfigService;

describe('MessageSeal', () => {
  const seal = new MessageSeal(configWith('a'.repeat(64)));

  it('opens what it sealed', () => {
    const value = { code: '042817', minutes: 10, name: 'Ada & Obi' };

    expect(seal.open(seal.seal(value))).toEqual(value);
  });

  it('never shows the value in the sealed text, and never seals twice alike', () => {
    const first = seal.seal({ code: '042817' });
    const second = seal.seal({ code: '042817' });

    expect(first).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(first).not.toContain('042817');
    expect(
      Buffer.from(first.split('.')[3], 'base64url').toString(),
    ).not.toContain('042817');
    expect(first).not.toBe(second);
  });

  it('refuses a payload sealed under another secret', () => {
    const other = new MessageSeal(configWith('b'.repeat(64)));

    expect(() => other.open(seal.seal({ code: '042817' }))).toThrow();
  });

  it('refuses a tampered or malformed payload', () => {
    const sealed = seal.seal({ code: '042817' });
    const [version, iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;

    expect(() =>
      seal.open([version, iv, tag, flipped.toString('base64url')].join('.')),
    ).toThrow();
    expect(() => seal.open('v2.a.b.c')).toThrow('Not a sealed payload.');
    expect(() => seal.open('{"code":"042817"}')).toThrow();
  });
});
