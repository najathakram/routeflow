/** Stable test ids for the units v2 prices grid and its page-level seams. */
export const UNITS_V2_TESTIDS = {
  grid: "units-v2-grid",
  row: (ref: string) => `units-v2-row-${ref}`,
  cell: (ref: string, tier: number) => `units-v2-cell-${ref}-${tier}`,
  code: (ref: string) => `units-v2-code-${ref}`,
  headerStockLink: "units-v2-header-stock-link",
  familyHeader: "units-v2-family-header",
} as const;
