import {
  deliveryId,
  isValidPaystackSignature,
  signPaystackBody,
} from './webhook-signature';

const KEY = 'sk_test_signature_spec';
const BODY = '{"event":"charge.success","data":{"reference":"r","amount":100}}';

describe('isValidPaystackSignature', () => {
  it('accepts the HMAC-SHA512 of the raw bytes under the key', () => {
    expect(
      isValidPaystackSignature(
        Buffer.from(BODY),
        signPaystackBody(BODY, KEY),
        KEY,
      ),
    ).toBe(true);
  });

  it('refuses another key, an altered body, a re-serialised body and junk', () => {
    const signature = signPaystackBody(BODY, KEY);
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 1);

    expect(
      isValidPaystackSignature(Buffer.from(BODY), signature, 'sk_test_other'),
    ).toBe(false);
    expect(
      isValidPaystackSignature(
        Buffer.from(BODY.replace('100', '1')),
        signature,
        KEY,
      ),
    ).toBe(false);
    expect(
      isValidPaystackSignature(Buffer.from(reserialised), signature, KEY),
    ).toBe(false);
    expect(isValidPaystackSignature(Buffer.from(BODY), 'abc', KEY)).toBe(false);
    expect(
      isValidPaystackSignature(Buffer.from(BODY), 'z'.repeat(128), KEY),
    ).toBe(false);
    expect(isValidPaystackSignature(Buffer.from(BODY), undefined, KEY)).toBe(
      false,
    );
  });

  it('refuses a missing or empty raw body', () => {
    const signature = signPaystackBody('', KEY);

    expect(isValidPaystackSignature(undefined, signature, KEY)).toBe(false);
    expect(isValidPaystackSignature(Buffer.alloc(0), signature, KEY)).toBe(
      false,
    );
  });
});

describe('deliveryId', () => {
  it('is the same for the same bytes and differs for others', () => {
    expect(deliveryId(Buffer.from(BODY))).toBe(deliveryId(Buffer.from(BODY)));
    expect(deliveryId(Buffer.from(BODY))).not.toBe(
      deliveryId(Buffer.from(`${BODY} `)),
    );
    expect(deliveryId(Buffer.from(BODY))).toMatch(/^[0-9a-f]{64}$/);
  });
});
