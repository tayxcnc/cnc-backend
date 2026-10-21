import {
  LINES_DUPLICATE_MESSAGE,
  LINES_EMPTY_MESSAGE,
  LINES_QTY_MESSAGE,
  lineProblem,
  POSITIVE_STOCK_LINES,
  type LineRules,
} from './command-lines';
import { INT4_MAX } from '../prisma/int4';

const RULES: LineRules = {
  ...POSITIVE_STOCK_LINES,
  idMessage: 'Choose a kitchen portion.',
};

describe('lineProblem (the demo positiveLines)', () => {
  it('accepts whole quantities above zero for distinct items', () => {
    expect(
      lineProblem(
        [
          { stockItemId: 'a', qty: 1 },
          { stockItemId: 'b', qty: 3 },
        ],
        RULES,
      ),
    ).toBeNull();
  });

  it.each([[undefined], [null], ['x'], [[]]])(
    'refuses %p as no items',
    (value) => {
      expect(lineProblem(value, RULES)).toBe(LINES_EMPTY_MESSAGE);
    },
  );

  it('allows an empty list when the command decides', () => {
    expect(lineProblem([], { ...RULES, allowEmpty: true })).toBeNull();
  });

  it('refuses the same item twice before looking at quantities', () => {
    expect(
      lineProblem(
        [
          { stockItemId: 'a', qty: 0 },
          { stockItemId: 'a', qty: 1 },
        ],
        RULES,
      ),
    ).toBe(LINES_DUPLICATE_MESSAGE);
  });

  it.each([[0], [1.5], [-1], ['2'], [INT4_MAX + 1], [undefined]])(
    'refuses a quantity of %p',
    (qty) => {
      expect(lineProblem([{ stockItemId: 'a', qty }], RULES)).toBe(
        LINES_QTY_MESSAGE,
      );
    },
  );

  it('refuses a missing item id with the command sentence', () => {
    expect(lineProblem([{ qty: 1 }], RULES)).toBe('Choose a kitchen portion.');
    expect(lineProblem([{ stockItemId: ' ', qty: 1 }], RULES)).toBe(
      'Choose a kitchen portion.',
    );
  });

  it('allows zero when the rules count from zero', () => {
    expect(
      lineProblem([{ stockItemId: 'a', counted: 0 }], {
        ...RULES,
        qtyKey: 'counted',
        minQty: 0,
      }),
    ).toBeNull();
  });
});
