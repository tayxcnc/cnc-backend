import { isReservedMailDomain } from './reserved-mail-domains';

describe('isReservedMailDomain', () => {
  it.each([
    'load-guest-1@example.com',
    'someone@EXAMPLE.ORG',
    'a@example.net.',
    'a@mail.example.com',
    'ngozi@cnc.test',
    'a@site.example',
    'a@nowhere.invalid',
    'a@localhost',
  ])('%s is reserved', (address) => {
    expect(isReservedMailDomain(address)).toBe(true);
  });

  it.each([
    'guest@gmail.com',
    'a@notexample.com',
    'a@example.com.ng',
    'a@testing.ng',
    'no-at-sign',
  ])('%s is not', (address) => {
    expect(isReservedMailDomain(address)).toBe(false);
  });
});
