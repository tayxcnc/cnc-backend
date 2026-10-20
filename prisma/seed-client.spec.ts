import { createSeedClient } from './seed-client';

/**
 * The factory's one rule: no URL is an error at the top of the run. No
 * database — the refusal comes before any client is built.
 */
describe('createSeedClient', () => {
  const saved = process.env.CNC_DB_URL;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CNC_DB_URL;
    } else {
      process.env.CNC_DB_URL = saved;
    }
  });

  it('refuses to start when CNC_DB_URL is unset', () => {
    delete process.env.CNC_DB_URL;

    expect(() => createSeedClient()).toThrow(/CNC_DB_URL is not set/);
  });

  it('refuses to start when CNC_DB_URL is empty', () => {
    process.env.CNC_DB_URL = '';

    expect(() => createSeedClient()).toThrow(/CNC_DB_URL is not set/);
  });
});
