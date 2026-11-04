import { hasLongDash } from '../src/common/no-long-dashes';
import { withoutLongDashes } from './report-long-dashes';

describe('withoutLongDashes (the cleanCopy rule, P19)', () => {
  it('turns a dash between digits into "to"', () => {
    expect(withoutLongDashes('Serves 2–4')).toBe('Serves 2 to 4');
    expect(withoutLongDashes('07:00 — 09:00')).toBe('07:00 to 09:00');
  });

  it('turns any other dash into a comma, dropping one at either end', () => {
    expect(withoutLongDashes('Zobo — chilled')).toBe('Zobo, chilled');
    expect(withoutLongDashes('Mon–Fri')).toBe('Mon, Fri');
    expect(withoutLongDashes('— a tall glass —')).toBe('a tall glass');
  });

  it('leaves hyphens and clean text alone, and leaves no dash behind', () => {
    expect(withoutLongDashes('Walk-in 7-a-side')).toBe('Walk-in 7-a-side');

    for (const text of ['A — B – C', '1–2—3', '——', 'x —— y']) {
      expect(hasLongDash(withoutLongDashes(text))).toBe(false);
    }
  });

  it('is the same after a second run', () => {
    const once = withoutLongDashes('Rice — 2–3 people');

    expect(once).toBe('Rice, 2 to 3 people');
    expect(withoutLongDashes(once)).toBe(once);
  });
});
