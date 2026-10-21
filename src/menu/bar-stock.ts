/**
 * The paired Bar stock item's fixed shape (`staff/lib/domain.ts`: `seed`
 * and `menu.save`): every Bar menu item has exactly one Bar `StockItem`,
 * named as the item, counted in servings and bought in batches of twelve,
 * with a reorder level of twelve.
 *
 * One home for the shape, because two writers create these items: the data
 * seed (`prisma/menu-seed.ts`, the 87 seeded drinks) and `menu.save` (every
 * Bar item the Owner adds in the app). Two copies of four numbers would
 * drift, and a drink added in the app would then be stocked differently from
 * one seeded beside it.
 */
export const BAR_STOCK_SHAPE = {
  unit: 'serving',
  pack: 'batch',
  factor: 12,
  minimum: 12,
} as const;
