import { firstFreeSlug, slugify, uniqueSlug } from './menu-slug';

describe('slugify', () => {
  it('makes the website’s slug form from a name', () => {
    expect(slugify('Zobo Spritz')).toBe('zobo-spritz');
    expect(slugify('  Jollof Rice (Party)  ')).toBe('jollof-rice-party');
    expect(slugify('Mac & Cheese')).toBe('mac-and-cheese');
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify("Chef's 3-Way Pepper Soup!")).toBe(
      'chef-s-3-way-pepper-soup',
    );
  });

  it('falls back to "item" for a name with no letters or digits', () => {
    expect(slugify('!!!')).toBe('item');
    expect(slugify('🍹')).toBe('item');
  });

  it('caps the length without leaving a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(79)} b${'c'.repeat(20)}`);

    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('firstFreeSlug', () => {
  it('takes the base when it is free, and the first free number otherwise', () => {
    expect(firstFreeSlug('chapman', new Set())).toBe('chapman');
    expect(firstFreeSlug('chapman', new Set(['chapman']))).toBe('chapman-2');
    expect(
      firstFreeSlug('chapman', new Set(['chapman', 'chapman-2', 'chapman-3'])),
    ).toBe('chapman-4');
  });

  it('never reuses a slug, even one far down the list', () => {
    expect(firstFreeSlug('chapman', new Set(['chapman', 'chapman-3']))).toBe(
      'chapman-2',
    );
  });
});

describe('uniqueSlug', () => {
  it('locks before it reads, so two creates of one name cannot both take it', async () => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: jest.fn(() => {
        calls.push('lock');
        return Promise.resolve(1);
      }),
      menuItem: {
        findMany: jest.fn(() => {
          calls.push('read');
          return Promise.resolve([{ slug: 'zobo-spritz' }]);
        }),
      },
    };

    await expect(uniqueSlug(tx as never, 'Zobo Spritz')).resolves.toBe(
      'zobo-spritz-2',
    );
    expect(calls).toEqual(['lock', 'read']);
  });
});
