/** Stable test ids for the units v2 edit grid (K3, S12a). Kept apart from S11's `units-v2-testids.ts`. */
export const EDIT_TESTIDS = {
  input: (ref: string, tier: number) => `units-v2-input-${ref}-${tier}`,
  editOpen: "units-v2-edit-open",
  changeOpen: "units-v2-change-open",
  saveBar: "units-v2-save-bar",
  save: "units-v2-save",
  cancel: "units-v2-cancel",
  orderUnit: "units-v2-order-unit",
  switchReview: "units-v2-switch-review",
  switchUndo: "units-v2-switch-undo",
  alsoSlot: "units-v2-also-update-slot",
  problems: "units-v2-edit-problems",
} as const;
