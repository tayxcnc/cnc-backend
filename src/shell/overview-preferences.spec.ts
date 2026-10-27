import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OverviewPreferencesDto } from './dto/overview-preferences.dto';
import {
  normalisePreferences,
  OVERVIEW_WIDGETS,
  presetWidgets,
  validDate,
} from './overview-preferences';

const TODAY = '2026-10-01';

describe('overview preferences (ported from overview.test.cjs)', () => {
  it('recovers a damaged saved layout without duplicate or unknown widgets', () => {
    // The demo's own case, word for word in its values.
    const prefs = normalisePreferences(
      {
        version: 1,
        period: 'Unknown',
        from: 'bad',
        widgets: [
          { id: 'sales', visible: true, wide: true },
          { id: 'sales', visible: false },
          { id: 'unknown', visible: true },
        ],
      },
      TODAY,
    );

    expect(prefs.period).toBe('Today');
    expect(prefs.from).toBe(TODAY);
    expect(new Set(prefs.widgets.map((w) => w.id)).size).toBe(
      prefs.widgets.length,
    );
    expect(prefs.widgets.filter((w) => w.visible)).toEqual([
      { id: 'sales', visible: true, wide: true },
    ]);
    expect(
      normalisePreferences({ version: 1, widgets: [] }, TODAY).widgets.some(
        (w) => w.visible,
      ),
    ).toBe(true);
  });

  it('answers the Service preset for today when nothing usable is stored', () => {
    const defaults = {
      version: 1,
      widgets: presetWidgets('Service'),
      period: 'Today',
      from: TODAY,
      to: TODAY,
    };

    for (const raw of [null, undefined, 'x', { version: 2, widgets: [] }]) {
      expect(normalisePreferences(raw, TODAY)).toEqual(defaults);
    }
  });

  it('keeps every widget once, adding the missing ones hidden', () => {
    const prefs = normalisePreferences(
      {
        version: 1,
        widgets: [{ id: 'trend', visible: true, wide: true }],
        period: 'Custom',
        from: '2026-09-01',
        to: '2026-09-30',
      },
      TODAY,
    );

    expect(prefs.widgets.map((w) => w.id)).toHaveLength(
      OVERVIEW_WIDGETS.length,
    );
    expect(prefs.widgets[0]).toEqual({
      id: 'trend',
      visible: true,
      wide: true,
    });
    expect(prefs.widgets.slice(1).every((w) => !w.visible)).toBe(true);
    expect([prefs.period, prefs.from, prefs.to]).toEqual([
      'Custom',
      '2026-09-01',
      '2026-09-30',
    ]);
  });

  it('builds the presets as the demo does', () => {
    const service = presetWidgets('Service');

    expect(service.filter((w) => w.visible).map((w) => w.id)).toEqual([
      'sales',
      'outstanding',
      'occupancy',
      'arrivals',
      'service',
      'attention',
      'orders',
      'nextArrivals',
    ]);
    expect(service.filter((w) => w.wide).map((w) => w.id)).toEqual(['trend']);
    expect(
      presetWidgets('Performance')
        .filter((w) => w.wide)
        .map((w) => w.id)
        .sort(),
    ).toEqual(['arrivals', 'occupancy', 'outstanding', 'sales', 'trend']);
  });

  it('accepts real dates only (the demo’s validDate)', () => {
    expect(validDate('2026-02-30')).toBe(false);
    expect(validDate('2028-02-29')).toBe(true);
    expect(validDate('2026-1-01')).toBe(false);
    expect(validDate(20261001)).toBe(false);
  });
});

describe('OverviewPreferencesDto', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    widgets: [{ id: 'sales', visible: true, wide: false }],
    period: 'Today',
    from: TODAY,
    to: TODAY,
    ...overrides,
  });

  const messages = async (raw: unknown) =>
    (
      await validate(plainToInstance(OverviewPreferencesDto, raw), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).flatMap((error) => [
      ...Object.values(error.constraints ?? {}),
      ...(error.children ?? []).flatMap((child) =>
        (child.children ?? []).flatMap((leaf) =>
          Object.values(leaf.constraints ?? {}),
        ),
      ),
    ]);

  it('accepts a layout in the staff app’s shape', async () => {
    expect(await messages(body())).toEqual([]);
  });

  it('refuses an unknown widget, a repeated one, and a layout showing nothing', async () => {
    expect(
      await messages(
        body({ widgets: [{ id: 'x', visible: true, wide: false }] }),
      ),
    ).toContain('Choose a known overview widget.');
    expect(
      await messages(
        body({
          widgets: [
            { id: 'sales', visible: true, wide: false },
            { id: 'sales', visible: true, wide: false },
          ],
        }),
      ),
    ).toContain('Name each widget at most once, and show at least one.');
    expect(
      await messages(
        body({ widgets: [{ id: 'sales', visible: false, wide: false }] }),
      ),
    ).toContain('Name each widget at most once, and show at least one.');
  });

  it('refuses an unknown period, a date that does not exist, and version 2', async () => {
    expect(await messages(body({ period: 'Yesterday' }))).toContain(
      'Choose a known period.',
    );
    expect(await messages(body({ from: '2026-02-30' }))).toContain(
      'from and to must be real dates in YYYY-MM-DD form.',
    );
    expect(await messages(body({ version: 2 }))).toContain(
      'version must be 1.',
    );
  });
});
