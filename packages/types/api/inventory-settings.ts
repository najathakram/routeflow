// ─── Settings → Inventory & ordering (WS9) ──────────────────────────────────────
//
// `GET/PATCH /settings/inventory`. The one field is the tenant-level `orders.buyerOversell`
// policy: "off" refuses a buyer order past available stock, "backorder" accepts it and records
// the excess as a backorder. The API keeps its own literal copy of the mode list
// (`policy-registry.ts` BUYER_OVERSELL_MODES) and pins it to this one in a parity spec.

export const INVENTORY_BUYER_OVERSELL_MODES = ["off", "backorder"] as const;

export type InventoryBuyerOversellMode = (typeof INVENTORY_BUYER_OVERSELL_MODES)[number];

/** `orders.buyerBackorderVisibility`: "show" tells a buyer an item ships when restocked, "hide" looks in stock. */
export const INVENTORY_BACKORDER_VISIBILITY_MODES = ["show", "hide"] as const;

export type InventoryBackorderVisibility = (typeof INVENTORY_BACKORDER_VISIBILITY_MODES)[number];

export interface InventorySettings {
  buyerOversell: InventoryBuyerOversellMode;
  /** What buyers see about backordered items; only meaningful while `buyerOversell` is "backorder". */
  buyerBackorderVisibility: InventoryBackorderVisibility;
  /** Customers pinned to their own value for this setting (they ignore the tenant default). */
  customerOverrides: number;
}

/** At least one of the two settings; each is validated when present. */
export interface UpdateInventorySettingsRequest {
  buyerOversell?: InventoryBuyerOversellMode;
  buyerBackorderVisibility?: InventoryBackorderVisibility;
  /** Optional note stored on the policy row and its audit entry (max 500). */
  reason?: string;
}
