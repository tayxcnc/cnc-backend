import { canonicalJson, canonicalJsonHash } from './canonical-json';

describe('canonicalJson', () => {
  it('writes equal objects the same however their keys were ordered', () => {
    expect(canonicalJson({ b: 2, a: { d: [1, 2], c: 'x' } })).toBe(
      canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 2 }),
    );
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('keeps array order, which is data', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('follows JSON.stringify for undefined, null and dates', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined])).toBe('[null]');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ at: new Date('2026-10-20T10:00:00.000Z') })).toBe(
      '{"at":"2026-10-20T10:00:00.000Z"}',
    );
  });

  it('tells a changed value apart', () => {
    expect(canonicalJson({ qty: 1 })).not.toBe(canonicalJson({ qty: 2 }));
    expect(canonicalJson({ qty: 1 })).not.toBe(canonicalJson({ qty: '1' }));
  });
});

describe('canonicalJsonHash', () => {
  it('is a SHA-256 hex digest that ignores key order', () => {
    const hash = canonicalJsonHash({ b: 1, a: 2 });

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(canonicalJsonHash({ a: 2, b: 1 }));
    expect(hash).not.toBe(canonicalJsonHash({ a: 2, b: 2 }));
  });
});
