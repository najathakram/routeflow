/**
 * data-testid strings for the Units v2 product-page grid.
 *
 * MUST EQUAL `apps/web/app/(dashboard)/products/[id]/units-v2-testids.ts` (the feature file, which is not on master
 * yet). The train that lands the feature swaps this file for a direct import of those ids if the path resolves;
 * until then this mirror is the only place the e2e specs name them.
 */
export const UNITS_V2_IDS = {
  grid: "units-v2-grid",
  headerStockLink: "units-v2-header-stock-link",
  familyHeader: "units-v2-family-header",
  row: (ref: string) => `units-v2-row-${ref}`,
  cell: (ref: string, tier: string | number) => `units-v2-cell-${ref}-${tier}`,
  code: (ref: string) => `units-v2-code-${ref}`,
  card: (ref: string) => `units-v2-card-${ref}`,
} as const;

/** Prefix selectors for "any row / any card / any price cell" (the refs are server ids the spec does not know). */
export const UNITS_V2_PREFIX = {
  row: "units-v2-row-",
  card: "units-v2-card-",
  cell: "units-v2-cell-",
} as const;
