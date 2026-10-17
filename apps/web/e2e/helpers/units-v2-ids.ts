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
  // K3 edit mode / K4 change prices / K5 save status (mirrors units-v2-testids.ts, plan-testids.ts, confirm-testids.ts)
  input: (ref: string, tier: string | number) => `units-v2-input-${ref}-${tier}`,
  btnEdit: "units-v2-btn-edit",
  btnChange: "units-v2-btn-change-open",
  editingPill: "units-v2-editing-pill",
  editbar: "units-v2-editbar",
  ebText: "units-v2-eb-text",
  ebSave: "units-v2-eb-save",
  ebError: "units-v2-eb-error",
  orderUnit: "units-v2-order-unit",
  changePanel: "units-v2-change-panel",
  changePreview: "units-v2-ch-preview",
  saveStatus: "units-v2-save-status",
  saveUndo: "units-v2-save-undo",
  staleNotice: "units-v2-stale-notice",
} as const;

/** Prefix selectors for "any row / any card / any price cell" (the refs are server ids the spec does not know). */
export const UNITS_V2_PREFIX = {
  row: "units-v2-row-",
  card: "units-v2-card-",
  cell: "units-v2-cell-",
} as const;
