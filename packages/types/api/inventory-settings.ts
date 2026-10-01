// ─── Settings → Inventory & ordering (WS9) ──────────────────────────────────────
//
// `GET/PATCH /settings/inventory`. The one field is the tenant-level `orders.buyerOversell`
// policy: "off" refuses a buyer order past available stock, "backorder" accepts it and records
// the excess as a backorder. The API keeps its own literal copy of the mode list
// (`policy-registry.ts` BUYER_OVERSELL_MODES) and pins it to this one in a parity spec.

export const INVENTORY_BUYER_OVERSELL_MODES = ["off", "backorder"] as const;

export type InventoryBuyerOversellMode = (typeof INVENTORY_BUYER_OVERSELL_MODES)[number];

export interface InventorySettings {
  buyerOversell: InventoryBuyerOversellMode;
  /** Customers pinned to their own value for this setting (they ignore the tenant default). */
  customerOverrides: number;
}

export interface UpdateInventorySettingsRequest {
  buyerOversell: InventoryBuyerOversellMode;
  /** Optional note stored on the policy row and its audit entry (max 500). */
  reason?: string;
}
