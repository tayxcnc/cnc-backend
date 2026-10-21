import { ISO_DATE, parseIsoDate } from '../common/calendar-date';

/**
 * The manager overview's layout: the staff app's `lib/overview.ts`
 * (`WIDGETS`, `PRESETS`, `presetWidgets`, `normalisePreferences`,
 * `validDate`), on the server, so a person's layout follows them from one
 * device to the next instead of living in one browser's `localStorage`.
 */

/** The fourteen widgets, in the demo's order (plan §10). */
export const OVERVIEW_WIDGETS = [
  'sales',
  'outstanding',
  'occupancy',
  'arrivals',
  'trend',
  'departments',
  'payments',
  'bestsellers',
  'service',
  'attention',
  'orders',
  'nextArrivals',
  'stock',
  'tasks',
] as const;

export type OverviewWidgetId = (typeof OVERVIEW_WIDGETS)[number];

/** The demo's widget kinds, which decide the presets' default width. */
const WIDGET_KINDS: Readonly<
  Record<OverviewWidgetId, 'stat' | 'chart' | 'panel'>
> = {
  sales: 'stat',
  outstanding: 'stat',
  occupancy: 'stat',
  arrivals: 'stat',
  trend: 'chart',
  departments: 'chart',
  payments: 'chart',
  bestsellers: 'chart',
  service: 'panel',
  attention: 'panel',
  orders: 'panel',
  nextArrivals: 'panel',
  stock: 'panel',
  tasks: 'panel',
};

/** The period choices, as the screen labels them. */
export const OVERVIEW_PERIODS = [
  'Today',
  'This Week',
  'This Month',
  'Custom',
] as const;

export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];

/** The three presets (`overview.ts`, `PRESETS`). */
export const OVERVIEW_PRESETS = {
  Service: [
    'sales',
    'outstanding',
    'occupancy',
    'arrivals',
    'service',
    'attention',
    'orders',
    'nextArrivals',
  ],
  Performance: [
    'sales',
    'outstanding',
    'trend',
    'departments',
    'payments',
    'bestsellers',
  ],
  Control: [
    'outstanding',
    'occupancy',
    'attention',
    'stock',
    'tasks',
    'orders',
  ],
} as const satisfies Record<string, readonly OverviewWidgetId[]>;

export type OverviewPreset = keyof typeof OVERVIEW_PRESETS;

export interface OverviewWidgetPreference {
  id: OverviewWidgetId;
  visible: boolean;
  wide: boolean;
}

/**
 * The stored layout, in the demo's shape. `version` is the layout format's
 * version (always 1), not the record version of plan A8: the shape is the
 * staff app's own, so its adapter only swaps `localStorage` for the API.
 */
export interface OverviewPreferences {
  version: 1;
  widgets: OverviewWidgetPreference[];
  period: OverviewPeriod;
  from: string;
  to: string;
}

/** The demo's `validDate`: `YYYY-MM-DD` naming a day that exists. */
export function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE.test(value) &&
    parseIsoDate(value) !== null
  );
}

/** The demo's `presetWidgets(name)`: the preset's widgets first, shown. */
export function presetWidgets(
  name: OverviewPreset,
): OverviewWidgetPreference[] {
  const ids: readonly OverviewWidgetId[] = OVERVIEW_PRESETS[name];
  const order = [...ids, ...OVERVIEW_WIDGETS.filter((id) => !ids.includes(id))];

  return order.map((id) => ({
    id,
    visible: ids.includes(id),
    wide: id === 'trend' || (name !== 'Service' && WIDGET_KINDS[id] === 'stat'),
  }));
}

/**
 * The demo's `normalisePreferences(raw, today)`: a stored or sent layout
 * made whole. Unknown and repeated widgets are dropped, missing ones are
 * added hidden, a bad period or date falls back, and a layout that shows
 * nothing, or is not version 1, becomes the Service preset for today.
 */
export function normalisePreferences(
  raw: unknown,
  today: string,
): OverviewPreferences {
  const defaults: OverviewPreferences = {
    version: 1,
    widgets: presetWidgets('Service'),
    period: 'Today',
    from: today,
    to: today,
  };

  const value = raw as Partial<OverviewPreferences> | null | undefined;

  if (
    typeof value !== 'object' ||
    value === null ||
    value.version !== 1 ||
    !Array.isArray(value.widgets)
  ) {
    return defaults;
  }

  const seen = new Set<string>();
  const widgets: OverviewWidgetPreference[] = [];

  for (const item of value.widgets as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;

    const candidate = item as Partial<OverviewWidgetPreference>;
    const id = candidate.id;

    if (
      typeof id !== 'string' ||
      seen.has(id) ||
      !(OVERVIEW_WIDGETS as readonly string[]).includes(id)
    ) {
      continue;
    }

    seen.add(id);
    widgets.push({
      id,
      visible: !!candidate.visible,
      wide: !!candidate.wide,
    });
  }

  for (const item of defaults.widgets) {
    if (!seen.has(item.id)) widgets.push({ ...item, visible: false });
  }

  if (!widgets.some((widget) => widget.visible)) return defaults;

  return {
    ...defaults,
    widgets,
    period: (OVERVIEW_PERIODS as readonly string[]).includes(
      value.period as string,
    )
      ? (value.period as OverviewPeriod)
      : defaults.period,
    from: validDate(value.from) ? value.from : today,
    to: validDate(value.to) ? value.to : today,
  };
}
